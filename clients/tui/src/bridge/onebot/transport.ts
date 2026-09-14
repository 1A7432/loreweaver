import { timingSafeEqual } from "node:crypto"
import {
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_REVERSE_PATH,
  EVENT_QUEUE_LIMIT,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_CHARS,
  MAX_WEBSOCKET_FRAME_BYTES,
} from "./constants"
import { eventPartition, ingestEvent, RecentMessageWindow, type OneBotInbound } from "./events"
import { fetchAttachment, type FetchDeps } from "./fetch"
import { buildOutboundSegments, splitText, type OutboundContent } from "./segments"
import {
  asInteger,
  errorName,
  finiteTimeout,
  isLoopbackHost,
  jsonObject,
  normalizePath,
  OneBotAPIError,
  OneBotAttachmentNotFound,
  OneBotError,
  protocolId,
  sendErrorCode,
  sleep,
  stringId,
  validWsUrl,
  withTimeout,
} from "./shared"

export type OneBotStatus = "connecting" | "online" | "reconnecting" | "offline"
export type EventHandler = (payload: Record<string, unknown>) => void | Promise<void>
export type StatusHandler = (status: OneBotStatus) => void
export type MessageHandler = (message: OneBotInbound) => void | Promise<void>

export interface OneBotSocket {
  send(data: string): void | Promise<void>
  close(code?: number, reason?: string): void | Promise<void>
  [Symbol.asyncIterator](): AsyncIterator<string>
}

export type ConnectFactory = (
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number; maxSize: number },
) => Promise<OneBotSocket>

export interface ChatTarget {
  type: "group" | "private"
  id: string | number
  userId?: string | number
}

export interface OneBotSendResult {
  ok: boolean
  messageId?: string
  error?: string
}

export interface OneBotRawTransport {
  readonly kind: "forward" | "reverse"
  readonly connected: boolean
  readonly pendingCount: number
  readonly pendingEvents: number
  readonly requestTimeoutMs: number
  start(handler: EventHandler): Promise<void>
  close(): Promise<void>
  call(action: string, params: Record<string, unknown>): Promise<unknown>
  waitConnected?(timeoutMs?: number): Promise<void>
  queueEvent?(payload: Record<string, unknown>): boolean
  consume?(connection: OneBotSocket): Promise<void>
  onStatus?(handler: StatusHandler): void
}

export interface OneBotTransportOptions extends FetchDeps {
  mode?: "forward" | "reverse" | "client" | "server"
  wsUrl?: string
  listenHost?: string
  listenPort?: number
  path?: string
  accessToken?: string
  requestTimeoutMs?: number
  reconnectDelayMs?: number
  connectFactory?: ConnectFactory
  transport?: OneBotRawTransport
}

class MessageBuffer {
  private readonly queue: string[] = []
  private waiter?: (result: IteratorResult<string>) => void
  private closed = false

  push(data: string): void {
    if (this.closed) return
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value: data, done: false })
    } else {
      this.queue.push(data)
    }
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<string>> {
    if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => this.next(),
    }
  }
}

class WebSocketClientSocket implements OneBotSocket {
  private readonly buffer = new MessageBuffer()

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      this.buffer.push(socketDataToString(event.data))
    })
    ws.addEventListener("close", () => this.buffer.end())
    ws.addEventListener("error", () => this.buffer.end())
  }

  send(data: string): void {
    this.ws.send(data)
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(code, reason)
    } catch {
      // already gone
    }
    this.buffer.end()
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return this.buffer[Symbol.asyncIterator]()
  }
}

class ServerWebSocketSocket implements OneBotSocket {
  private readonly buffer = new MessageBuffer()

  constructor(private readonly ws: { send(data: string | ArrayBufferLike): void; close(code?: number, reason?: string): void }) {}

  send(data: string): void {
    this.ws.send(data)
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(code, reason)
    } catch {
      // already gone
    }
    this.buffer.end()
  }

  push(data: string): void {
    this.buffer.push(data)
  }

  end(): void {
    this.buffer.end()
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return this.buffer[Symbol.asyncIterator]()
  }
}

interface PendingCall {
  settled: boolean
  resolve: (value: Record<string, unknown>) => void
  reject: (err: unknown) => void
}

interface WorkerHandle {
  done: boolean
  promise: Promise<void>
}

class Latch {
  private resolvers: Array<() => void> = []
  private isSet = false

  open(): void {
    this.isSet = true
    const waiting = this.resolvers
    this.resolvers = []
    for (const resolve of waiting) resolve()
  }

  close(): void {
    this.isSet = false
  }

  wait(): Promise<void> {
    if (this.isSet) return Promise.resolve()
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }
}

export class ActionWebSocketTransport implements OneBotRawTransport {
  kind: "forward" | "reverse" = "forward"
  readonly requestTimeoutMs: number
  protected connection: OneBotSocket | undefined
  private readonly pending = new Map<string, PendingCall>()
  private sequence = 1
  private readonly writeChains = new WeakMap<object, Promise<void>>()
  private readonly writeWaiters = new WeakMap<object, Array<(err: unknown) => void>>()
  private readonly connectedGate = new Latch()
  private eventHandler: EventHandler | undefined
  private readonly eventQueues = new Map<string, Array<Record<string, unknown>>>()
  private readonly eventWorkers = new Map<string, WorkerHandle>()
  private _pendingEvents = 0
  private dispatcherGeneration = 0
  private dispatcherAbort = new Promise<void>(() => {})
  private abortDispatcher: () => void = () => {}
  protected statusHandler: StatusHandler | undefined

  constructor(requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const timeout = finiteTimeout(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { allowZero: false })
    if (timeout === null) throw new OneBotError("onebot.request_timeout.invalid")
    this.requestTimeoutMs = timeout
    this.resetDispatcherAbort()
  }

  get connected(): boolean {
    return this.connection !== undefined
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get pendingEvents(): number {
    return this._pendingEvents
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler
  }

  async waitConnected(timeoutMs = this.requestTimeoutMs): Promise<void> {
    await withTimeout(this.connectedGate.wait(), timeoutMs, "onebot.websocket.connect_timeout")
  }

  /** Bind a live socket (tests and reverse accept). Starts no reader — call `consume` separately. */
  adopt(connection: OneBotSocket): OneBotSocket | undefined {
    return this.attach(connection)
  }

  async call(action: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = this.connection
    if (!connection) throw new OneBotError("onebot.websocket.not_connected")

    const echo = `loreweaver-${this.sequence}`
    this.sequence += 1
    const pending: PendingCall = {
      settled: false,
      resolve: () => {},
      reject: () => {},
    }
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.resolve = (value) => {
        pending.settled = true
        resolve(value)
      }
      pending.reject = (err) => {
        pending.settled = true
        reject(err)
      }
    })
    void response.catch(() => {})
    this.pending.set(echo, pending)
    const payload = JSON.stringify({ action, params, echo })
    try {
      await this.enqueueWrite(connection, payload)
      const body = await withTimeout(response, this.requestTimeoutMs)
      const status = String(body.status ?? "").toLowerCase()
      const retcode = asInteger(body.retcode, -1)
      if (status !== "ok" || retcode !== 0) {
        throw new OneBotAPIError(retcode, String(body.wording ?? body.message ?? ""))
      }
      return body.data
    } catch (err) {
      const item = this.pending.get(echo)
      this.pending.delete(echo)
      if (item && !item.settled) item.settled = true
      throw err
    }
  }

  async consume(connection: OneBotSocket): Promise<void> {
    try {
      for await (const raw of connection) {
        if (Buffer.byteLength(raw, "utf8") > MAX_WEBSOCKET_FRAME_BYTES) {
          try {
            await Promise.resolve(connection.close(1009, "frame too large"))
          } catch {
            // best-effort — the point is we did not accept an oversized frame
          }
          return
        }
        const payload = jsonObject(raw)
        if (!payload) continue
        if ("echo" in payload) {
          const echo = String(payload.echo)
          const item = this.pending.get(echo)
          this.pending.delete(echo)
          if (item && !item.settled) item.resolve(payload)
          continue
        }
        if (!this.queueEvent(payload)) {
          try {
            await Promise.resolve(connection.close(1013, "event backlog exhausted"))
          } catch {
            // closing is best-effort — the point is we did not drop silently
          }
          return
        }
      }
    } finally {
      this.detach(connection)
    }
  }

  startDispatcher(handler: EventHandler): void {
    this.eventHandler = handler
  }

  async stopDispatcher(): Promise<void> {
    this.dispatcherGeneration += 1
    this.eventHandler = undefined
    this.abortDispatcher()
    this.resetDispatcherAbort()
    const workers = [...this.eventWorkers.values()].map((handle) => handle.promise)
    if (workers.length) await Promise.allSettled(workers)
    this.eventWorkers.clear()
    this.eventQueues.clear()
    this._pendingEvents = 0
  }

  queueEvent(payload: Record<string, unknown>): boolean {
    if (!this.eventHandler || this._pendingEvents >= EVENT_QUEUE_LIMIT) return false
    const key = eventPartition(payload)
    let queue = this.eventQueues.get(key)
    if (!queue) {
      queue = []
      this.eventQueues.set(key, queue)
    }
    queue.push(payload)
    this._pendingEvents += 1
    const worker = this.eventWorkers.get(key)
    if (!worker || worker.done) {
      const handle: WorkerHandle = { done: false, promise: Promise.resolve() }
      handle.promise = this.dispatchEvents(key, queue, handle)
      this.eventWorkers.set(key, handle)
    }
    return true
  }

  protected emitStatus(status: OneBotStatus): void {
    try {
      this.statusHandler?.(status)
    } catch {
      // a throwing subscriber must not kill the reconnect loop
    }
  }

  protected attach(connection: OneBotSocket): OneBotSocket | undefined {
    const previous = this.connection
    if (previous !== undefined && previous !== connection) this.detach(previous)
    this.connection = connection
    this.connectedGate.open()
    this.emitStatus("online")
    return previous !== undefined && previous !== connection ? previous : undefined
  }

  protected detach(connection: OneBotSocket): void {
    if (this.connection !== connection) return
    this.connection = undefined
    this.connectedGate.close()
    const disconnected = new OneBotError("onebot.websocket.disconnected")
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const item of pending) {
      if (!item.settled) item.reject(disconnected)
    }
    const waiters = this.writeWaiters.get(connection)
    this.writeWaiters.delete(connection)
    if (waiters) for (const reject of waiters) reject(disconnected)
  }

  async start(_handler: EventHandler): Promise<void> {
    throw new OneBotError("onebot.transport.start.unimplemented")
  }

  async close(): Promise<void> {
    throw new OneBotError("onebot.transport.close.unimplemented")
  }

  private enqueueWrite(connection: OneBotSocket, payload: string): Promise<void> {
    const previous = this.writeChains.get(connection) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (this.connection !== connection) throw new OneBotError("onebot.websocket.disconnected")
      const abort = this.untilDetached(connection)
      void abort.promise.catch(() => {})
      try {
        await Promise.race([Promise.resolve(connection.send(payload)), abort.promise])
      } finally {
        abort.release()
      }
    })
    this.writeChains.set(
      connection,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  private untilDetached(connection: OneBotSocket): { promise: Promise<never>; release: () => void } {
    let rejecter: (err: unknown) => void = () => {}
    const promise = new Promise<never>((_, reject) => {
      rejecter = reject
      const list = this.writeWaiters.get(connection) ?? []
      list.push(reject)
      this.writeWaiters.set(connection, list)
    })
    const release = () => {
      const list = this.writeWaiters.get(connection)
      if (!list) return
      const next = list.filter((item) => item !== rejecter)
      if (next.length) this.writeWaiters.set(connection, next)
      else this.writeWaiters.delete(connection)
    }
    return { promise, release }
  }

  private async dispatchEvents(
    key: string,
    queue: Array<Record<string, unknown>>,
    handle: WorkerHandle,
  ): Promise<void> {
    const generation = this.dispatcherGeneration
    try {
      while (true) {
        if (this.dispatcherGeneration !== generation) return
        const payload = queue.shift()
        if (!payload) return
        try {
          const result = this.eventHandler?.(payload)
          if (result !== undefined && typeof (result as Promise<void>).then === "function") {
            await Promise.race([result, this.dispatcherAbort])
          }
        } catch {
          if (this.dispatcherGeneration !== generation) return
        } finally {
          this._pendingEvents -= 1
        }
      }
    } finally {
      handle.done = true
      this.eventWorkers.delete(key)
      this.eventQueues.delete(key)
    }
  }

  private resetDispatcherAbort(): void {
    this.dispatcherAbort = new Promise<void>((_, reject) => {
      this.abortDispatcher = () => reject(new OneBotError("onebot.dispatcher.stopped"))
    })
    this.dispatcherAbort.catch(() => {})
  }
}

export class OneBotForwardWebSocketTransport extends ActionWebSocketTransport {
  readonly kind = "forward" as const
  readonly url: string
  readonly accessToken: string
  readonly reconnectDelayMs: number
  private readonly connectFactory: ConnectFactory
  private runner: Promise<void> | undefined
  private closing = false
  private runAbort: AbortController | undefined

  constructor(opts: {
    url: string
    accessToken?: string
    requestTimeoutMs?: number
    reconnectDelayMs?: number
    connectFactory?: ConnectFactory
  }) {
    super(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    if (!validWsUrl(opts.url)) throw new OneBotError("onebot.websocket.url.invalid")
    const delay = finiteTimeout(opts.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS, { allowZero: true })
    if (delay === null) throw new OneBotError("onebot.reconnect_delay.invalid")
    this.url = opts.url
    this.accessToken = opts.accessToken ?? ""
    this.reconnectDelayMs = delay
    this.connectFactory = opts.connectFactory ?? defaultConnectFactory
  }

  async start(handler: EventHandler): Promise<void> {
    if (this.runner) return
    this.startDispatcher(handler)
    this.closing = false
    this.runAbort = new AbortController()
    this.emitStatus("connecting")
    this.runner = this.run(this.runAbort.signal).finally(() => {
      this.runner = undefined
    })
    await sleep(0)
  }

  async close(): Promise<void> {
    this.closing = true
    this.runAbort?.abort()
    const connection = this.connection
    if (connection) {
      try {
        await Promise.resolve(connection.close())
      } catch {
        // ignore
      }
    }
    if (this.runner) {
      try {
        await this.runner
      } catch {
        // ignore
      }
    }
    if (connection) this.detach(connection)
    this.runner = undefined
    await this.stopDispatcher()
    this.emitStatus("offline")
  }

  private async run(signal: AbortSignal): Promise<void> {
    const headers = this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : undefined
    while (!this.closing && !signal.aborted) {
      let connection: OneBotSocket | undefined
      try {
        if (!this.connected) this.emitStatus("connecting")
        connection = await this.connectFactory(this.url, {
          headers,
          timeoutMs: this.requestTimeoutMs,
          maxSize: MAX_WEBSOCKET_FRAME_BYTES,
        })
        this.attach(connection)
        await this.consume(connection)
      } catch (err) {
        if (this.closing || signal.aborted) return
        console.warn("onebot.forward_connection_lost", errorName(err))
      } finally {
        if (connection) this.detach(connection)
      }
      if (!this.closing && !signal.aborted) {
        this.emitStatus("reconnecting")
        await sleep(this.reconnectDelayMs, signal)
      }
    }
  }
}

type ReverseWsData = { adapter: ServerWebSocketSocket }

export class OneBotReverseWebSocketTransport extends ActionWebSocketTransport {
  readonly kind = "reverse" as const
  readonly host: string
  readonly port: number
  readonly path: string
  readonly accessToken: string
  private server: ReturnType<typeof Bun.serve<ReverseWsData>> | undefined

  constructor(opts: {
    host: string
    port: number
    path?: string
    accessToken?: string
    requestTimeoutMs?: number
  }) {
    super(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    if (!isLoopbackHost(opts.host) && !(opts.accessToken ?? "").trim()) {
      throw new OneBotError("onebot.reverse.public_auth_required")
    }
    this.host = opts.host
    this.port = opts.port
    this.path = normalizePath(opts.path ?? DEFAULT_REVERSE_PATH, DEFAULT_REVERSE_PATH)
    this.accessToken = opts.accessToken ?? ""
  }

  get boundPort(): number | undefined {
    return this.server?.port
  }

  async start(handler: EventHandler): Promise<void> {
    if (this.server) return
    this.startDispatcher(handler)
    this.emitStatus("connecting")
    try {
      const self = this
      this.server = Bun.serve<ReverseWsData>({
        hostname: this.host,
        port: this.port,
        fetch(req, server) {
          const denied = reverseHandshakeResponse(req, { path: self.path, accessToken: self.accessToken })
          if (denied) return denied
          if (server.upgrade(req, { data: { adapter: undefined as unknown as ServerWebSocketSocket } })) {
            return undefined as unknown as Response
          }
          return new Response("", { status: 500 })
        },
        websocket: {
          maxPayloadLength: MAX_WEBSOCKET_FRAME_BYTES,
          open(ws) {
            const adapter = new ServerWebSocketSocket(ws)
            ws.data.adapter = adapter
            void self.accept(adapter)
          },
          message(ws, message) {
            ws.data.adapter.push(socketDataToString(message))
          },
          close(ws) {
            ws.data.adapter?.end()
          },
        },
      })
    } catch (err) {
      await this.stopDispatcher()
      throw err
    }
  }

  async close(): Promise<void> {
    const connection = this.connection
    if (connection) {
      try {
        await Promise.resolve(connection.close())
      } catch {
        // ignore
      }
      this.detach(connection)
    }
    if (this.server) {
      this.server.stop(true)
      this.server = undefined
    }
    await this.stopDispatcher()
    this.emitStatus("offline")
  }

  private async accept(connection: OneBotSocket): Promise<void> {
    const previous = this.attach(connection)
    if (previous) {
      try {
        await Promise.resolve(previous.close(1012))
      } catch {
        // ignore
      }
    }
    try {
      await this.consume(connection)
    } finally {
      this.detach(connection)
      if (this.server && this.connection === undefined) this.emitStatus("reconnecting")
    }
  }
}

export class OneBotTransport {
  private readonly inner: OneBotRawTransport | undefined
  private readonly window = new RecentMessageWindow()
  private readonly messageHandlers = new Set<MessageHandler>()
  private readonly statusHandlers = new Set<StatusHandler>()
  private readonly fetchDeps: FetchDeps
  private readonly attachmentTimeoutMs: number

  constructor(options: OneBotTransportOptions = {}) {
    this.inner = options.transport ?? buildOneBotTransport(options)
    this.fetchDeps = { httpGet: options.httpGet, resolveAddresses: options.resolveAddresses }
    this.attachmentTimeoutMs =
      finiteTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { allowZero: false }) ??
      DEFAULT_REQUEST_TIMEOUT_MS
    if (this.inner && "onStatus" in this.inner && typeof this.inner.onStatus === "function") {
      this.inner.onStatus((status) => this.emitStatus(status))
    }
  }

  get connected(): boolean {
    return this.inner?.connected ?? false
  }

  get pendingCount(): number {
    return this.inner?.pendingCount ?? 0
  }

  get raw(): OneBotRawTransport | undefined {
    return this.inner
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => {
      this.statusHandlers.delete(handler)
    }
  }

  async connect(): Promise<boolean> {
    if (!this.inner) return false
    this.emitStatus("connecting")
    await this.inner.start(async (payload) => {
      const inbound = ingestEvent(payload, this.window)
      if (!inbound) return
      await this.dispatchMessage(inbound)
    })
    if (this.inner.kind === "forward") {
      try {
        await this.inner.waitConnected(this.inner.requestTimeoutMs)
      } catch {
        await this.inner.close()
        this.emitStatus("offline")
        return false
      }
    }
    return true
  }

  async close(): Promise<void> {
    if (this.inner) await this.inner.close()
  }

  async send(target: ChatTarget, content: OutboundContent & { private?: boolean }): Promise<OneBotSendResult> {
    if (!this.inner) return { ok: false, error: "onebot.transport.unavailable" }
    const privateTarget = Boolean(content.private) && target.userId !== undefined
    if (content.private && !privateTarget && target.type !== "private") {
      return { ok: false, error: "onebot.private_target.unavailable" }
    }
    const asPrivate = target.type === "private" || privateTarget
    // A group message id is not valid in the private conversation used for a
    // redirected private reply. A reply that is already in a private chat keeps its segment.
    const replyTo = privateTarget ? undefined : content.replyTo
    const text = content.text ?? ""
    const chunks = text ? splitText(text, MAX_TEXT_CHARS) : [""]
    let last: OneBotSendResult = { ok: false, error: "onebot.message.empty" }
    for (let index = 0; index < chunks.length; index += 1) {
      const lastPart = index === chunks.length - 1
      let segments
      try {
        segments = buildOutboundSegments({
          text: chunks[index],
          replyTo,
          at: index === 0 ? content.at : undefined,
          image: lastPart ? content.image : undefined,
        })
      } catch (err) {
        console.warn("onebot.message_encode_failed", errorName(err))
        return { ok: false, error: sendErrorCode(err) }
      }
      if (!segments.length) {
        if (lastPart) return last.ok ? last : { ok: false, error: "onebot.message.empty" }
        continue
      }
      const action = asPrivate ? "send_private_msg" : "send_group_msg"
      const params: Record<string, unknown> = asPrivate
        ? {
            user_id: protocolId(target.type === "private" ? target.id : target.userId),
            message: segments,
          }
        : {
            group_id: protocolId(target.id),
            message: segments,
          }
      try {
        const data = await this.inner.call(action, params)
        last = { ok: true, ...(messageIdOf(data) ? { messageId: messageIdOf(data) } : {}) }
      } catch (err) {
        console.warn("onebot.send_failed", errorName(err))
        return { ok: false, error: sendErrorCode(err) }
      }
    }
    return last
  }

  sendText(
    target: ChatTarget,
    text: string,
    opts: { replyTo?: string; private?: boolean; at?: Array<string | number> } = {},
  ): Promise<OneBotSendResult> {
    return this.send(target, { text, ...opts })
  }

  sendReply(target: ChatTarget, replyTo: string, text: string): Promise<OneBotSendResult> {
    return this.send(target, { text, replyTo })
  }

  sendImage(
    target: ChatTarget,
    image: { data: Uint8Array; mime?: string } | { url: string; mime?: string },
    opts: { text?: string; replyTo?: string } = {},
  ): Promise<OneBotSendResult> {
    return this.send(target, { image, ...opts })
  }

  sendAt(target: ChatTarget, qq: string | number, text?: string, opts: { replyTo?: string } = {}): Promise<OneBotSendResult> {
    return this.send(target, { text, at: [qq], ...opts })
  }

  async fetchAttachment(
    attachment: { id?: string; name?: string; url?: string; data?: Uint8Array; size?: number },
    opts: { maxBytes?: number } = {},
  ): Promise<Uint8Array> {
    if (attachment.data) {
      const limit = opts.maxBytes !== undefined ? Math.min(MAX_ATTACHMENT_BYTES, opts.maxBytes) : MAX_ATTACHMENT_BYTES
      if (attachment.data.byteLength > limit) throw new OneBotError("onebot.attachment.too_large")
      return attachment.data
    }
    if (!attachment.url) throw new OneBotAttachmentNotFound(attachment.id || attachment.name || "")
    return fetchAttachment(attachment.url, {
      ...this.fetchDeps,
      maxBytes: opts.maxBytes,
      timeoutMs: this.attachmentTimeoutMs,
      id: attachment.id || attachment.name,
      size: attachment.size,
    })
  }

  ingest(event: Record<string, unknown>): OneBotInbound | null {
    return ingestEvent(event, this.window)
  }

  private async dispatchMessage(message: OneBotInbound): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler(message)
    }
  }

  private emitStatus(status: OneBotStatus): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(status)
      } catch {
        // a throwing subscriber must not kill status fan-out or the reconnect loop
      }
    }
  }
}

export function buildOneBotTransport(options: OneBotTransportOptions): OneBotRawTransport | undefined {
  const mode = (options.mode ?? (options.wsUrl ? "forward" : "reverse")).toLowerCase()
  const requestTimeoutMs = finiteTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { allowZero: false })
  if (requestTimeoutMs === null) return undefined
  const accessToken = options.accessToken ?? ""

  if (mode === "forward" || mode === "client") {
    const url = options.wsUrl ?? ""
    if (!validWsUrl(url)) return undefined
    const reconnectDelayMs = finiteTimeout(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS, { allowZero: true })
    if (reconnectDelayMs === null) return undefined
    return new OneBotForwardWebSocketTransport({
      url,
      accessToken,
      requestTimeoutMs,
      reconnectDelayMs,
      connectFactory: options.connectFactory,
    })
  }
  if (mode !== "reverse" && mode !== "server") return undefined
  const port = options.listenPort ?? 0
  if (!(port > 0 && port <= 65535)) return undefined
  const host = options.listenHost ?? "127.0.0.1"
  if (!host.trim()) return undefined
  if (!isLoopbackHost(host) && !accessToken.trim()) return undefined
  return new OneBotReverseWebSocketTransport({
    host,
    port,
    path: options.path,
    accessToken,
    requestTimeoutMs,
  })
}

export function reverseHandshakeResponse(
  req: { url: string; headers: Headers },
  opts: { path: string; accessToken: string },
): Response | null {
  let path: string
  try {
    path = new URL(req.url).pathname
  } catch {
    path = (req.url.split("?")[0] ?? "")
  }
  if (path !== opts.path) return new Response("", { status: 404 })
  const authorization = req.headers.get("Authorization") ?? ""
  if (opts.accessToken && !bearerMatches(authorization, opts.accessToken)) {
    return new Response("", { status: 401 })
  }
  const role = (req.headers.get("X-Client-Role") ?? "").toLowerCase()
  if (role && role !== "universal") return new Response("", { status: 400 })
  return null
}

export function bearerMatches(header: string, token: string): boolean {
  if (!token) return true
  const expected = `Bearer ${token}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function defaultConnectFactory(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number; maxSize: number },
): Promise<OneBotSocket> {
  // Bun's WebSocket client cannot pre-bound inbound frames (no maxPayloadLength).
  // consume() closes with 1009 when a message exceeds MAX_WEBSOCKET_FRAME_BYTES.
  void opts.maxSize
  const ws = new BunWebSocket(url, opts.headers ? { headers: opts.headers } : undefined)
  await waitWebSocketOpen(ws, opts.timeoutMs)
  return new WebSocketClientSocket(ws)
}

type BunWebSocketInit = { headers?: Record<string, string> }
const BunWebSocket = WebSocket as unknown as new (url: string, opts?: BunWebSocketInit) => WebSocket

function waitWebSocketOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new OneBotError("onebot.websocket.connect_timeout"))
    }, timeoutMs)
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        reject(new OneBotError("onebot.websocket.connect_failed"))
      },
      { once: true },
    )
  })
}

function socketDataToString(data: unknown): string {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf8")
  return String(data)
}

function messageIdOf(data: unknown): string | undefined {
  let current: unknown = data
  if (current && typeof current === "object" && current !== null && "data" in current) {
    const nested = (current as { data: unknown }).data
    if (nested && typeof nested === "object") current = nested
  }
  if (current && typeof current === "object" && current !== null && "message_id" in current) {
    return stringId((current as { message_id: unknown }).message_id)
  }
  return undefined
}

export {
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_REVERSE_PATH,
  EVENT_QUEUE_LIMIT,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_CHARS,
  MAX_WEBSOCKET_FRAME_BYTES,
}
