import {
  FrameType,
  type AdminDeleteRoomDataFrame,
  type AdminEnableSkillFrame,
  type AdminExportRoomFrame,
  type AdminForgeKind,
  type AdminGenerateFrame,
  type AdminImportRoomFrame,
  type AdminListModelsFrame,
  type AdminMintKeyFrame,
  type AdminSetImagegenFrame,
  type AdminSetModelFrame,
  type AdminUpdateKeyFrame,
  type AvatarSetFrame,
  type ClientFrame,
  type ClientInfo,
  type MediaAcceptFrame,
  type MediaFrame,
  type MediaOfferFrame,
  type PingFrame,
  type PlayerRole,
  type PongFrame,
  type ServerFrame,
} from "./types"

export interface WebSocketLike {
  readonly readyState: number
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener?(type: "open", listener: (event: unknown) => void): void
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener?(type: "close", listener: (event: unknown) => void): void
  addEventListener?(type: "error", listener: (event: unknown) => void): void
  onopen?: ((event: unknown) => void) | null
  onmessage?: ((event: { data: unknown }) => void) | null
  onclose?: ((event: unknown) => void) | null
  onerror?: ((event: unknown) => void) | null
}

export type WebSocketFactory = (url: string) => WebSocketLike
export type MessageHandler = (frame: ServerFrame) => void
export type TypedMessageHandler<T extends ServerFrame["type"]> = (frame: Extract<ServerFrame, { type: T }>) => void

// The transport's coarse liveness, for a small UI indicator (🟢/🟡/🔴). "connecting" covers
// both the very first dial and each redial attempt; "online" is a settled, joined socket;
// "reconnecting" is the backoff window between an unexpected drop and the next redial;
// "offline" is only reached via an explicit `close()` (the reconnect loop has stopped for good).
export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline"
export type StatusHandler = (status: ConnectionStatus) => void

export interface WsClientOptions {
  webSocketFactory?: WebSocketFactory
  clientInfo?: ClientInfo
  reconnect?: boolean
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export interface MediaUpload {
  name: string
  mime: string
  bytes: Uint8Array
  sha256: string
}

export interface MediaPayload {
  hash: string
  mime: string
  name: string
  bytes: Uint8Array
}

const OPEN = 1
const WS_MEDIA_HEADER_BYTES = 4

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const isStr = (v: unknown): v is string => typeof v === "string"
const isNum = (v: unknown): v is number => typeof v === "number"
const isArr = Array.isArray

// Per-frame-type validation of the load-bearing required fields. A frame that
// passes the `type` check but is missing/mistyped these (e.g. `{"type":"state"}`
// with no party/initiative, or a narrative with no speaker/text) is DROPPED here
// so it can never crash a downstream consumer (`.map`/`.length`/`.toUpperCase`
// on `undefined` in the web panels and the TUI). One validator table protects
// every client.
const serverFrameValidators: Record<string, (f: Record<string, unknown>) => boolean> = {
  [FrameType.Welcome]: (f) => isStr(f.room) && isObject(f.you) && isStr(f.you.name) && isStr(f.you.role),
  [FrameType.Error]: (f) => isStr(f.code) && isStr(f.message),
  [FrameType.MediaAccept]: (f) => isStr(f.upload_id),
  [FrameType.Media]: (f) =>
    isStr(f.id) && isStr(f.hash) && isStr(f.mime) && isNum(f.size) && isStr(f.name) && isStr(f.from) && isNum(f.ts),
  [FrameType.MediaEnabled]: (f) => typeof f.enabled === "boolean",
  [FrameType.AudioLibraryItem]: (f) =>
    isStr(f.id) && isStr(f.hash) && isStr(f.mime) && isNum(f.size) && isStr(f.name) && isStr(f.from) && isNum(f.ts),
  [FrameType.AudioControl]: (f) => isStr(f.id) && isStr(f.action) && isStr(f.layer),
  [FrameType.AudioState]: (f) => isArr(f.layers),
  [FrameType.Narrative]: (f) => isStr(f.id) && isStr(f.speaker) && isStr(f.text),
  [FrameType.Dice]: (f) => isStr(f.actor) && isStr(f.expr) && isNum(f.total),
  [FrameType.State]: (f) => isArr(f.party) && isArr(f.initiative) && isNum(f.online),
  [FrameType.Presence]: (f) => isArr(f.players) && isNum(f.online),
  [FrameType.System]: (f) => isStr(f.level) && isStr(f.text),
  [FrameType.Pong]: (f) => isNum(f.t),
  [FrameType.AdminConfig]: (f) => isStr(f.provider) && isStr(f.chat_model) && isArr(f.providers),
  [FrameType.AdminModels]: (f) => isStr(f.provider) && isArr(f.models),
  [FrameType.AdminKeys]: (f) => isArr(f.keys),
  [FrameType.AdminRoomOp]: (f) =>
    isStr(f.action) && isStr(f.room) && isNum(f.keys) && isNum(f.store_rows) && isNum(f.vector_points),
  [FrameType.AdminError]: (f) => isStr(f.code),
  [FrameType.AdminSkills]: (f) => isArr(f.skills),
  [FrameType.AdminRules]: (f) => isArr(f.systems),
  [FrameType.AdminGenerated]: (f) => isStr(f.kind) && typeof f.ok === "boolean",
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("No global WebSocket is available; pass webSocketFactory to WsClient.")
  }
  // The DOM WebSocket satisfies our runtime needs; its structural type is wider
  // (send accepts Blob/ArrayBuffer, handlers are nullable), so bridge explicitly.
  return new WebSocket(url) as unknown as WebSocketLike
}

function toText(data: unknown): string {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (data && typeof Blob !== "undefined" && data instanceof Blob) {
    throw new Error("Blob WebSocket messages are not supported by WsClient.")
  }
  return String(data)
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!isObject(value)) return false
  const validate = serverFrameValidators[String(value.type)]
  return validate !== undefined && validate(value)
}

export function isPingFrame(value: unknown): value is PingFrame {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === FrameType.Ping &&
      typeof (value as { t?: unknown }).t === "number",
  )
}

export class WsClient {
  private socket?: WebSocketLike
  private url?: string
  private manualClose = false
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private lastJoin?: { key: string; name?: string }
  private readonly factory: WebSocketFactory
  private readonly clientInfo?: ClientInfo
  private readonly reconnect: boolean
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly messageHandlers = new Set<MessageHandler>()
  private readonly typedHandlers = new Map<ServerFrame["type"], Set<MessageHandler>>()
  private readonly statusHandlers = new Set<StatusHandler>()
  private readonly pendingOffers: Array<{
    resolve: (frame: MediaAcceptFrame) => void
    reject: (error: Error) => void
  }> = []
  private readonly pendingGets = new Map<
    string,
    {
      resolve: (payload: MediaPayload) => void
      reject: (error: Error) => void
    }
  >()

  constructor(options: WsClientOptions = {}) {
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory
    this.clientInfo = options.clientInfo
    this.reconnect = options.reconnect ?? true
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5_000
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  }

  async connect(url: string): Promise<void> {
    this.url = url
    this.manualClose = false
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.setStatus("connecting")

    const socket = this.factory(url)
    this.socket = socket

    return new Promise((resolve, reject) => {
      let settled = false

      const settleOpen = () => {
        settled = true
        this.reconnectAttempts = 0
        this.setStatus("online")
        resolve()
        if (this.lastJoin) {
          this.join(this.lastJoin.key, this.lastJoin.name)
        }
      }

      const settleError = (event: unknown) => {
        if (!settled) {
          settled = true
          reject(event instanceof Error ? event : new Error("WebSocket connection failed."))
        }
      }

      this.attach(socket, "open", settleOpen)
      this.attach(socket, "message", (event) => this.handleRawMessage(event.data))
      this.attach(socket, "close", () => this.handleClose())
      this.attach(socket, "error", settleError)
    })
  }

  close(code?: number, reason?: string): void {
    this.manualClose = true
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.setStatus("offline")
    this.socket?.close(code, reason)
  }

  join(key: string, name?: string): void {
    this.lastJoin = { key, name }
    const frame = {
      type: FrameType.Join,
      key,
      ...(name ? { name } : {}),
      ...(this.clientInfo ? { client: this.clientInfo } : {}),
    }
    this.send(frame)
  }

  sendInput(text: string): void {
    this.send({ type: FrameType.Input, text })
  }

  ping(t = Date.now()): void {
    this.send({ type: FrameType.Ping, t })
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
    this.sendMedia({ op: "put", upload_id: accept.upload_id }, upload.bytes)
    return accept.media
  }

  getMedia(hash: string): Promise<MediaPayload> {
    if (!this.socket || this.socket.readyState !== OPEN) {
      return Promise.reject(new Error("WebSocket is not open."))
    }
    return new Promise((resolve, reject) => {
      this.pendingGets.set(hash, { resolve, reject })
      this.sendMedia({ op: "get", hash })
    })
  }

  setMediaEnabled(enabled: boolean): void {
    this.send({ type: FrameType.MediaSetEnabled, enabled })
  }

  setAvatar(hash: string): void {
    const frame: AvatarSetFrame = { type: FrameType.AvatarSet, hash }
    this.send(frame)
  }

  // ---- v1.1 admin (keeper-gated) requests --------------------------------
  // The server only honors these on a keeper-role connection; otherwise it
  // replies `admin_error {code:"forbidden"}`.

  adminGetConfig(): void {
    this.send({ type: FrameType.AdminGetConfig })
  }

  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminSetModelFrame = { type: FrameType.AdminSetModel, provider }
    if (chatModel) frame.chat_model = chatModel
    // Presence is meaningful: an explicit empty key/URL clears the saved field,
    // while `undefined` asks the server to reuse the unchanged endpoint pair.
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    this.send(frame)
  }

  adminSetImagegen(provider: string, model: string, apiKey?: string, baseUrl?: string, size?: string): void {
    const frame: AdminSetImagegenFrame = { type: FrameType.AdminSetImagegen, provider, model }
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    if (size) frame.size = size
    this.send(frame)
  }

  // Ask for a provider's live model catalog. Omit args to list the current provider;
  // pass provider (+ optional apiKey/baseUrl) to preview another before switching.
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminListModelsFrame = { type: FrameType.AdminListModels }
    if (provider) frame.provider = provider
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    this.send(frame)
  }

  adminListKeys(): void {
    this.send({ type: FrameType.AdminListKeys })
  }

  adminMintKey(room?: string, name?: string, role?: PlayerRole): void {
    const frame: AdminMintKeyFrame = { type: FrameType.AdminMintKey }
    if (room !== undefined) frame.room = room
    if (name) frame.name = name
    if (role) frame.role = role
    this.send(frame)
  }

  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void {
    const frame: AdminUpdateKeyFrame = { type: FrameType.AdminUpdateKey, id }
    if (room !== undefined) frame.room = room
    if (name !== undefined) frame.name = name
    if (role !== undefined) frame.role = role
    this.send(frame)
  }

  adminDeleteKey(id: string): void {
    this.send({ type: FrameType.AdminDeleteKey, id })
  }

  adminDeleteRoom(room: string): void {
    this.send({ type: FrameType.AdminDeleteRoom, room })
  }

  adminExportRoom(room: string, path?: string): void {
    const frame: AdminExportRoomFrame = { type: FrameType.AdminExportRoom, room }
    if (path) frame.path = path
    this.send(frame)
  }

  adminImportRoom(path: string, room?: string): void {
    const frame: AdminImportRoomFrame = { type: FrameType.AdminImportRoom, path }
    if (room) frame.room = room
    this.send(frame)
  }

  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void {
    const frame: AdminDeleteRoomDataFrame = { type: FrameType.AdminDeleteRoomData, room }
    if (backup !== undefined) frame.backup = backup
    if (path) frame.path = path
    this.send(frame)
  }

  // ---- v1.1 additive: Layer B.4a plugin management (KP skills / rule systems / forge) ----

  adminListSkills(): void {
    this.send({ type: FrameType.AdminListSkills })
  }

  adminEnableSkill(id: string, on: boolean): void {
    const frame: AdminEnableSkillFrame = { type: FrameType.AdminEnableSkill, id, on }
    this.send(frame)
  }

  adminListRules(): void {
    this.send({ type: FrameType.AdminListRules })
  }

  // Author + install a brand-new skill/rule system/module from a description via the matching
  // `agent.forge` generator. Slow (an LLM call) but still a plain request/reply — the caller
  // shows a spinner while awaiting the `admin_generated` reply.
  adminGenerate(kind: AdminForgeKind, description: string): void {
    const frame: AdminGenerateFrame = { type: FrameType.AdminGenerate, kind, description }
    this.send(frame)
  }

  send(frame: ClientFrame): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error("WebSocket is not open.")
    }
    this.socket.send(JSON.stringify(frame))
  }

  onMessage(cb: MessageHandler): () => void {
    this.messageHandlers.add(cb)
    return () => this.messageHandlers.delete(cb)
  }

  on<T extends ServerFrame["type"]>(type: T, cb: TypedMessageHandler<T>): () => void {
    const handlers = this.typedHandlers.get(type) ?? new Set<MessageHandler>()
    handlers.add(cb as MessageHandler)
    this.typedHandlers.set(type, handlers)
    return () => handlers.delete(cb as MessageHandler)
  }

  // Optional: a small HUD indicator subscribes here rather than polling. Not called with
  // the current status on subscribe — only future transitions — so a fresh subscriber sees
  // "connecting" implicitly (no event yet) until the next real transition fires.
  onStatus(cb: StatusHandler): () => void {
    this.statusHandlers.add(cb)
    return () => this.statusHandlers.delete(cb)
  }

  private setStatus(status: ConnectionStatus): void {
    for (const handler of this.statusHandlers) handler(status)
  }

  private attach<T extends "open" | "message" | "close" | "error">(
    socket: WebSocketLike,
    type: T,
    listener: T extends "message" ? (event: { data: unknown }) => void : (event: unknown) => void,
  ): void {
    if (socket.addEventListener) {
      socket.addEventListener(type as never, listener as never)
      return
    }

    const property = `on${type}` as keyof WebSocketLike
    ;(socket[property] as typeof listener | undefined) = listener
  }

  private handleRawMessage(data: unknown): void {
    const binary = toUint8Array(data)
    if (binary) {
      this.handleMediaMessage(binary)
      return
    }
    // Untrusted transport: a non-JSON (or undecodable) message must never throw
    // out of the socket's message handler — drop it and keep the connection alive.
    let parsed: unknown
    try {
      parsed = JSON.parse(toText(data))
    } catch {
      return
    }
    if (isPingFrame(parsed)) {
      this.sendPong(parsed.t)
      return
    }
    if (!isServerFrame(parsed)) return
    if (parsed.type === FrameType.MediaAccept) {
      const pending = this.pendingOffers.shift()
      if (pending) pending.resolve(parsed)
    }
    if (parsed.type === FrameType.Error) {
      const error = new Error(parsed.message)
      const pendingOffer = this.pendingOffers.shift()
      if (pendingOffer) pendingOffer.reject(error)
      for (const pending of this.pendingGets.values()) pending.reject(error)
      this.pendingGets.clear()
    }

    for (const handler of this.messageHandlers) handler(parsed)
    const typed = this.typedHandlers.get(parsed.type)
    if (!typed) return
    for (const handler of typed) handler(parsed)
  }

  private sendPong(t: number): void {
    if (!this.socket || this.socket.readyState !== OPEN) return
    const frame: PongFrame = { type: FrameType.Pong, t }
    this.socket.send(JSON.stringify(frame))
  }

  private handleClose(): void {
    if (this.manualClose || !this.reconnect || !this.url) return
    this.setStatus("reconnecting")
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      void this.connect(this.url!)
    }, delay)
  }

  private offerMedia(frame: MediaOfferFrame): Promise<MediaAcceptFrame> {
    if (!this.socket || this.socket.readyState !== OPEN) {
      return Promise.reject(new Error("WebSocket is not open."))
    }
    return new Promise((resolve, reject) => {
      this.pendingOffers.push({ resolve, reject })
      this.send(frame)
    })
  }

  private sendMedia(header: Record<string, unknown>, bytes = new Uint8Array()): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error("WebSocket is not open.")
    }
    this.socket.send(packMediaMessage(header, bytes))
  }

  private handleMediaMessage(payload: Uint8Array): void {
    let unpacked: { header: Record<string, unknown>; body: Uint8Array }
    try {
      unpacked = unpackMediaMessage(payload)
    } catch {
      return
    }
    const hash = String(unpacked.header.hash ?? "")
    const pending = this.pendingGets.get(hash)
    if (!pending) return
    this.pendingGets.delete(hash)
    pending.resolve({
      hash,
      mime: String(unpacked.header.mime ?? ""),
      name: String(unpacked.header.name ?? ""),
      bytes: unpacked.body,
    })
  }
}

export function packMediaMessage(header: Record<string, unknown>, body = new Uint8Array()): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(WS_MEDIA_HEADER_BYTES + headerBytes.byteLength + body.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, headerBytes.byteLength)
  out.set(headerBytes, WS_MEDIA_HEADER_BYTES)
  out.set(body, WS_MEDIA_HEADER_BYTES + headerBytes.byteLength)
  return out
}

export function unpackMediaMessage(payload: Uint8Array): { header: Record<string, unknown>; body: Uint8Array } {
  if (payload.byteLength < WS_MEDIA_HEADER_BYTES) throw new Error("media message missing header length")
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const headerLength = view.getUint32(0)
  const start = WS_MEDIA_HEADER_BYTES
  const end = start + headerLength
  if (headerLength <= 0 || end > payload.byteLength) throw new Error("media message has invalid header length")
  const parsed = JSON.parse(new TextDecoder().decode(payload.subarray(start, end)))
  if (!isObject(parsed)) throw new Error("media header is not an object")
  return { header: parsed, body: payload.subarray(end) }
}

function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return undefined
}
