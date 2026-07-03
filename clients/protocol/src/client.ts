import {
  FrameType,
  type AdminDeleteRoomDataFrame,
  type AdminExportRoomFrame,
  type AdminImportRoomFrame,
  type AdminListModelsFrame,
  type AdminMintKeyFrame,
  type AdminSetModelFrame,
  type AdminUpdateKeyFrame,
  type ClientFrame,
  type PingFrame,
  type PlayerRole,
  type PongFrame,
  type ServerFrame,
} from "./types"

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
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

export interface WsClientOptions {
  webSocketFactory?: WebSocketFactory
  reconnect?: boolean
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

const OPEN = 1

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
  private readonly reconnect: boolean
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly messageHandlers = new Set<MessageHandler>()
  private readonly typedHandlers = new Map<ServerFrame["type"], Set<MessageHandler>>()

  constructor(options: WsClientOptions = {}) {
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory
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

    const socket = this.factory(url)
    this.socket = socket

    return new Promise((resolve, reject) => {
      let settled = false

      const settleOpen = () => {
        settled = true
        this.reconnectAttempts = 0
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
    this.socket?.close(code, reason)
  }

  join(key: string, name?: string): void {
    this.lastJoin = { key, name }
    const frame = name ? { type: FrameType.Join, key, name } : { type: FrameType.Join, key }
    this.send(frame)
  }

  sendInput(text: string): void {
    this.send({ type: FrameType.Input, text })
  }

  ping(t = Date.now()): void {
    this.send({ type: FrameType.Ping, t })
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
    if (apiKey) frame.api_key = apiKey
    if (baseUrl) frame.base_url = baseUrl
    this.send(frame)
  }

  // Ask for a provider's live model catalog. Omit args to list the current provider;
  // pass provider (+ optional apiKey/baseUrl) to preview another before switching.
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminListModelsFrame = { type: FrameType.AdminListModels }
    if (provider) frame.provider = provider
    if (apiKey) frame.api_key = apiKey
    if (baseUrl) frame.base_url = baseUrl
    this.send(frame)
  }

  adminListKeys(): void {
    this.send({ type: FrameType.AdminListKeys })
  }

  adminMintKey(room: string, name?: string, role?: PlayerRole): void {
    const frame: AdminMintKeyFrame = { type: FrameType.AdminMintKey, room }
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
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      void this.connect(this.url!)
    }, delay)
  }
}
