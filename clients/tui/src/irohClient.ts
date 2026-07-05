import {
  FrameType,
  isPingFrame,
  isServerFrame,
  type AdminDeleteRoomDataFrame,
  type AdminEnableSkillFrame,
  type AdminExportRoomFrame,
  type AdminForgeKind,
  type AdminGenerateFrame,
  type AdminImportRoomFrame,
  type AdminListModelsFrame,
  type AdminMintKeyFrame,
  type AdminSetModelFrame,
  type AdminUpdateKeyFrame,
  type ClientFrame,
  type ConnectionStatus,
  type MediaFrame,
  type MediaPayload,
  type MediaUpload,
  type PlayerRole,
  type ServerFrame,
} from "@loreweaver/protocol"
import type { AppClient } from "./client"

// The ALPN + newline framing MUST match net/iroh_server.py. A QUIC bidi stream is a raw byte
// stream (no message boundaries), so every frame is one compact JSON object + "\n".
const ALPN = "loreweaver/tui/1"
const NEWLINE = 10
const enc = new TextEncoder()
const dec = new TextDecoder()
const toBytes = (text: string): number[] => Array.from(enc.encode(text))

// Iroh tickets are base32 (they start with "endpoint"); anything that isn't a ws(s):// URL is
// treated as one, so the connect field accepts either a p2p ticket or a WebSocket URL.
export function isIrohTicket(target: string): boolean {
  return !/^wss?:\/\//i.test(target.trim())
}

// A minimal structural subset of `@number0/iroh`'s real surface — just enough for `dial()`
// below. Kept loose (not the native module's own classes) so tests can inject a plain-object
// mock via `loadIroh` without pulling in the native module at all.
interface IrohRecvStreamLike {
  read(sizeLimit: number): Promise<number[] | null>
}
interface IrohSendStreamLike {
  writeAll(buf: number[]): Promise<void>
}
interface IrohConnectionLike {
  openBi(): Promise<{ send: IrohSendStreamLike; recv: IrohRecvStreamLike }>
}
interface IrohEndpointLike {
  online(): Promise<void>
  connect(addr: unknown, alpn: number[]): Promise<IrohConnectionLike>
  close?(): unknown
}
interface IrohEndpointBuilderLike {
  bind(): Promise<IrohEndpointLike>
}
interface IrohModuleLike {
  Endpoint: { builder(): IrohEndpointBuilderLike }
  presetN0(builder: IrohEndpointBuilderLike): void
  EndpointTicket: { fromString(ticket: string): { endpointAddr(): unknown } }
}

export type LoadIroh = () => Promise<IrohModuleLike>

const defaultLoadIroh: LoadIroh = () => import("@number0/iroh") as unknown as Promise<IrohModuleLike>

export interface IrohClientOptions {
  // Injected in tests to avoid loading the native `@number0/iroh` module at all; defaults to
  // the real dynamic import.
  loadIroh?: LoadIroh
  reconnect?: boolean
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/**
 * The p2p transport, behind the same `AppClient` contract as `WsClient`. `@number0/iroh` is a
 * native (napi) module, imported DYNAMICALLY in `dial()` — the browser web client never loads
 * this file, and a WS-only run never pulls iroh into memory. Frames are newline-JSON over one
 * long-lived `openBi` stream, dispatched with the shared `@loreweaver/protocol` validators.
 *
 * Reconnect parity with `WsClient` (clients/protocol/src/client.ts): `lastJoin` is re-sent on
 * every successful (re)dial; an unexpected end of the read loop (not a manual `close()`)
 * schedules a redial of the same ticket with the same exponential backoff (base 250ms, max
 * 5000ms); `close()` sets `manualClose` and permanently stops the loop.
 */
export class IrohClient implements AppClient {
  private endpoint: IrohEndpointLike | undefined
  private connection: IrohConnectionLike | undefined
  private sendStream: IrohSendStreamLike | undefined
  private manualClose = false
  private ticket?: string
  private lastJoin?: { key: string; name?: string }
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  // Bumped on every `dial()` so a stale readLoop from a superseded connection attempt can
  // never trigger a duplicate redial once a newer dial has taken over.
  private generation = 0
  private writeChain: Promise<void> = Promise.resolve()
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>()
  private readonly loadIroh: LoadIroh
  private readonly reconnect: boolean
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(options: IrohClientOptions = {}) {
    this.loadIroh = options.loadIroh ?? defaultLoadIroh
    this.reconnect = options.reconnect ?? true
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5_000
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  }

  async connect(ticket: string): Promise<void> {
    this.ticket = ticket
    this.manualClose = false
    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    // A first-time connect failure rejects straight to the caller (the connect screen shows
    // the error) — it does NOT enter the redial loop; redials only start once a session has
    // actually been established (see `readLoop`'s unexpected-end handling below).
    await this.dial(ticket)
  }

  private async dial(ticket: string): Promise<void> {
    const myGeneration = ++this.generation
    this.setStatus("connecting")
    const iroh = await this.loadIroh()
    const builder = iroh.Endpoint.builder()
    iroh.presetN0(builder)
    const endpoint = await builder.bind()
    await endpoint.online()
    const addr = iroh.EndpointTicket.fromString(ticket.trim()).endpointAddr()
    const conn = await this.connectWithRetry(endpoint, addr, toBytes(ALPN))
    const bi = await conn.openBi()

    // A manual close() (or a newer dial superseding this one) raced us while we were still
    // connecting — don't take over as the live connection; tear down what we just opened.
    if (this.manualClose || myGeneration !== this.generation) {
      this.closeEndpoint(endpoint)
      return
    }

    // Hand over to the new connection FIRST, then close the one it supersedes. Each dial()
    // binds a fresh native Endpoint, so on a redial after an unexpected drop the prior endpoint
    // must be closed or every reconnect over a long, flap-prone session leaks its socket/QUIC
    // state. Closing only AFTER the handoff means the live stream is never dropped mid-swap.
    const superseded = this.endpoint
    this.endpoint = endpoint
    this.connection = conn
    this.sendStream = bi.send
    this.reconnectAttempts = 0
    if (superseded && superseded !== endpoint) this.closeEndpoint(superseded)
    this.setStatus("online")
    if (this.lastJoin) this.join(this.lastJoin.key, this.lastJoin.name)
    void this.readLoop(bi.recv, myGeneration)
  }

  private async connectWithRetry(
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

  private async readLoop(recv: IrohRecvStreamLike, generation: number): Promise<void> {
    let buffer = new Uint8Array(0)
    try {
      while (!this.manualClose && generation === this.generation) {
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
    // The stream ended and it wasn't us calling close(), and no newer dial has already
    // taken over (see the race guard in `dial()`) — this is an UNEXPECTED drop (server
    // restart, laptop sleep, network flap): redial the same ticket.
    if (!this.manualClose && generation === this.generation) this.scheduleRedial()
  }

  private scheduleRedial(): void {
    if (this.manualClose || !this.reconnect || !this.ticket) return
    this.setStatus("reconnecting")
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      // A redial attempt itself can fail (still no network) — unlike `connect()`, keep
      // retrying with the same backoff rather than giving up silently.
      this.dial(this.ticket!).catch(() => this.scheduleRedial())
    }, delay)
  }

  private dispatch(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return // untrusted transport: a non-JSON line must never throw out of the read loop
    }
    if (isPingFrame(parsed)) {
      this.sendFrame({ type: FrameType.Pong, t: parsed.t })
      return
    }
    if (!isServerFrame(parsed)) return
    for (const handler of this.handlers) handler(parsed)
  }

  private sendFrame(frame: ClientFrame): void {
    const line = toBytes(`${JSON.stringify(frame)}\n`)
    // Serialize writes: interleaved writeAll on one QUIC stream would corrupt the framing.
    // `this.sendStream` is read at write-time (not capture-time), so a write queued just
    // before a reconnect naturally goes out over the freshest stream once one exists.
    this.writeChain = this.writeChain.then(() => this.sendStream?.writeAll(line)).catch(() => {})
  }

  join(key: string, name?: string): void {
    this.lastJoin = { key, name }
    this.sendFrame(name ? { type: FrameType.Join, key, name } : { type: FrameType.Join, key })
  }

  sendInput(text: string): void {
    this.sendFrame({ type: FrameType.Input, text })
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

  setMediaEnabled(enabled: boolean): void {
    this.sendFrame({ type: FrameType.MediaSetEnabled, enabled })
  }

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb)
    return () => this.statusHandlers.delete(cb)
  }

  private setStatus(status: ConnectionStatus): void {
    for (const cb of this.statusHandlers) cb(status)
  }

  close(): void {
    this.manualClose = true
    this.generation += 1
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.setStatus("offline")
    this.closeEndpoint(this.endpoint)
    this.connection = undefined
    this.sendStream = undefined
  }

  private closeEndpoint(endpoint: IrohEndpointLike | undefined): void {
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

  // ---- v1.1 admin (keeper-gated) requests, identical wire to WsClient -------
  adminGetConfig(): void {
    this.sendFrame({ type: FrameType.AdminGetConfig })
  }

  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminSetModelFrame = { type: FrameType.AdminSetModel, provider }
    if (chatModel) frame.chat_model = chatModel
    if (apiKey) frame.api_key = apiKey
    if (baseUrl) frame.base_url = baseUrl
    this.sendFrame(frame)
  }

  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminListModelsFrame = { type: FrameType.AdminListModels }
    if (provider) frame.provider = provider
    if (apiKey) frame.api_key = apiKey
    if (baseUrl) frame.base_url = baseUrl
    this.sendFrame(frame)
  }

  adminListKeys(): void {
    this.sendFrame({ type: FrameType.AdminListKeys })
  }

  adminMintKey(room: string, name?: string, role?: PlayerRole): void {
    const frame: AdminMintKeyFrame = { type: FrameType.AdminMintKey, room }
    if (name) frame.name = name
    if (role) frame.role = role
    this.sendFrame(frame)
  }

  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void {
    const frame: AdminUpdateKeyFrame = { type: FrameType.AdminUpdateKey, id }
    if (room) frame.room = room
    if (name) frame.name = name
    if (role) frame.role = role
    this.sendFrame(frame)
  }

  adminDeleteKey(id: string): void {
    this.sendFrame({ type: FrameType.AdminDeleteKey, id })
  }

  adminDeleteRoom(room: string): void {
    this.sendFrame({ type: FrameType.AdminDeleteRoom, room })
  }

  adminExportRoom(room: string, path?: string): void {
    const frame: AdminExportRoomFrame = { type: FrameType.AdminExportRoom, room }
    if (path) frame.path = path
    this.sendFrame(frame)
  }

  adminImportRoom(path: string, room?: string): void {
    const frame: AdminImportRoomFrame = { type: FrameType.AdminImportRoom, path }
    if (room) frame.room = room
    this.sendFrame(frame)
  }

  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void {
    const frame: AdminDeleteRoomDataFrame = { type: FrameType.AdminDeleteRoomData, room }
    if (backup !== undefined) frame.backup = backup
    if (path) frame.path = path
    this.sendFrame(frame)
  }

  // ---- v1.1 additive: Layer B.4a plugin management, identical wire to WsClient ------
  adminListSkills(): void {
    this.sendFrame({ type: FrameType.AdminListSkills })
  }

  adminEnableSkill(id: string, on: boolean): void {
    const frame: AdminEnableSkillFrame = { type: FrameType.AdminEnableSkill, id, on }
    this.sendFrame(frame)
  }

  adminListRules(): void {
    this.sendFrame({ type: FrameType.AdminListRules })
  }

  adminGenerate(kind: AdminForgeKind, description: string): void {
    const frame: AdminGenerateFrame = { type: FrameType.AdminGenerate, kind, description }
    this.sendFrame(frame)
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
      this.sendFrame(frame)
    })
  }

  private async openMediaStream(): Promise<{ send: IrohSendStreamLike; recv: IrohRecvStreamLike }> {
    if (!this.connection) throw new Error("Iroh connection is not open.")
    return await this.connection.openBi()
  }
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
