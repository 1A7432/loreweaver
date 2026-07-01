import { FrameType, type ClientFrame, type PingFrame, type PongFrame, type ServerFrame } from "./types"

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

const serverFrameTypes = new Set<string>([
  FrameType.Welcome,
  FrameType.Error,
  FrameType.Narrative,
  FrameType.Dice,
  FrameType.State,
  FrameType.Presence,
  FrameType.System,
  FrameType.Pong,
])

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

function isServerFrame(value: unknown): value is ServerFrame {
  return Boolean(value && typeof value === "object" && serverFrameTypes.has(String((value as { type?: unknown }).type)))
}

function isPingFrame(value: unknown): value is PingFrame {
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
    const parsed = JSON.parse(toText(data)) as unknown
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

