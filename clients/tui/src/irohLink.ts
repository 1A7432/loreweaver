import {
  FrameType,
  isPingFrame,
  isServerFrame,
  type ClientFrame,
  type ClientInfo,
  type MediaFrame,
  type MediaPayload,
  type MediaUpload,
  type ServerFrame,
} from "loreweaver-protocol"

// The ALPN + newline framing MUST match net/iroh_server.py. A QUIC bidi stream is a raw byte
// stream (no message boundaries), so every frame is one compact JSON object + "\n".
const ALPN = "loreweaver/tui/1"
const NEWLINE = 10
const enc = new TextEncoder()
const dec = new TextDecoder()
const toBytes = (text: string): number[] => Array.from(enc.encode(text))

// A minimal structural subset of `@number0/iroh`'s real surface — just enough for a link to
// dial and transfer. Kept loose (not the native module's own classes) so tests can inject a
// plain-object mock via `loadIroh` without pulling in the native module at all.
export interface IrohRecvStreamLike {
  read(sizeLimit: number): Promise<number[] | null>
}
export interface IrohSendStreamLike {
  writeAll(buf: number[]): Promise<void>
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
}
export interface IrohModuleLike {
  Endpoint: { builder(): IrohEndpointBuilderLike }
  presetN0(builder: IrohEndpointBuilderLike): void
  EndpointTicket: { fromString(ticket: string): { endpointAddr(): unknown } }
}

export type LoadIroh = () => Promise<IrohModuleLike>

export const defaultLoadIroh: LoadIroh = () => import("@number0/iroh") as unknown as Promise<IrohModuleLike>

export async function bindIrohEndpoint(loadIroh: LoadIroh): Promise<{
  iroh: IrohModuleLike
  endpoint: IrohEndpointLike
}> {
  const iroh = await loadIroh()
  const builder = iroh.Endpoint.builder()
  iroh.presetN0(builder)
  const endpoint = await builder.bind()
  await endpoint.online()
  return { iroh, endpoint }
}

export function ticketAddr(iroh: IrohModuleLike, ticket: string): unknown {
  return iroh.EndpointTicket.fromString(ticket.trim()).endpointAddr()
}

export function closeIrohEndpoint(endpoint: IrohEndpointLike | undefined): void {
  try {
    const result = endpoint?.close?.()
    // The real `Endpoint.close()` returns a Promise; swallow a rejection so it never
    // surfaces as an unhandled promise rejection during teardown.
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => {})
    }
  } catch {
    // ignore — already gone
  }
}

/**
 * One QUIC connection's control stream + media streams. Owners (`IrohClient`, `LinkPool`)
 * bind the endpoint and decide when to redial; this class never binds an endpoint and never
 * redials. Each instance starts a FRESH write chain (F13): a pending `writeAll` against a
 * dead stream must not silence the next connection.
 */
export class IrohLink {
  private sendStream: IrohSendStreamLike | undefined
  private connection: IrohConnectionLike | undefined
  private recv: IrohRecvStreamLike | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false
  private started = false
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  private readonly unexpectedEndHandlers = new Set<() => void>()

  private constructor(connection: IrohConnectionLike, send: IrohSendStreamLike, recv: IrohRecvStreamLike) {
    this.connection = connection
    this.sendStream = send
    this.recv = recv
  }

  static async open(endpoint: IrohEndpointLike, addr: unknown): Promise<IrohLink> {
    const conn = await connectWithRetry(endpoint, addr, toBytes(ALPN))
    const bi = await conn.openBi()
    return new IrohLink(conn, bi.send, bi.recv)
  }

  /** Begin the control-stream read loop. Call after handlers are attached and join is sent. */
  start(): void {
    if (this.started || this.closed || !this.recv) return
    this.started = true
    void this.readLoop(this.recv)
  }

  get isClosed(): boolean {
    return this.closed
  }

  send(frame: ClientFrame): void {
    const line = toBytes(`${JSON.stringify(frame)}\n`)
    // Serialize writes: interleaved writeAll on one QUIC stream would corrupt the framing.
    // `this.sendStream` is read at write-time (not capture-time), so a write queued just
    // before close naturally no-ops once the stream is cleared.
    this.writeChain = this.writeChain.then(() => this.sendStream?.writeAll(line)).catch(() => {})
  }

  join(key: string, name?: string, clientInfo?: ClientInfo): void {
    this.send({
      type: FrameType.Join,
      key,
      ...(name ? { name } : {}),
      ...(clientInfo ? { client: clientInfo } : {}),
    })
  }

  sendInput(text: string): void {
    this.send({ type: FrameType.Input, text })
  }

  async uploadMedia(upload: MediaUpload): Promise<MediaFrame | undefined> {
    const accept = await this.offerMedia({
      type: FrameType.MediaOffer,
      name: upload.name,
      mime: upload.mime,
      size: upload.bytes.byteLength,
      sha256: upload.sha256,
    })
    if (accept.existing) return accept.media
    if (!accept.upload_id) return accept.media
    const stream = await this.openMediaStream()
    await stream.send.writeAll(toBytes(`${JSON.stringify({ op: "put", upload_id: accept.upload_id })}\n`))
    for (let offset = 0; offset < upload.bytes.byteLength; offset += 65536) {
      await stream.send.writeAll(Array.from(upload.bytes.subarray(offset, offset + 65536)))
    }
    // The server confirms the stored blob with a `put_ok` line, or reports a localized error
    // line (hash/size mismatch, unsafe SVG, …) — surface it instead of pretending success.
    const reply = await new IrohMediaReader(stream.recv).readHeader()
    if (reply.op !== "put_ok") throw new Error(String(reply.message ?? "Iroh media upload was not acknowledged."))
    return accept.media
  }

  async getMedia(hash: string): Promise<MediaPayload> {
    const stream = await this.openMediaStream()
    await stream.send.writeAll(toBytes(`${JSON.stringify({ op: "get", hash })}\n`))
    const reader = new IrohMediaReader(stream.recv)
    const header = await reader.readHeader()
    // An error reply is a `{type:"error"}` line with no body — without this check it would
    // silently read as an empty zero-byte payload.
    if (header.op !== "get") throw new Error(String(header.message ?? "Iroh media download failed."))
    const size = Number(header.size ?? 0)
    const bytes = await reader.readExact(size)
    return {
      hash: String(header.hash ?? hash),
      mime: String(header.mime ?? ""),
      name: String(header.name ?? ""),
      bytes,
    }
  }

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  onUnexpectedEnd(cb: () => void): () => void {
    this.unexpectedEndHandlers.add(cb)
    return () => this.unexpectedEndHandlers.delete(cb)
  }

  close(): void {
    this.closed = true
    this.sendStream = undefined
    this.recv = undefined
    try {
      this.connection?.close?.(0n, [])
    } catch {
      // ignore — already gone
    }
    this.connection = undefined
  }

  private async readLoop(recv: IrohRecvStreamLike): Promise<void> {
    let buffer = new Uint8Array(0)
    try {
      while (!this.closed) {
        const chunk = await recv.read(65536)
        if (!chunk || chunk.length === 0) break // EOF / reset
        buffer = concat(buffer, Uint8Array.from(chunk))
        let nl: number
        while ((nl = buffer.indexOf(NEWLINE)) >= 0) {
          this.dispatch(dec.decode(buffer.subarray(0, nl)))
          buffer = buffer.subarray(nl + 1)
        }
      }
    } catch {
      // stream closed / reset — nothing more to read
    }
    if (!this.closed) {
      for (const handler of this.unexpectedEndHandlers) handler()
    }
  }

  private dispatch(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return // untrusted transport: a non-JSON line must never throw out of the read loop
    }
    if (isPingFrame(parsed)) {
      this.send({ type: FrameType.Pong, t: parsed.t })
      return
    }
    if (!isServerFrame(parsed)) return
    for (const handler of this.handlers) handler(parsed)
  }

  private offerMedia(frame: ClientFrame & { type: typeof FrameType.MediaOffer }): Promise<Extract<ServerFrame, { type: "media_accept" }>> {
    return new Promise((resolve, reject) => {
      const off = this.onMessage((reply) => {
        if (reply.type === FrameType.MediaAccept) {
          off()
          resolve(reply)
        } else if (reply.type === FrameType.Error) {
          off()
          reject(new Error(reply.message))
        }
      })
      this.send(frame)
    })
  }

  private async openMediaStream(): Promise<{ send: IrohSendStreamLike; recv: IrohRecvStreamLike }> {
    if (!this.connection) throw new Error("Iroh connection is not open.")
    return await this.connection.openBi()
  }
}

async function connectWithRetry(
  endpoint: IrohEndpointLike,
  addr: unknown,
  alpn: number[],
  tries = 2,
): Promise<IrohConnectionLike> {
  let lastError: unknown
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await endpoint.connect(addr, alpn)
    } catch (error) {
      lastError = error // p2p first-connect can flake on relay warm-up — one retry
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Iroh connection failed.")
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

class IrohMediaReader {
  private buffer = new Uint8Array(0)

  constructor(private readonly recv: IrohRecvStreamLike) {}

  async readHeader(): Promise<Record<string, unknown>> {
    while (true) {
      const nl = this.buffer.indexOf(NEWLINE)
      if (nl >= 0) {
        const line = this.buffer.subarray(0, nl)
        this.buffer = this.buffer.subarray(nl + 1)
        const parsed = JSON.parse(dec.decode(line))
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
        throw new Error("Invalid media header.")
      }
      const chunk = await this.recv.read(65536)
      if (!chunk || chunk.length === 0) throw new Error("Iroh media stream ended before header.")
      this.buffer = concat(this.buffer, Uint8Array.from(chunk))
    }
  }

  async readExact(size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size)
    let offset = 0
    if (this.buffer.byteLength > 0) {
      const take = Math.min(size, this.buffer.byteLength)
      out.set(this.buffer.subarray(0, take), 0)
      this.buffer = this.buffer.subarray(take)
      offset += take
    }
    while (offset < size) {
      const chunk = await this.recv.read(Math.min(65536, size - offset))
      if (!chunk || chunk.length === 0) throw new Error("Iroh media stream ended before body.")
      const bytes = Uint8Array.from(chunk)
      const take = Math.min(size - offset, bytes.byteLength)
      out.set(bytes.subarray(0, take), offset)
      offset += take
      if (take < bytes.byteLength) this.buffer = concat(bytes.subarray(take), this.buffer)
    }
    return out
  }
}
