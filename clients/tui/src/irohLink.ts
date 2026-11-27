// The protocol 3.0 carrier: peer-to-peer QUIC over iroh, dialled by ticket.
//
// A connection's first bidirectional stream is the control stream: newline-delimited JSON, one
// compact object per line, in both directions. The server never pings — the client does
// (`connection.ts`). What the lines mean is the protocol `Session`'s business.
//
// Every further bidirectional stream is one operation of the byte channel (`docs/protocol.md` §11,
// shapes and limits in `loreweaver-protocol/v3` `bytes.ts`): a GET of a file by its content
// hash, or the PUT of an upload the control stream's `media.offer` accepted. `byteGet` and
// `bytePut` speak one such stream; every read is bounded — the header by the protocol's header
// limit, a body by the size its header declared — and a server that sends more is an error.
import {
  BYTE_STALL_MS,
  decodeByteReply,
  encodeByteLine,
  HeaderReader,
  isContentHash,
  MAX_BYTE_HEADER_BYTES,
  MAX_BYTE_STREAMS,
  PROTOCOL_MAJOR,
  type ByteFile,
  type ClientFrame,
} from "loreweaver-protocol/v3"
import { createHash } from "node:crypto"

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
  /** Tell the peer to stop sending (a byte stream given up on). */
  stop?(errorCode: bigint): Promise<void>
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

/** A file fetched over the byte channel: what the server said about it, and exactly its bytes. */
export interface FetchedFile extends ByteFile {
  readonly bytes: Uint8Array
}

/** What a dialled connection offers its owner. */
export interface Transport {
  /** One frame, written as one line; writes are serialised so lines never interleave. */
  send(frame: ClientFrame): void
  /** Start reading: `onValue` once per parsed line, `onEnd` once when the stream ends or breaks. */
  start(onValue: (value: unknown) => void, onEnd: (reason: string) => void): void
  /** Close the connection and its endpoint. `onEnd` is NOT called for a close asked for here. */
  close(): void
  /** GET a file by its content hash on a byte stream of its own. Rejects with a `ByteError`. */
  fetch(hash: string): Promise<FetchedFile>
  /** PUT the bytes of an accepted offer; resolves with the server's receipt. Rejects with a `ByteError`. */
  put(uploadId: string, bytes: Uint8Array, onProgress?: (sent: number) => void): Promise<ByteFile>
}

// --- the byte channel ------------------------------------------------------------------------

/** The most asked of one read, and the most written in one write. */
export const BYTE_CHUNK = 64 * 1024
/**
 * The largest body this client accepts from a GET, whatever the header declares: the largest file
 * the server stores (an audio file). A header promising more is refused before anything is kept.
 */
export const MAX_FETCH_BYTES = 128 * 1024 * 1024

/**
 * A byte-stream operation that failed. `server`: the code and message came from the server's
 * error line (the message is already in the member's language); otherwise the code is this
 * client's — `bad_reply`, `too_large`, `too_much`, `hash_mismatch`, `stalled`, `stream_ended`,
 * `not_connected`, `bad_hash` — and the UI words it.
 */
export class ByteError extends Error {
  readonly code: string
  readonly server: boolean

  constructor(code: string, message = "", server = false) {
    super(message || code)
    this.name = "ByteError"
    this.code = code
    this.server = server
  }
}

/** One bidirectional stream as the byte channel uses it. */
export interface ByteStreamLike {
  send: IrohSendStreamLike
  recv: IrohRecvStreamLike
}

export interface ByteOptions {
  /** How long one read may wait for anything (default the protocol's `BYTE_STALL_MS`). */
  stallMs?: number
  /** The largest GET body accepted (default `MAX_FETCH_BYTES`). */
  maxBytes?: number
}

const STALLED = Symbol("stalled")

/** One read, given up on as `stalled` when nothing arrives in time; null at the end of the stream. */
async function readChunk(recv: IrohRecvStreamLike, max: number, stallMs: number): Promise<Uint8Array | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<typeof STALLED>((resolve) => {
    timer = setTimeout(() => resolve(STALLED), stallMs)
  })
  try {
    const chunk = await Promise.race([recv.read(max), stalled])
    if (chunk === STALLED) throw new ByteError("stalled")
    if (!chunk || chunk.length === 0) return null
    if (chunk.length > max) throw new ByteError("too_much")
    return Uint8Array.from(chunk)
  } catch (error) {
    if (error instanceof ByteError) throw error
    // A reset stream reads as its end: what was missing is said by the caller.
    return null
  } finally {
    clearTimeout(timer)
  }
}

function stopQuietly(recv: IrohRecvStreamLike): void {
  try {
    void recv.stop?.(0n).catch(() => {})
  } catch {
    // already gone
  }
}

/** The one reply header of a stream, and whatever body bytes came with it. */
async function readHeader(recv: IrohRecvStreamLike, op: "get" | "put", stallMs: number): Promise<{ file: ByteFile; rest: Uint8Array }> {
  const reader = new HeaderReader(MAX_BYTE_HEADER_BYTES)
  for (;;) {
    const chunk = await readChunk(recv, BYTE_CHUNK, stallMs)
    if (chunk === null) throw new ByteError("stream_ended")
    const step = reader.push(chunk)
    if (step.state === "too_long") throw new ByteError("bad_reply")
    if (step.state === "more") continue
    const reply = decodeByteReply(step.value)
    if (reply === null) throw new ByteError("bad_reply")
    if (!reply.ok) throw new ByteError(reply.code, reply.message, true)
    if (reply.op !== op) throw new ByteError("bad_reply")
    return { file: { hash: reply.hash, size: reply.size, mime: reply.mime, name: reply.name }, rest: step.rest }
  }
}

/** The stream must end here: one byte more than promised is a fault. */
async function expectEnd(recv: IrohRecvStreamLike, stallMs: number): Promise<void> {
  if ((await readChunk(recv, 1, stallMs)) !== null) throw new ByteError("too_much")
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** GET `hash` on `stream`: the header, then exactly the declared bytes, checked against the hash. */
export async function byteGet(stream: ByteStreamLike, hash: string, options: ByteOptions = {}): Promise<FetchedFile> {
  if (!isContentHash(hash)) throw new ByteError("bad_hash")
  const stallMs = options.stallMs ?? BYTE_STALL_MS
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES
  try {
    await stream.send.writeAll(Array.from(encodeByteLine({ op: "get", hash })))
    await stream.send.finish?.()
    const { file, rest } = await readHeader(stream.recv, "get", stallMs)
    if (file.hash !== hash) throw new ByteError("bad_reply")
    if (file.size > maxBytes) throw new ByteError("too_large")
    if (rest.length > file.size) throw new ByteError("too_much")
    const body = new Uint8Array(file.size)
    body.set(rest)
    let filled = rest.length
    while (filled < file.size) {
      const chunk = await readChunk(stream.recv, Math.min(BYTE_CHUNK, file.size - filled), stallMs)
      if (chunk === null) throw new ByteError("stream_ended")
      body.set(chunk, filled)
      filled += chunk.length
    }
    await expectEnd(stream.recv, stallMs)
    if (sha256Hex(body) !== hash) throw new ByteError("hash_mismatch")
    return { ...file, bytes: body }
  } catch (error) {
    stopQuietly(stream.recv)
    throw error instanceof ByteError ? error : new ByteError("stream_ended", error instanceof Error ? error.message : String(error))
  }
}

/**
 * PUT the bytes of an accepted offer on `stream`: the header line, exactly `bytes` in chunks,
 * the end of the client's side; then the one reply line. When the server refuses part-way (it
 * stops reading), its error line is what the caller gets.
 */
export async function bytePut(stream: ByteStreamLike, uploadId: string, bytes: Uint8Array, options: ByteOptions & { onProgress?: (sent: number) => void } = {}): Promise<ByteFile> {
  const stallMs = options.stallMs ?? BYTE_STALL_MS
  let writeFailed: unknown = null
  try {
    await stream.send.writeAll(Array.from(encodeByteLine({ op: "put", upload_id: uploadId })))
    for (let at = 0; at < bytes.length; at += BYTE_CHUNK) {
      const end = Math.min(bytes.length, at + BYTE_CHUNK)
      await stream.send.writeAll(Array.from(bytes.subarray(at, end)))
      options.onProgress?.(end)
    }
    await stream.send.finish?.()
  } catch (error) {
    writeFailed = error
  }
  try {
    const { file, rest } = await readHeader(stream.recv, "put", stallMs)
    if (writeFailed !== null) throw new ByteError("stream_ended")
    if (rest.length > 0) throw new ByteError("too_much")
    await expectEnd(stream.recv, stallMs)
    return file
  } catch (error) {
    stopQuietly(stream.recv)
    throw error instanceof ByteError ? error : new ByteError("stream_ended", error instanceof Error ? error.message : String(error))
  }
}

/** At most `limit` operations at once; the rest wait their turn in order. */
export class StreamGate {
  readonly #limit: number
  #open = 0
  readonly #waiting: (() => void)[] = []

  constructor(limit: number = MAX_BYTE_STREAMS) {
    this.#limit = limit
  }

  get open(): number {
    return this.#open
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    // A finishing operation hands its slot straight to the next waiter, so nobody slips past.
    if (this.#open >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve))
    else this.#open += 1
    try {
      return await operation()
    } finally {
      const next = this.#waiting.shift()
      if (next) next()
      else this.#open -= 1
    }
  }
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
  readonly #gate = new StreamGate(MAX_BYTE_STREAMS)
  readonly #byteOptions: ByteOptions

  constructor(endpoint: IrohEndpointLike | undefined, connection: IrohConnectionLike, send: IrohSendStreamLike, recv: IrohRecvStreamLike, byteOptions: ByteOptions = {}) {
    this.#endpoint = endpoint
    this.#connection = connection
    this.#send = send
    this.#recv = recv
    this.#byteOptions = byteOptions
  }

  /** A fresh byte stream of this connection, opened only once a slot is free. */
  #withStream<T>(use: (stream: ByteStreamLike) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => {
      const connection = this.#connection
      if (this.#closed || connection === undefined) throw new ByteError("not_connected")
      let stream: ByteStreamLike
      try {
        stream = await connection.openBi()
      } catch (error) {
        throw new ByteError("not_connected", error instanceof Error ? error.message : String(error))
      }
      return use(stream)
    })
  }

  fetch(hash: string): Promise<FetchedFile> {
    if (!isContentHash(hash)) return Promise.reject(new ByteError("bad_hash"))
    return this.#withStream((stream) => byteGet(stream, hash, this.#byteOptions))
  }

  put(uploadId: string, bytes: Uint8Array, onProgress?: (sent: number) => void): Promise<ByteFile> {
    return this.#withStream((stream) => bytePut(stream, uploadId, bytes, { ...this.#byteOptions, ...(onProgress ? { onProgress } : {}) }))
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
