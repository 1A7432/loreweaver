import { createHash } from "node:crypto"
import {
  CLOSE_NEW_SESSION,
  CLOSE_TOKEN_INVALID,
  DEFAULT_API_BASE,
  DEFAULT_AUTH_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPLOAD_BLOCK_SIZE,
  GATEWAY_OP,
  GROUP_AND_C2C_EVENT,
  INVALID_SESSION_JITTER_MAX_MS,
  INVALID_SESSION_JITTER_MIN_MS,
  MD5_10M_BYTES,
  MIN_REQUEST_TIMEOUT_MS,
  RECONNECT_BACKOFF_CAP_MS,
  RECONNECT_BACKOFF_MS,
  TOKEN_REFRESH_FLOOR_MS,
  TOKEN_REFRESH_MARGIN_S,
  UPLOAD_PART_TIMEOUT_BASE_MS,
  UPLOAD_PART_TIMEOUT_PER_MIB_MS,
} from "./constants"
import {
  ingestDispatch,
  parseGatewayPayload,
  RecentEventWindow,
  type GatewayPayload,
  type QQBotEvent,
} from "./events"
import {
  asInteger,
  defaultInvalidSessionJitterMs,
  errorName,
  finiteTimeout,
  headerTraceId,
  joinUrl,
  jsonObject,
  nextBackoffMs,
  parseExpiresIn,
  parseRetryAfterMs,
  QQBotApiError,
  realClock,
  stringId,
  tokenRefreshDelayMs,
  uploadPartTimeoutMs,
  withTimeout,
  type QQBotClock,
} from "./shared"

export type QQBotStatus = "connecting" | "online" | "reconnecting" | "offline"
export type EventHandler = (event: QQBotEvent) => void | Promise<void>
export type StatusHandler = (status: QQBotStatus) => void

export interface QQBotFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array | ArrayBuffer
  signal?: AbortSignal
}

export interface QQBotFetchResponse {
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export type QQBotFetchImpl = (url: string, init: QQBotFetchInit) => Promise<QQBotFetchResponse>
export type QQBotWsFactory = (url: string) => WebSocket | Promise<WebSocket>

export interface QQBotTransportOptions {
  appId: string
  clientSecret: string
  transport: "websocket"
  receiveAll: boolean
  apiBase?: string
  authBase?: string
  requestTimeoutMs?: number
  fetchImpl?: QQBotFetchImpl
  wsFactory?: QQBotWsFactory
  /** Test seam: wall clock + delay. Production uses Date.now / setTimeout. */
  clock?: QQBotClock
  /** Test seam: extra delay after op 9. Production is 1–5 s. */
  invalidSessionJitterMs?: () => number
}

export interface QQBotLoginInfo {
  appId: string
  botOpenid?: string
  username?: string
}

export interface QQBotSendRequest {
  target: string
  msgType: 0 | 2 | 7
  content?: string
  markdown?: { content: string }
  media?: { fileInfo: string }
  msgId?: string
  eventId?: string
  msgSeq: number
}

export type QQBotSendResult =
  | { ok: true; id?: string; timestamp?: string; auditId?: string }
  | {
      ok: false
      code: string
      message: string
      httpStatus: number
      retryAfterMs?: number
      platformCode?: number
    }

export type QQBotUploadRequest = {
  fileType: number
  fileName?: string
  bytes?: Uint8Array
  url?: string
}

export interface QQBotUploadResult {
  fileInfo: string
  ttl: number
  fileUuid?: string
  rawUrl?: string
}

const ANCHOR_DEAD = new Set([40034128, 40034005, 304027, 304103, 40034024, 40034025, 40034026, 40034027])
const TOO_LONG = new Set([40054007, 40054018])
const MARKDOWN_REFUSED = new Set([304036, 40034127, 40034008, 40034009, 40034010, 40034011, 40034124])
const NOT_IN_GROUP = new Set([40054003, 40034101])

/** Close-code policy from spec §5 / botpy. Bun remaps 9001/9005 to 1002 on real sockets; tests drive this directly. */
export function sessionPolicyForClose(code: number): "refresh-token" | "new-session" | "resume-if-possible" {
  if (code === CLOSE_TOKEN_INVALID) return "refresh-token"
  if (CLOSE_NEW_SESSION.has(code)) return "new-session"
  return "resume-if-possible"
}

export function mapSendPlatformCode(platformCode: number): string {
  if (ANCHOR_DEAD.has(platformCode)) return "qqbot.send.anchor_dead"
  if (platformCode === 40054005) return "qqbot.send.deduplicated"
  if (TOO_LONG.has(platformCode)) return "qqbot.send.too_long"
  if (MARKDOWN_REFUSED.has(platformCode)) return "qqbot.send.markdown_refused"
  if (platformCode === 40054010) return "qqbot.send.url_not_allowed"
  if (platformCode === 40034100) return "qqbot.send.active_rate_limited"
  if (platformCode === 40034105) return "qqbot.send.active_off"
  if (platformCode === 40034102) return "qqbot.send.active_unpermitted"
  if (platformCode === 40034006) return "qqbot.send.audit_rejected"
  if (platformCode === 40054002) return "qqbot.send.muted"
  if (NOT_IN_GROUP.has(platformCode)) return "qqbot.send.not_in_group"
  if (platformCode === 40054013) return "qqbot.send.c2c_refused"
  if (platformCode === 40054004) return "qqbot.send.not_friend"
  return "qqbot.send.failed"
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

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
    }
  }
}

export class QQBotTransport {
  readonly appId: string
  readonly receiveAll: boolean
  readonly apiBase: string
  readonly authBase: string
  readonly requestTimeoutMs: number
  readonly transport = "websocket" as const

  #clientSecret: string
  #tokenValue = ""
  private readonly fetchImpl: QQBotFetchImpl
  private readonly wsFactory: QQBotWsFactory
  private readonly clock: QQBotClock
  private readonly invalidSessionJitterMs: () => number
  private readonly window = new RecentEventWindow()
  private readonly eventHandlers = new Set<EventHandler>()
  private readonly statusHandlers = new Set<StatusHandler>()
  private readonly readyGate = new Latch()

  private status: QQBotStatus = "offline"
  private runAbort: AbortController | undefined
  private runner: Promise<void> | undefined
  private closing = false
  private started = false

  private tokenDeadline = 0
  private tokenFlight: Promise<string> | undefined
  private refreshAbort: AbortController | undefined
  private pendingJitterMs = 0

  private ws: WebSocket | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private lastCloseCode: number | undefined
  private sessionId: string | undefined
  private lastSeq: number | null = null
  private expectResume = false
  private backoffAttempt = 0
  private sawReady = false
  private startFailure: unknown = undefined
  private heartbeatAbort: AbortController | undefined
  private pendingAck = false
  private _lastLogin: QQBotLoginInfo

  constructor(opts: QQBotTransportOptions) {
    if (opts.transport !== "websocket") {
      throw new QQBotApiError("qqbot.gateway.transport.unsupported")
    }
    const timeout = finiteTimeout(opts.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { allowZero: false })
    if (timeout === null) throw new QQBotApiError("qqbot.request_timeout.invalid")
    this.appId = opts.appId
    this.#clientSecret = opts.clientSecret
    this.receiveAll = opts.receiveAll
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
    this.authBase = (opts.authBase ?? DEFAULT_AUTH_BASE).replace(/\/+$/, "")
    this.requestTimeoutMs = timeout
    this.fetchImpl = opts.fetchImpl ?? defaultFetch
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url))
    this.clock = opts.clock ?? realClock
    this.invalidSessionJitterMs =
      opts.invalidSessionJitterMs ??
      (() => defaultInvalidSessionJitterMs(INVALID_SESSION_JITTER_MIN_MS, INVALID_SESSION_JITTER_MAX_MS))
    this._lastLogin = { appId: opts.appId }
  }

  get lastLogin(): QQBotLoginInfo {
    return this._lastLogin
  }

  get connected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => {
      this.statusHandlers.delete(handler)
    }
  }

  async start(): Promise<void> {
    if (this.runner) {
      await withTimeout(this.readyGate.wait(), this.requestTimeoutMs, "qqbot.gateway.ready_timeout")
      return
    }
    this.closing = false
    this.started = true
    this.sawReady = false
    this.startFailure = undefined
    this.runAbort = new AbortController()
    this.readyGate.close()
    this.emitStatus("connecting")
    this.runner = this.run(this.runAbort.signal).finally(() => {
      this.runner = undefined
    })
    try {
      await withTimeout(this.readyGate.wait(), this.requestTimeoutMs, "qqbot.gateway.ready_timeout")
    } catch (err) {
      try {
        await this.close()
      } catch {
        // start failure already decided
      }
      throw err
    }
    if (this.startFailure) {
      const err = this.startFailure
      this.startFailure = undefined
      try {
        await this.close()
      } catch {
        // already failed
      }
      throw err
    }
  }

  async close(): Promise<void> {
    this.closing = true
    if (!this.sawReady) {
      this.startFailure = this.startFailure ?? new QQBotApiError("qqbot.gateway.aborted")
      this.readyGate.open()
    }
    this.runAbort?.abort()
    this.refreshAbort?.abort()
    this.heartbeatAbort?.abort()
    const ws = this.ws
    if (ws) {
      try {
        ws.close()
      } catch {
        // already gone
      }
    }
    if (this.runner) {
      try {
        await this.runner
      } catch {
        // ignore
      }
    }
    this.detach()
    this.runner = undefined
    this.emitStatus("offline")
  }

  async sendGroup(req: QQBotSendRequest): Promise<QQBotSendResult> {
    return this.sendMessage(`/v2/groups/${encodeURIComponent(req.target)}/messages`, req)
  }

  async sendC2C(req: QQBotSendRequest): Promise<QQBotSendResult> {
    return this.sendMessage(`/v2/users/${encodeURIComponent(req.target)}/messages`, req)
  }

  async uploadGroupMedia(req: QQBotUploadRequest & { groupOpenid: string }): Promise<QQBotUploadResult> {
    return this.uploadMedia("groups", req.groupOpenid, req)
  }

  async uploadC2CMedia(req: QQBotUploadRequest & { userOpenid: string }): Promise<QQBotUploadResult> {
    return this.uploadMedia("users", req.userOpenid, req)
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!this.closing && !signal.aborted) {
      try {
        await this.ensureToken()
        if (this.closing || signal.aborted) return
        const gatewayUrl = await this.fetchGatewayUrl()
        if (this.closing || signal.aborted) return
        if (this.status !== "online") this.emitStatus("connecting")
        const ws = await this.openSocket(gatewayUrl, signal)
        if (this.closing || signal.aborted) {
          try {
            ws.close()
          } catch {
            // dropped unattached
          }
          return
        }
        this.attach(ws)
        await this.consume(ws, signal)
      } catch (err) {
        if (this.closing || signal.aborted) return
        if (!this.sawReady && err instanceof QQBotApiError && err.code.startsWith("qqbot.auth.")) {
          this.startFailure = err
          this.readyGate.open()
          return
        }
        console.warn("qqbot.gateway.connection_lost", errorName(err))
      } finally {
        this.stopHeartbeat()
        this.detach()
      }
      if (!this.closing && !signal.aborted) {
        this.emitStatus("reconnecting")
        this.backoffAttempt += 1
        const delay =
          nextBackoffMs(this.backoffAttempt, RECONNECT_BACKOFF_MS, RECONNECT_BACKOFF_CAP_MS) + this.pendingJitterMs
        this.pendingJitterMs = 0
        await this.clock.sleep(delay, signal)
      }
    }
  }

  private attach(ws: WebSocket): void {
    this.ws = ws
    this.lastCloseCode = undefined
    this.writeChain = Promise.resolve()
  }

  private detach(): void {
    this.stopHeartbeat()
    this.ws = undefined
  }

  private async openSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
    const ws = await this.wsFactory(url)
    if (ws.readyState === WebSocket.OPEN) return ws
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup()
          resolve()
        }
        const onFail = () => {
          cleanup()
          reject(new QQBotApiError("qqbot.gateway.connect_failed"))
        }
        const onAbort = () => {
          cleanup()
          reject(new QQBotApiError("qqbot.gateway.aborted"))
        }
        const cleanup = () => {
          ws.removeEventListener("open", onOpen)
          ws.removeEventListener("error", onFail)
          ws.removeEventListener("close", onFail)
          signal.removeEventListener("abort", onAbort)
        }
        ws.addEventListener("open", onOpen)
        ws.addEventListener("error", onFail)
        ws.addEventListener("close", onFail)
        signal.addEventListener("abort", onAbort, { once: true })
        if (ws.readyState === WebSocket.OPEN) onOpen()
      }),
      this.requestTimeoutMs,
      "qqbot.gateway.connect_timeout",
    )
    return ws
  }

  private async consume(ws: WebSocket, signal: AbortSignal): Promise<void> {
    const buffer = new MessageBuffer()
    const onMessage = (event: MessageEvent) => {
      buffer.push(socketDataToString(event.data))
    }
    const onClose = (event: CloseEvent) => {
      this.lastCloseCode = event.code
      this.applyCloseCode(event.code)
      buffer.end()
    }
    const onError = () => buffer.end()
    const onAbort = () => {
      try {
        ws.close()
      } catch {
        // already gone
      }
      buffer.end()
    }
    ws.addEventListener("message", onMessage)
    ws.addEventListener("close", onClose)
    ws.addEventListener("error", onError)
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      let identified = false
      for await (const raw of buffer) {
        if (this.ws !== ws || this.closing) return
        const rec = jsonObject(raw)
        const payload = rec ? parseGatewayPayload(rec) : undefined
        if (!payload) continue
        if (typeof payload.s === "number") this.lastSeq = payload.s
        if (payload.op === GATEWAY_OP.HELLO) {
          const interval = asInteger((jsonObject(payload.d) ?? {}).heartbeat_interval, 0)
          if (interval <= 0) throw new QQBotApiError("qqbot.gateway.hello_invalid")
          if (!this.expectResume || !this.sessionId) this.lastSeq = null
          this.startHeartbeat(interval, signal)
          if (!identified) {
            identified = true
            await this.identifyOrResume()
          }
          continue
        }
        if (payload.op === GATEWAY_OP.HEARTBEAT_ACK) {
          this.pendingAck = false
          continue
        }
        if (payload.op === GATEWAY_OP.HEARTBEAT) {
          await this.sendHeartbeat()
          continue
        }
        if (payload.op === GATEWAY_OP.RECONNECT) {
          this.expectResume = Boolean(this.sessionId)
          try {
            ws.close()
          } catch {
            // already gone
          }
          return
        }
        if (payload.op === GATEWAY_OP.INVALID_SESSION) {
          this.beginNewSession()
          this.pendingJitterMs = this.invalidSessionJitterMs()
          try {
            ws.close()
          } catch {
            // already gone
          }
          return
        }
        if (payload.op === GATEWAY_OP.DISPATCH) {
          await this.handleDispatch(payload)
        }
      }
    } finally {
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("close", onClose)
      ws.removeEventListener("error", onError)
      signal.removeEventListener("abort", onAbort)
      buffer.end()
    }
  }

  private beginNewSession(): void {
    this.sessionId = undefined
    this.lastSeq = null
    this.expectResume = false
  }

  private applyCloseCode(code: number): void {
    const policy = sessionPolicyForClose(code)
    if (policy === "refresh-token") {
      this.#tokenValue = ""
      this.tokenDeadline = 0
      this.beginNewSession()
      return
    }
    if (policy === "new-session") {
      this.beginNewSession()
      return
    }
    if (this.sessionId) this.expectResume = true
  }

  private async handleDispatch(payload: GatewayPayload): Promise<void> {
    if (payload.t === "READY") {
      const data = jsonObject(payload.d) ?? {}
      this.sessionId = stringId(data.session_id) ?? this.sessionId
      const user = jsonObject(data.user) ?? {}
      this._lastLogin = {
        appId: this.appId,
        ...(stringId(user.id) ? { botOpenid: stringId(user.id) } : {}),
        ...(stringId(user.username) ? { username: stringId(user.username) } : {}),
      }
      this.expectResume = false
      this.backoffAttempt = 0
      this.sawReady = true
      this.emitStatus("online")
      this.readyGate.open()
      return
    }
    if (payload.t === "RESUMED") {
      this.expectResume = false
      this.backoffAttempt = 0
      this.sawReady = true
      this.emitStatus("online")
      this.readyGate.open()
      return
    }
    const event = ingestDispatch(payload, this.window, this.receiveAll)
    if (!event) return
    for (const handler of this.eventHandlers) {
      try {
        const result = handler(event)
        if (result !== undefined && typeof (result as Promise<void>).then === "function") await result
      } catch {
        // a throwing subscriber must not kill the gateway loop
      }
    }
  }

  private async identifyOrResume(): Promise<void> {
    if (this.expectResume && this.sessionId) await this.sendResume()
    else await this.sendIdentify()
  }

  private async sendIdentify(): Promise<void> {
    const token = await this.ensureToken()
    await this.enqueueWrite(
      JSON.stringify({
        op: GATEWAY_OP.IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: GROUP_AND_C2C_EVENT,
          shard: [0, 1],
          properties: { $os: processPlatform(), $browser: "loreweaver", $device: "loreweaver" },
        },
      }),
    )
  }

  private async sendResume(): Promise<void> {
    const token = await this.ensureToken()
    await this.enqueueWrite(
      JSON.stringify({
        op: GATEWAY_OP.RESUME,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.lastSeq ?? 0,
        },
      }),
    )
  }

  private startHeartbeat(intervalMs: number, signal: AbortSignal): void {
    this.stopHeartbeat()
    const abort = new AbortController()
    this.heartbeatAbort = abort
    const linked = () => abort.abort()
    signal.addEventListener("abort", linked, { once: true })
    void (async () => {
      try {
        while (!abort.signal.aborted && !this.closing) {
          await this.clock.sleep(intervalMs, abort.signal)
          if (abort.signal.aborted || this.closing) return
          if (this.pendingAck) {
            console.warn("qqbot.gateway.heartbeat_lost")
            try {
              this.ws?.close()
            } catch {
              // already gone
            }
            return
          }
          try {
            await this.sendHeartbeat()
          } catch {
            console.warn("qqbot.gateway.heartbeat_failed")
            try {
              this.ws?.close()
            } catch {
              // already gone — readyState may already be CLOSED without a close event
            }
            return
          }
        }
      } catch {
        console.warn("qqbot.gateway.heartbeat_failed")
      } finally {
        signal.removeEventListener("abort", linked)
      }
    })()
  }

  private stopHeartbeat(): void {
    this.heartbeatAbort?.abort()
    this.heartbeatAbort = undefined
    this.pendingAck = false
  }

  private async sendHeartbeat(): Promise<void> {
    this.pendingAck = true
    try {
      await this.enqueueWrite(JSON.stringify({ op: GATEWAY_OP.HEARTBEAT, d: this.lastSeq }))
    } catch (err) {
      this.pendingAck = false
      throw err
    }
  }

  private enqueueWrite(payload: string): Promise<void> {
    const ws = this.ws
    const previous = this.writeChain
    const next = previous.then(() => {
      if (!ws || this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        throw new QQBotApiError("qqbot.gateway.disconnected")
      }
      ws.send(payload)
    })
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async ensureToken(force = false): Promise<string> {
    const now = this.clock.now()
    if (!force && this.#tokenValue && now < this.tokenDeadline) {
      return this.#tokenValue
    }
    if (this.tokenFlight) return this.tokenFlight
    this.tokenFlight = this.refreshToken().finally(() => {
      this.tokenFlight = undefined
    })
    return this.tokenFlight
  }

  private async refreshToken(): Promise<string> {
    const body = await this.postToken()
    const access = String(body.access_token ?? "")
    const expiresIn = parseExpiresIn(body.expires_in)
    if (!access || expiresIn === undefined) throw new QQBotApiError("qqbot.auth.invalid_response")
    const sameToken = access === this.#tokenValue && this.tokenDeadline > 0
    if (sameToken) {
      this.scheduleRefresh({ untilExpiry: true })
    } else {
      this.#tokenValue = access
      this.tokenDeadline = this.clock.now() + expiresIn * 1000
      this.scheduleRefresh()
    }
    return this.#tokenValue
  }

  private scheduleRefresh(opts: { untilExpiry?: boolean } = {}): void {
    this.refreshAbort?.abort()
    const abort = new AbortController()
    this.refreshAbort = abort
    const remainingMs = this.tokenDeadline - this.clock.now()
    const delay = opts.untilExpiry
      ? Math.max(TOKEN_REFRESH_FLOOR_MS, remainingMs)
      : tokenRefreshDelayMs(remainingMs / 1000, TOKEN_REFRESH_MARGIN_S, TOKEN_REFRESH_FLOOR_MS)
    void (async () => {
      try {
        await this.clock.sleep(delay, abort.signal)
        if (abort.signal.aborted || this.closing) return
        await this.ensureToken(true)
      } catch (err) {
        if (abort.signal.aborted || this.closing) return
        console.warn("qqbot.auth.refresh_failed", errorName(err))
      }
    })()
  }

  private async postToken(): Promise<Record<string, unknown>> {
    const url = joinUrl(this.authBase, "/app/getAppAccessToken")
    let response: QQBotFetchResponse
    try {
      response = await this.timedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.#clientSecret }),
      })
    } catch (err) {
      if (err instanceof QQBotApiError) throw err
      throw new QQBotApiError("qqbot.auth.failed", "qqbot.auth.failed")
    }
    const body = await readJson(response)
    if (response.status < 200 || response.status >= 300) {
      throw new QQBotApiError("qqbot.auth.rejected", "qqbot.auth.rejected", {
        httpStatus: response.status,
        traceId: headerTraceId(response.headers),
        platformCode: asInteger(body?.code, response.status),
      })
    }
    if (!body || body.access_token === undefined) {
      throw new QQBotApiError("qqbot.auth.invalid_response")
    }
    return body
  }

  private async fetchGatewayUrl(): Promise<string> {
    const response = await this.apiFetch("/gateway/bot", { method: "GET" })
    const body = await readJson(response)
    if (response.status < 200 || response.status >= 300 || !body) {
      throw new QQBotApiError("qqbot.gateway.url_failed", "qqbot.gateway.url_failed", {
        httpStatus: response.status,
        traceId: headerTraceId(response.headers),
      })
    }
    const url = stringId(body.url)
    if (!url) throw new QQBotApiError("qqbot.gateway.url_failed")
    return url
  }

  private async sendMessage(path: string, req: QQBotSendRequest): Promise<QQBotSendResult> {
    const body = buildSendBody(req)
    let response: QQBotFetchResponse
    try {
      response = await this.apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (err) {
      if (isTimeout(err)) {
        return { ok: false, code: "qqbot.send.timeout", message: "qqbot.send.timeout", httpStatus: 0 }
      }
      if (err instanceof QQBotApiError && err.code.startsWith("qqbot.auth.")) {
        return {
          ok: false,
          code: err.code,
          message: err.code,
          httpStatus: err.httpStatus ?? 0,
          ...(err.platformCode !== undefined ? { platformCode: err.platformCode } : {}),
        }
      }
      return { ok: false, code: "qqbot.send.failed", message: "qqbot.send.failed", httpStatus: 0 }
    }
    const parsed = await readJson(response)
    const envelope = parsed ?? {}
    const platformCode = envelope.code !== undefined ? asInteger(envelope.code, 0) : undefined
    const retryAfterMs = parseRetryAfterMs(response.headers, envelope)
    const auditId = auditIdOf(envelope)
    const data = jsonObject(envelope.data) ?? envelope

    if (response.status === 429) {
      const result: QQBotSendResult = {
        ok: false,
        code: "qqbot.send.rate_limited",
        message: String(envelope.message ?? envelope.msg ?? "qqbot.send.rate_limited"),
        httpStatus: 429,
        ...(platformCode !== undefined ? { platformCode } : {}),
      }
      if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs
      return result
    }

    if (auditId && (response.status < 300 || platformCode === 304023 || platformCode === 0)) {
      const audited: QQBotSendResult = { ok: true, auditId }
      const id = stringId(data.id)
      const timestamp = stringId(data.timestamp)
      if (id !== undefined) audited.id = id
      if (timestamp !== undefined) audited.timestamp = timestamp
      return audited
    }

    if (platformCode === 304023) {
      return {
        ok: false,
        code: "qqbot.send.audit_pending",
        message: String(envelope.message ?? envelope.msg ?? "qqbot.send.audit_pending"),
        httpStatus: response.status,
        platformCode: 304023,
      }
    }

    const httpOk = response.status >= 200 && response.status < 300
    const bodyOk = platformCode === undefined || platformCode === 0
    if (httpOk && bodyOk) {
      const success: QQBotSendResult = { ok: true }
      const id = stringId(data.id)
      const timestamp = stringId(data.timestamp)
      if (id !== undefined) success.id = id
      if (timestamp !== undefined) success.timestamp = timestamp
      if (auditId) success.auditId = auditId
      return success
    }

    const code = platformCode !== undefined ? mapSendPlatformCode(platformCode) : "qqbot.send.failed"
    const failure: QQBotSendResult = {
      ok: false,
      code,
      message: String(envelope.message ?? envelope.msg ?? code),
      httpStatus: response.status,
      ...(platformCode !== undefined ? { platformCode } : {}),
    }
    if (retryAfterMs !== undefined) failure.retryAfterMs = retryAfterMs
    return failure
  }

  private async uploadMedia(
    kind: "groups" | "users",
    openid: string,
    req: QQBotUploadRequest,
  ): Promise<QQBotUploadResult> {
    if (req.url) {
      return this.postFiles(kind, openid, {
        file_type: req.fileType,
        url: req.url,
        srv_send_msg: false,
        ...(req.fileName ? { file_name: req.fileName } : {}),
      })
    }
    if (!req.bytes) throw new QQBotApiError("qqbot.send.upload_failed")
    return this.uploadChunked(kind, openid, req.bytes, req.fileType, req.fileName)
  }

  private async uploadChunked(
    kind: "groups" | "users",
    openid: string,
    bytes: Uint8Array,
    fileType: number,
    fileName?: string,
  ): Promise<QQBotUploadResult> {
    const name = fileName || defaultFileName(fileType)
    const preparePath = `/v2/${kind}/${encodeURIComponent(openid)}/upload_prepare`
    const finishPath = `/v2/${kind}/${encodeURIComponent(openid)}/upload_part_finish`
    const prepare = await this.apiJson(preparePath, {
      file_type: fileType,
      file_size: String(bytes.byteLength),
      file_name: name,
      md5: hashHex("md5", bytes),
      sha1: hashHex("sha1", bytes),
      md5_10m: hashHex("md5", bytes.subarray(0, Math.min(bytes.byteLength, MD5_10M_BYTES))),
    })
    const uploadId = stringId(prepare.upload_id)
    if (!uploadId) throw new QQBotApiError("qqbot.send.upload_failed")
    const blockSize = asInteger(prepare.block_size, DEFAULT_UPLOAD_BLOCK_SIZE)
    const parts = Array.isArray(prepare.parts) ? prepare.parts : []
    const config = jsonObject(prepare.upload_config) ?? {}
    const concurrency = Math.max(1, asInteger(config.concurrency, 1))
    const work: Array<{ index: number; url: string; size: number; start: number }> = []
    if (parts.length) {
      const ordered = parts
        .map((part, fallback) => {
          const rec = jsonObject(part)
          if (!rec) return undefined
          const url = stringId(rec.presigned_url)
          if (!url) return undefined
          return {
            index: asInteger(rec.index, fallback),
            url,
            size: asInteger(rec.block_size, blockSize),
            start: 0,
          }
        })
        .filter((part): part is { index: number; url: string; size: number; start: number } => part !== undefined)
        .sort((a, b) => a.index - b.index)
      let offset = 0
      for (const part of ordered) {
        part.start = offset
        offset += part.size
        work.push(part)
      }
    } else {
      for (let offset = 0, index = 0; offset < bytes.byteLength; index += 1) {
        const size = Math.min(blockSize, bytes.byteLength - offset)
        work.push({ index, url: "", size, start: offset })
        offset += size
      }
    }
    let cursor = 0
    const runPart = async (part: { index: number; url: string; size: number; start: number }) => {
      const slice = bytes.subarray(part.start, Math.min(bytes.byteLength, part.start + part.size))
      if (part.url) {
        await this.timedFetch(part.url, { method: "PUT", body: slice }, uploadPartTimeoutMs(
          slice.byteLength,
          Math.max(MIN_REQUEST_TIMEOUT_MS, UPLOAD_PART_TIMEOUT_BASE_MS),
          UPLOAD_PART_TIMEOUT_PER_MIB_MS,
        ))
      }
      await this.apiJson(finishPath, {
        upload_id: uploadId,
        part_index: part.index,
        block_size: String(slice.byteLength),
        md5: hashHex("md5", slice),
      })
    }
    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(
        (async () => {
          while (true) {
            const index = cursor
            cursor += 1
            const part = work[index]
            if (!part) return
            await runPart(part)
          }
        })(),
      )
    }
    await Promise.all(workers)
    return this.postFiles(kind, openid, {
      file_type: fileType,
      srv_send_msg: false,
      file_name: name,
      upload_id: uploadId,
    })
  }

  private async postFiles(
    kind: "groups" | "users",
    openid: string,
    body: Record<string, unknown>,
  ): Promise<QQBotUploadResult> {
    const data = await this.apiJson(`/v2/${kind}/${encodeURIComponent(openid)}/files`, body)
    const fileInfo = stringId(data.file_info)
    if (!fileInfo) throw new QQBotApiError("qqbot.send.upload_failed")
    const result: QQBotUploadResult = { fileInfo, ttl: asInteger(data.ttl, 0) }
    const uuid = stringId(data.file_uuid)
    if (uuid) result.fileUuid = uuid
    const rawUrl = stringId(data.raw_url)
    if (rawUrl) result.rawUrl = rawUrl
    return result
  }

  private async apiJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const parsed = await readJson(response)
    const envelope = parsed ?? {}
    const platformCode = envelope.code !== undefined ? asInteger(envelope.code, 0) : 0
    if (response.status < 200 || response.status >= 300 || (platformCode !== 0 && envelope.data === undefined)) {
      throw new QQBotApiError("qqbot.send.upload_failed", String(envelope.message ?? envelope.msg ?? "qqbot.send.upload_failed"), {
        httpStatus: response.status,
        traceId: headerTraceId(response.headers),
        platformCode: platformCode || response.status,
      })
    }
    return jsonObject(envelope.data) ?? envelope
  }

  private async apiFetch(path: string, init: QQBotFetchInit): Promise<QQBotFetchResponse> {
    const token = await this.ensureToken()
    const headers: Record<string, string> = {
      ...(init.headers ?? {}),
      Authorization: `QQBot ${token}`,
      "X-Union-Appid": this.appId,
    }
    return this.timedFetch(joinUrl(this.apiBase, path), { ...init, headers })
  }

  private async timedFetch(url: string, init: QQBotFetchInit, timeoutMs = this.requestTimeoutMs): Promise<QQBotFetchResponse> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    const onParent = () => abort.abort()
    this.runAbort?.signal.addEventListener("abort", onParent, { once: true })
    try {
      return await this.fetchImpl(url, { ...init, signal: abort.signal })
    } catch (err) {
      if (abort.signal.aborted) {
        const timeout = new QQBotApiError("qqbot.send.timeout")
        timeout.name = "TimeoutError"
        throw timeout
      }
      throw err
    } finally {
      clearTimeout(timer)
      this.runAbort?.signal.removeEventListener("abort", onParent)
    }
  }

  private emitStatus(status: QQBotStatus): void {
    if (this.status === status && status !== "connecting") return
    this.status = status
    for (const handler of this.statusHandlers) {
      try {
        handler(status)
      } catch {
        // a throwing subscriber must not kill the reconnect loop
      }
    }
  }
}

export function buildSendBody(req: QQBotSendRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { msg_type: req.msgType, msg_seq: req.msgSeq }
  if (req.msgId) body.msg_id = req.msgId
  if (req.eventId) body.event_id = req.eventId
  if (req.msgType !== 2 && req.content !== undefined) body.content = req.content
  if (req.msgType === 2) body.markdown = { content: req.markdown?.content ?? "" }
  if (req.msgType === 7) body.media = { file_info: req.media?.fileInfo ?? "" }
  return body
}

function auditIdOf(envelope: Record<string, unknown>): string | undefined {
  const direct = jsonObject(envelope.message_audit)
  const fromDirect = direct ? stringId(direct.audit_id) : undefined
  if (fromDirect) return fromDirect
  const data = jsonObject(envelope.data)
  const nested = data ? jsonObject(data.message_audit) : undefined
  return nested ? stringId(nested.audit_id) : undefined
}

async function readJson(response: QQBotFetchResponse): Promise<Record<string, unknown> | undefined> {
  try {
    return jsonObject(await response.json())
  } catch {
    try {
      return jsonObject(await response.text())
    } catch {
      return undefined
    }
  }
}

function hashHex(alg: "md5" | "sha1", bytes: Uint8Array): string {
  return createHash(alg).update(bytes).digest("hex")
}

function defaultFileName(fileType: number): string {
  if (fileType === 1) return "image.png"
  if (fileType === 2) return "video.mp4"
  if (fileType === 3) return "voice.silk"
  return "file.bin"
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.message === "qqbot.send.timeout")
}

function socketDataToString(data: unknown): string {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  return String(data ?? "")
}

function processPlatform(): string {
  try {
    return process.platform
  } catch {
    return "unknown"
  }
}

async function defaultFetch(url: string, init: QQBotFetchInit): Promise<QQBotFetchResponse> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  })
  return {
    status: response.status,
    headers: response.headers,
    json: () => response.json() as Promise<unknown>,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  }
}
