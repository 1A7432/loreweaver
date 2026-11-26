// The protocol 3.0 carrier: peer-to-peer QUIC over iroh, dialled by ticket.
//
// One connection carries ONE bidirectional stream: the control stream, newline-delimited JSON,
// one compact object per line, in both directions. The server never pings — the client does
// (`connection.ts`). There are no media streams yet: the byte channel is not built on the server.
// This file only moves lines; what they mean is the protocol `Session`'s business.
import { PROTOCOL_MAJOR, type ClientFrame } from "loreweaver-protocol/v3"

/** The ALPN carries the protocol major: a 2.x server refuses the connection instead of misreading it. */
export const ALPN = `loreweaver/${PROTOCOL_MAJOR}`
const NEWLINE = 10
const READ_CHUNK = 64 * 1024
/** How long a close waits for queued lines before hanging up anyway. */
const CLOSE_DRAIN_MS = 2_000
/** A line longer than this is not a frame anyone sends: the connection is dropped instead of buffering it. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024

const encoder = new TextEncoder()
const bytes = (text: string): number[] => Array.from(encoder.encode(text))

// The structural subset of `@number0/iroh` this file uses. Loose on purpose, so a test can hand
// in a plain-object double without loading the native module.
export interface IrohRecvStreamLike {
  read(sizeLimit: number): Promise<number[] | null>
}
export interface IrohSendStreamLike {
  writeAll(buf: number[]): Promise<void>
  finish?(): Promise<void>
}
export interface IrohConnectionLike {
  openBi(): Promise<{ send: IrohSendStreamLike; recv: IrohRecvStreamLike }>
  close?(errorCode: bigint, reason: number[]): void
}
export interface IrohEndpointLike {
  online(): Promise<void>
  connect(addr: unknown, alpn: number[]): Promise<IrohConnectionLike>
  close?(): unknown
}
export interface IrohEndpointBuilderLike {
  bind(): Promise<IrohEndpointLike>
  bindAddr?(addr: string): void
  relayMode?(mode: unknown): void
}
export interface IrohModuleLike {
  Endpoint: { builder(): IrohEndpointBuilderLike }
  presetN0(builder: IrohEndpointBuilderLike): void
  presetMinimal?(builder: IrohEndpointBuilderLike): void
  RelayMode?: { disabled(): unknown }
  EndpointTicket: { fromString(ticket: string): { endpointAddr(): unknown } }
}

export type LoadIroh = () => Promise<IrohModuleLike>

// Imported lazily: nothing native is loaded until a ticket is actually dialled.
export const defaultLoadIroh: LoadIroh = () => import("@number0/iroh") as unknown as Promise<IrohModuleLike>

/**
 * `n0`: the public relays — what a remote ticket needs. `local`: loopback only, no relay — for a
 * server this client started itself with `serve --local` (works with no network at all) and for tests.
 */
export type IrohMode = "n0" | "local"

/** What a dialled connection offers its owner. */
export interface Transport {
  /** One frame, written as one line; writes are serialised so lines never interleave. */
  send(frame: ClientFrame): void
  /** Start reading: `onValue` once per parsed line, `onEnd` once when the stream ends or breaks. */
  start(onValue: (value: unknown) => void, onEnd: (reason: string) => void): void
  /** Close the connection and its endpoint. `onEnd` is NOT called for a close asked for here. */
  close(): void
}

export type Dialer = (ticket: string) => Promise<Transport>

/** An iroh ticket: base32, starting `endpoint`. Only the shape is checked; the dial decides the rest. */
export function looksLikeTicket(value: string): boolean {
  return /^endpoint[a-z0-9]{20,}$/.test(value.trim())
}

function closeQuietly(endpoint: IrohEndpointLike | undefined): void {
  try {
    const closing = endpoint?.close?.()
    if (closing && typeof (closing as Promise<unknown>).catch === "function") void (closing as Promise<unknown>).catch(() => {})
  } catch {
    // already gone
  }
}

async function bindEndpoint(iroh: IrohModuleLike, mode: IrohMode): Promise<IrohEndpointLike> {
  const builder = iroh.Endpoint.builder()
  if (mode === "local" && iroh.presetMinimal && iroh.RelayMode && builder.bindAddr && builder.relayMode) {
    iroh.presetMinimal(builder)
    builder.relayMode(iroh.RelayMode.disabled())
    builder.bindAddr("127.0.0.1:0")
    return builder.bind()
  }
  iroh.presetN0(builder)
  const endpoint = await builder.bind()
  await endpoint.online()
  return endpoint
}

export interface DialOptions {
  mode?: IrohMode
  loadIroh?: LoadIroh
}

/** Dial `ticket` and open the control stream. Rejects when the peer cannot be reached. */
export async function dialIroh(ticket: string, options: DialOptions = {}): Promise<Transport> {
  const iroh = await (options.loadIroh ?? defaultLoadIroh)()
  const endpoint = await bindEndpoint(iroh, options.mode ?? "n0")
  try {
    const addr = iroh.EndpointTicket.fromString(ticket.trim()).endpointAddr()
    const connection = await endpoint.connect(addr, bytes(ALPN))
    const stream = await connection.openBi()
    return new ControlStream(endpoint, connection, stream.send, stream.recv)
  } catch (error) {
    closeQuietly(endpoint)
    throw error
  }
}

/** A dialler bound to one mode. */
export function irohDialer(options: DialOptions = {}): Dialer {
  return (ticket) => dialIroh(ticket, options)
}

/** The control stream of one connection. Each instance starts a fresh write chain. */
export class ControlStream implements Transport {
  #endpoint: IrohEndpointLike | undefined
  #connection: IrohConnectionLike | undefined
  #send: IrohSendStreamLike | undefined
  readonly #recv: IrohRecvStreamLike
  #writes: Promise<void> = Promise.resolve()
  #closed = false
  #started = false

  constructor(endpoint: IrohEndpointLike | undefined, connection: IrohConnectionLike, send: IrohSendStreamLike, recv: IrohRecvStreamLike) {
    this.#endpoint = endpoint
    this.#connection = connection
    this.#send = send
    this.#recv = recv
  }

  send(frame: ClientFrame): void {
    const send = this.#send
    if (this.#closed || send === undefined) return
    const line = bytes(`${JSON.stringify(frame)}\n`)
    // A line queued before `close()` still goes out: close waits for the queue, then hangs up.
    // A failed write leaves the chain usable for the next line (the read side notices a dead link).
    this.#writes = this.#writes.then(() => send.writeAll(line)).catch(() => {})
  }

  start(onValue: (value: unknown) => void, onEnd: (reason: string) => void): void {
    if (this.#started || this.#closed) return
    this.#started = true
    void this.#read(onValue, onEnd)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const send = this.#send
    const connection = this.#connection
    const endpoint = this.#endpoint
    this.#send = undefined
    this.#connection = undefined
    this.#endpoint = undefined
    // Let queued lines go out, then hang up — but never wait on a write stuck on a dead link.
    let timer: ReturnType<typeof setTimeout> | undefined
    const drained = Promise.race([
      this.#writes.then(() => send?.finish?.()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_DRAIN_MS)
      }),
    ])
    void drained
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        try {
          connection?.close?.(0n, bytes("bye"))
        } catch {
          // already gone
        }
        closeQuietly(endpoint)
      })
  }

  async #read(onValue: (value: unknown) => void, onEnd: (reason: string) => void): Promise<void> {
    const decoder = new TextDecoder("utf-8")
    let pending: Uint8Array = new Uint8Array(0)
    let reason = "stream ended"
    try {
      while (!this.#closed) {
        const chunk = await this.#recv.read(READ_CHUNK)
        if (!chunk || chunk.length === 0) break
        pending = concat(pending, Uint8Array.from(chunk))
        let newline: number
        while ((newline = pending.indexOf(NEWLINE)) >= 0) {
          const line = decoder.decode(pending.subarray(0, newline))
          pending = pending.subarray(newline + 1)
          if (this.#closed) return
          deliver(line, onValue)
        }
        if (pending.length > MAX_LINE_BYTES) {
          reason = "line too long"
          break
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
    if (this.#closed) return
    this.close()
    onEnd(reason)
  }
}

function deliver(line: string, onValue: (value: unknown) => void): void {
  if (line.trim().length === 0) return
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    // An unreadable line is dropped; the protocol decoder is the judge of everything else.
    return
  }
  onValue(value)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
