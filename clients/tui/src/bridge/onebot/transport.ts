import { timingSafeEqual } from "node:crypto"
import {
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_REVERSE_PATH,
  EVENT_QUEUE_LIMIT,
  HEARTBEAT_GRACE_FACTOR,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_CHARS,
  MAX_WEBSOCKET_FRAME_BYTES,
} from "./constants"
import { eventPartition, ingestEvent, RecentMessageWindow, type OneBotInbound, type OneBotSegment } from "./events"
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
  /** True once the implementation rejected the access token in-band (see `AUTH_REJECTED_RETCODE`). */
  readonly authRejected?: boolean
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

/**
 * NapCat and LLOneBot accept the WebSocket upgrade FIRST and answer a wrong access token
 * in-band — `{status:"failed", retcode:1403, …}` — then close the socket. NapCat's frame
 * carries `echo: null`; LLOneBot's has NO echo key at all (`echo: undefined` is dropped by
 * JSON.stringify). (NapCat `network/websocket-server.ts` `authorize()`, LLOneBot `connect/ws.ts`.)
 */
export const AUTH_REJECTED_RETCODE = 1403

export class ActionWebSocketTransport implements OneBotRawTransport {
  kind: "forward" | "reverse" = "forward"
  readonly requestTimeoutMs: number
  protected connection: OneBotSocket | undefined
  private _authRejected = false
  /** Armed by the first heartbeat meta event; fed by every frame; fires = half-open socket. */
  private watchdog: { timer: ReturnType<typeof setTimeout>; graceMs: number; connection: OneBotSocket } | undefined
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

  /** Sticky: set by the first in-band token rejection, consulted when a connect attempt fails. */
  get authRejected(): boolean {
    return this._authRejected
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
        this.noteFrame(payload, connection)
        // An action response carries `echo` (NapCat always, even `null`) — or, from LLOneBot's
        // token rejection, no echo at all: a `retcode` without a `post_type` is still a response.
        if ("echo" in payload || (!("post_type" in payload) && "retcode" in payload)) {
          const echo = "echo" in payload ? String(payload.echo) : undefined
          const item = echo === undefined ? undefined : this.pending.get(echo)
          if (echo !== undefined) this.pending.delete(echo)
          if (item && !item.settled) {
            item.resolve(payload)
          } else if (String(payload.status ?? "").toLowerCase() === "failed") {
            // An unmatched failure is not a stale echo: it is the implementation talking
            // to us outside any call — the wrong-token rejection above all. Dropping it
            // silently is how the bridge once reported "ready" on a bad token.
            const retcode = asInteger(payload.retcode, -1)
            if (retcode === AUTH_REJECTED_RETCODE) {
              this._authRejected = true
              console.warn("onebot.auth_rejected")
            } else {
              console.warn("onebot.unmatched_failed_response", retcode)
            }
          }
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

  /**
   * Liveness from the implementation's own heartbeat: the first `meta_event` heartbeat
   * announces its `interval` and arms a watchdog at HEARTBEAT_GRACE_FACTOR × interval;
   * every later frame re-arms it. When it fires the socket is half-open (NAT timeout,
   * host asleep) — close it so the forward loop redials / the reverse accept ends. An
   * implementation with heartbeats off never arms it.
   */
  private noteFrame(payload: Record<string, unknown>, connection: OneBotSocket): void {
    // A frame still draining from a replaced socket must not touch the live watchdog.
    if (this.connection !== connection) return
    const isHeartbeat = payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat"
    if (isHeartbeat) {
      const interval = asInteger(payload.interval, 0)
      if (interval > 0) {
        this.clearWatchdog(connection)
        this.watchdog = { timer: this.watchdogTimer(connection, interval * HEARTBEAT_GRACE_FACTOR), graceMs: interval * HEARTBEAT_GRACE_FACTOR, connection }
        return
      }
    }
    const armed = this.watchdog
    if (!armed || armed.connection !== connection) return
    clearTimeout(armed.timer)
    armed.timer = this.watchdogTimer(connection, armed.graceMs)
  }

  private watchdogTimer(connection: OneBotSocket, graceMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.connection !== connection) return
      console.warn("onebot.heartbeat_lost", Math.round(graceMs))
      try {
        void Promise.resolve(connection.close(1001, "heartbeat lost")).catch(() => {})
      } catch {
        // a synchronous throw from a custom socket must not escape a timer callback
      }
      this.detach(connection)
    }, graceMs)
  }

  private clearWatchdog(connection: OneBotSocket): void {
    if (this.watchdog && this.watchdog.connection === connection) {
      clearTimeout(this.watchdog.timer)
      this.watchdog = undefined
    }
  }

  protected attach(connection: OneBotSocket): OneBotSocket | undefined {
    const previous = this.connection
    if (previous !== undefined && previous !== connection) this.detach(previous)
    this.connection = connection
    // A new connection is a new verdict: the flag describes THIS socket's rejection only,
    // and any watchdog still armed for an older socket is dead weight.
    this._authRejected = false
    if (this.watchdog) {
      clearTimeout(this.watchdog.timer)
      this.watchdog = undefined
    }
    this.connectedGate.open()
    this.emitStatus("online")
    return previous !== undefined && previous !== connection ? previous : undefined
  }

  protected detach(connection: OneBotSocket): void {
    if (this.connection !== connection) return
    this.clearWatchdog(connection)
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
  private lastLostLogAt = -Infinity
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
    // A dial that completed between the snapshot above and the runner's exit may have
    // attached a newer socket; re-read rather than trust the snapshot.
    const late = this.connection
    if (late && late !== connection) {
      try {
        await Promise.resolve(late.close())
      } catch {
        // ignore
      }
      this.detach(late)
    }
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
        if (this.closing || signal.aborted) {
          // close() ran while this dial was in flight: a socket attached now would sit in
          // consume() forever and close() would never return. Drop it unattached.
          try {
            await Promise.resolve(connection.close())
          } catch {
            // best-effort
          }
          return
        }
        this.attach(connection)
        await this.consume(connection)
      } catch (err) {
        if (this.closing || signal.aborted) return
        // One dial per reconnect_delay while the implementation is down (a restart, a QR
        // re-login): a line per dial was 60 a minute. docs/qq.md promises one a minute.
        const at = Date.now()
        if (at - this.lastLostLogAt >= LOST_LOG_EVERY_MS) {
          this.lastLostLogAt = at
          console.warn("onebot.forward_connection_lost", errorName(err))
        }
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

const LOST_LOG_EVERY_MS = 60_000

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

const MEMBER_POSITIVE_CACHE_MS = 10 * 60 * 1000

export interface OneBotLoginInfo {
  userId: string
  nickname: string
}
export type LoginHandler = (info: OneBotLoginInfo) => void

/** Why the last `connect()` returned false — stable machine codes, never user copy. */
export type OneBotConnectError = "onebot.websocket.connect_timeout" | "onebot.auth_rejected" | "onebot.self_check_failed"

export class OneBotTransport {
  private readonly inner: OneBotRawTransport | undefined
  private readonly window = new RecentMessageWindow()
  private readonly messageHandlers = new Set<MessageHandler>()
  private readonly statusHandlers = new Set<StatusHandler>()
  private readonly loginHandlers = new Set<LoginHandler>()
  private readonly selfCheckHandlers = new Set<(code: OneBotConnectError) => void>()
  private readonly fetchDeps: FetchDeps
  private readonly attachmentTimeoutMs: number
  private readonly memberPositiveUntil = new Map<string, number>()
  private _lastLogin: OneBotLoginInfo | undefined
  private _lastConnectError: OneBotConnectError | undefined
  /** `self_id` of the latest inbound event — the bot's own account when no login answered yet. */
  private lastSelfId: string | undefined
  private ready = false

  constructor(options: OneBotTransportOptions = {}) {
    this.inner = options.transport ?? buildOneBotTransport(options)
    this.fetchDeps = { httpGet: options.httpGet, resolveAddresses: options.resolveAddresses }
    this.attachmentTimeoutMs =
      finiteTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { allowZero: false }) ??
      DEFAULT_REQUEST_TIMEOUT_MS
    if (this.inner && "onStatus" in this.inner && typeof this.inner.onStatus === "function") {
      this.inner.onStatus((status) => {
        this.emitStatus(status)
        // Every later (re)connection — a forward redial, a reverse accept — re-runs the
        // identity check so the log says which account answered. Startup runs it
        // explicitly inside connect(), which is what `ready` gates.
        if (status === "online" && this.ready) void this.loginInfo().catch((err) => this.reportSelfCheckFailure(err))
      })
    }
  }

  get connected(): boolean {
    return this.inner?.connected ?? false
  }

  /** The account behind the last successful `get_login_info`. */
  get lastLogin(): OneBotLoginInfo | undefined {
    return this._lastLogin
  }

  get lastConnectError(): OneBotConnectError | undefined {
    return this._lastConnectError
  }

  onLogin(handler: LoginHandler): () => void {
    this.loginHandlers.add(handler)
    return () => {
      this.loginHandlers.delete(handler)
    }
  }

  /** Fires when a post-startup self-check fails: `onebot.auth_rejected` or `onebot.self_check_failed`. */
  onSelfCheckFailed(handler: (code: OneBotConnectError) => void): () => void {
    this.selfCheckHandlers.add(handler)
    return () => {
      this.selfCheckHandlers.delete(handler)
    }
  }

  /**
   * `get_login_info` — the one call made on every connection. A wrong token never fails
   * the upgrade (NapCat / LLOneBot reject in-band, then close), so this is what proves
   * the token was accepted and says which QQ account is on the other side.
   */
  async loginInfo(): Promise<OneBotLoginInfo> {
    if (!this.inner) throw new OneBotError("onebot.transport.unavailable")
    const data = await this.inner.call("get_login_info", {})
    const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
    const info: OneBotLoginInfo = { userId: stringId(record.user_id) ?? "", nickname: String(record.nickname ?? "") }
    this._lastLogin = info
    for (const handler of this.loginHandlers) {
      try {
        handler(info)
      } catch {
        // a throwing subscriber must not fail the check
      }
    }
    return info
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

  /**
   * Forward mode: true only after the socket is open AND `get_login_info` answered —
   * an open socket alone proves nothing, because a rejected token still upgrades.
   * Reverse mode: true once the listener is up; the check runs on each accept.
   */
  async connect(): Promise<boolean> {
    if (!this.inner) return false
    this._lastConnectError = undefined
    this.emitStatus("connecting")
    await this.inner.start(async (payload) => {
      if (payload.self_id !== undefined && payload.self_id !== null) this.lastSelfId = String(payload.self_id)
      const inbound = ingestEvent(payload, this.window)
      if (!inbound) return
      await this.dispatchMessage(inbound)
    })
    if (this.inner.kind === "forward") {
      try {
        await this.inner.waitConnected(this.inner.requestTimeoutMs)
      } catch {
        return this.failConnect("onebot.websocket.connect_timeout")
      }
      try {
        await this.loginInfo()
      } catch (err) {
        return this.failConnect(this.inner.authRejected ? "onebot.auth_rejected" : "onebot.self_check_failed", err)
      }
    }
    this.ready = true
    return true
  }

  private async failConnect(code: OneBotConnectError, err?: unknown): Promise<false> {
    this._lastConnectError = code
    console.warn("onebot.connect_failed", code, err === undefined ? "" : errorName(err))
    try {
      // inner.close() emits the single "offline" through the status hook.
      await this.inner?.close()
    } catch {
      // the outcome is already decided
    }
    return false
  }

  /** A self-check failed after startup (a forward redial or a reverse accept). */
  private reportSelfCheckFailure(err: unknown): void {
    const code: OneBotConnectError = this.inner?.authRejected ? "onebot.auth_rejected" : "onebot.self_check_failed"
    console.warn("onebot.self_check_failed", code, errorName(err))
    for (const handler of this.selfCheckHandlers) {
      try {
        handler(code)
      } catch {
        // a throwing subscriber must not break the hook
      }
    }
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
    // A redirected private reply carries the group it came from: NapCat then uses the
    // group temp session when the two are not friends (SendMsg.ts createContext), and
    // plain friend chat when they are. The caller has confirmed membership first —
    // NapCat would otherwise fall back to posting INTO the group when it cannot resolve
    // the user, which is exactly the leak the private redirect exists to prevent.
    const privateParams = (): Record<string, unknown> =>
      privateTarget
        ? { user_id: protocolId(target.userId), group_id: protocolId(target.id) }
        : { user_id: protocolId(target.id) }
    if (chunks.length > 1) return this.sendForward(target, asPrivate, privateParams, chunks, content)
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
        ? { ...privateParams(), message: segments }
        : { group_id: protocolId(target.id), message: segments }
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

  /**
   * Text that needs more than one message goes out as ONE merged-forward card
   * (`send_group_forward_msg` / `send_private_forward_msg`): one `node` per chunk, the
   * image on the last node, every node signed as the bot's own account. A card cannot
   * carry `reply` or `at`, so those are dropped here — the card is the reply.
   */
  private async sendForward(
    target: ChatTarget,
    asPrivate: boolean,
    privateParams: () => Record<string, unknown>,
    chunks: string[],
    content: OutboundContent,
  ): Promise<OneBotSendResult> {
    if (!this.inner) return { ok: false, error: "onebot.transport.unavailable" }
    // Signed as the bot: the login info when the self-check answered, else the self_id every
    // inbound event carries. `time` is seconds — NapCat's own default for a missing value
    // is Date.now() in milliseconds, which lands in a seconds field.
    const selfId = this._lastLogin?.userId || this.lastSelfId
    const sender: Record<string, unknown> = { time: Math.floor(Date.now() / 1000) }
    if (selfId) sender.user_id = protocolId(selfId)
    if (this._lastLogin?.nickname) sender.nickname = this._lastLogin.nickname
    const nodes: OneBotSegment[] = []
    for (let index = 0; index < chunks.length; index += 1) {
      const lastPart = index === chunks.length - 1
      let segments: OneBotSegment[]
      try {
        segments = buildOutboundSegments({ text: chunks[index], image: lastPart ? content.image : undefined })
      } catch (err) {
        console.warn("onebot.message_encode_failed", errorName(err))
        return { ok: false, error: sendErrorCode(err) }
      }
      if (segments.length) nodes.push({ type: "node", data: { ...sender, content: segments } })
    }
    if (!nodes.length) return { ok: false, error: "onebot.message.empty" }
    const action = asPrivate ? "send_private_forward_msg" : "send_group_forward_msg"
    const params: Record<string, unknown> = asPrivate
      ? { ...privateParams(), messages: nodes }
      : { group_id: protocolId(target.id), messages: nodes }
    try {
      const data = await this.inner.call(action, params)
      return { ok: true, ...(messageIdOf(data) ? { messageId: messageIdOf(data) } : {}) }
    } catch (err) {
      console.warn("onebot.send_failed", errorName(err))
      return { ok: false, error: sendErrorCode(err) }
    }
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

  /**
   * True when OneBot reports this QQ user is in the group. Any error (missing
   * member, timeout, disconnected) is false. Positive answers are cached 10 minutes.
   */
  async isGroupMember(groupId: string | number, userId: string | number): Promise<boolean> {
    return (await this.memberStatus(groupId, userId)) === "member"
  }

  /**
   * `member`: the implementation answered `get_group_member_info` with data.
   * `not_member`: it answered with an error (NapCat: retcode 1200 for an unknown member).
   * `unknown`: no usable answer — timeout, socket down, transport unavailable.
   * With `fresh: true` the positive cache is bypassed (still refreshed on success): the
   * private-reply gate must decide on a live answer, never on a 10-minute-old one.
   */
  async memberStatus(
    groupId: string | number,
    userId: string | number,
    opts: { fresh?: boolean; timeoutMs?: number } = {},
  ): Promise<"member" | "not_member" | "unknown"> {
    const cacheKey = `${stringId(groupId)}\0${stringId(userId)}`
    const now = Date.now()
    if (!opts.fresh) {
      const cached = this.memberPositiveUntil.get(cacheKey)
      if (cached !== undefined && cached > now) return "member"
    }
    if (!this.inner) return "unknown"
    try {
      const call = this.inner.call("get_group_member_info", {
        group_id: protocolId(groupId),
        user_id: protocolId(userId),
      })
      await (opts.timeoutMs !== undefined ? withTimeout(call, opts.timeoutMs, "onebot.member_check.timeout") : call)
      this.memberPositiveUntil.set(cacheKey, now + MEMBER_POSITIVE_CACHE_MS)
      return "member"
    } catch (err) {
      if (err instanceof OneBotAPIError) return "not_member"
      return "unknown"
    }
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

/**
 * Every refusal names its reason — as a stable `onebot.reverse.*` code in the response
 * body and in one warn line here — because the implementation's own log only ever says
 * "Expected 101 status code". Token values are never logged.
 */
export function reverseHandshakeResponse(
  req: { url: string; headers: Headers },
  opts: { path: string; accessToken: string },
): Response | null {
  let path: string
  let tokenInQuery = false
  try {
    const parsed = new URL(req.url)
    path = parsed.pathname
    tokenInQuery = parsed.searchParams.has("access_token")
  } catch {
    path = req.url.split("?")[0] ?? ""
    tokenInQuery = (req.url.split("?")[1] ?? "").includes("access_token=")
  }
  if (path !== opts.path) {
    const code = "onebot.reverse.rejected.path"
    console.warn(code, path, "expected", opts.path)
    return new Response(code, { status: 404 })
  }
  const authorization = req.headers.get("Authorization") ?? ""
  if (opts.accessToken && !bearerMatches(authorization, opts.accessToken)) {
    // The bridge reads ONLY the `Authorization: Bearer` header, which is what NapCat and
    // LLOneBot send from their `token` field; a token pasted into the URL query arrives
    // here as an EMPTY `Bearer ` header. A non-empty bearer that does not match is simply
    // wrong, whatever the query says.
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : ""
    const code = bearer
      ? "onebot.reverse.rejected.wrong_token"
      : tokenInQuery
        ? "onebot.reverse.rejected.token_in_query"
        : "onebot.reverse.rejected.missing_authorization"
    console.warn(code)
    return new Response(code, { status: 401 })
  }
  const role = (req.headers.get("X-Client-Role") ?? "").toLowerCase()
  if (role && role !== "universal") {
    const code = "onebot.reverse.rejected.role"
    console.warn(code, role)
    return new Response(code, { status: 400 })
  }
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
