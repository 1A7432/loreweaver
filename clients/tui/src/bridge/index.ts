import type { ClientFrame, ClientInfo, ServerFrame } from "loreweaver-protocol"
import { bringUpServer, type HostHandle, type OnLog } from "../hostLocal"
import { tt } from "../i18n"
import { sha256Hex } from "../media"
import { clientInfo } from "../version"
import type { IrohLink, LoadIroh } from "../irohLink"
import {
  loadBridgeConfig,
  onebotTimeoutsMs,
  roomKeeperKey,
  type BridgeConfig,
  type BridgeGroupConfig,
} from "./config"
import { Keyring, keyringPath, observerName } from "./keyring"
import { LinkPool } from "./linkPool"
import { UserRateLimiter } from "./limits"
import {
  OneBotAPIError,
  OneBotError,
  OneBotTransport,
  type ChatTarget,
  type ConnectFactory,
  type FetchDeps,
  type OneBotInbound,
  type OneBotStatus,
  type OneBotTransportOptions,
} from "./onebot"
import { PostedIds, postedPath } from "./postedIds"
import { BridgeRouter, type LinkRole, type OutboundIntent } from "./router"
import { flushSettingsWrites, loadGroupSettings, settingsPath } from "./settings"

export { loadBridgeConfig, parseBridgeConfig, BridgeConfigError } from "./config"
export type { BridgeConfig } from "./config"

type ControlLinkLike = {
  send(frame: ClientFrame): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
  readonly isAlive?: boolean
}

const CONTROL_QUEUE_CAP = 64
const FRIEND_NOTICE_MS = 10 * 60 * 1000
const STATUS_LOG_THROTTLE_MS = 60 * 1000
/** The live membership check before a private redirect; it sits on the group's serial outbox. */
const MEMBER_GATE_TIMEOUT_MS = 3_000
const URL_SAFE_TOKEN = /[A-Za-z0-9_-]{16,}/

/**
 * Mask keeper keys in host-bootstrap logs. Matches `Keeper key: …` / `密钥` lines
 * and any ≥16 url-safe token after the words `key` / `密钥`.
 */
export function redactKeeperSecrets(line: string): string {
  return line
    .replace(/\bkey\b\s*[:=]?\s*[A-Za-z0-9_-]{16,}/gi, (match) => match.replace(URL_SAFE_TOKEN, "****"))
    .replace(/密钥\s*[:：]?\s*[A-Za-z0-9_-]{16,}/g, (match) => match.replace(URL_SAFE_TOKEN, "****"))
}

/** Fan-out control surface so a Keyring survives control-link redials. */
export class RelayingControl implements ControlLinkLike {
  private link: ControlLinkLike | undefined
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  private readonly queue: ClientFrame[] = []
  private off: (() => void) | undefined

  bind(link: ControlLinkLike): void {
    this.off?.()
    this.link = link
    this.off = link.onMessage((frame) => {
      for (const handler of this.handlers) handler(frame)
    })
    const pending = this.queue.splice(0)
    for (const frame of pending) this.send(frame)
  }

  send(frame: ClientFrame): void {
    if (this.isLive()) {
      this.link!.send(frame)
      return
    }
    this.queue.push(frame)
    while (this.queue.length > CONTROL_QUEUE_CAP) this.queue.shift()
  }

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => {
      this.handlers.delete(cb)
    }
  }

  private isLive(): boolean {
    if (!this.link) return false
    if (this.link.isAlive === false) return false
    return true
  }
}

type LinkKind =
  | { kind: "control"; groupId: string }
  | { kind: "observer"; groupId: string }
  | { kind: "member"; groupId: string; userId: string; role: LinkRole }

export interface BridgeDeps {
  loadConfig?: (path: string) => Promise<BridgeConfig>
  hostLocal?: typeof bringUpServer
  loadIroh?: LoadIroh
  connectFactory?: ConnectFactory
  transport?: OneBotTransport
  httpGet?: FetchDeps["httpGet"]
  resolveAddresses?: FetchDeps["resolveAddresses"]
  clientInfo?: ClientInfo
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  onLog?: (text: string) => void
  /** Default true. Tests pass false so SIGINT is not stolen. */
  installSignals?: boolean
}

export interface BridgeHandle {
  stop(): Promise<void>
  readonly stopped: Promise<void>
  readonly ticket: string
  readonly hosted: boolean
  readonly groups: readonly string[]
}

export function onebotTransportOptions(config: BridgeConfig): OneBotTransportOptions {
  const timeouts = onebotTimeoutsMs(config.onebot)
  if (config.onebot.mode === "forward") {
    return {
      mode: "forward",
      wsUrl: config.onebot.ws_url,
      accessToken: config.onebot.access_token,
      requestTimeoutMs: timeouts.requestTimeoutMs,
      reconnectDelayMs: timeouts.reconnectDelayMs,
    }
  }
  return {
    mode: "reverse",
    listenHost: config.onebot.listen_host,
    listenPort: config.onebot.listen_port,
    path: config.onebot.path,
    accessToken: config.onebot.access_token,
    requestTimeoutMs: timeouts.requestTimeoutMs,
  }
}

/**
 * Own messages (`user_id === self_id`) and OneBot 11 anonymous group messages are dropped.
 * There is no bot flag on a message sender in NapCat, LLOneBot or the spec — the only
 * marker is `is_robot` on a `get_group_member_info` member object — so a second bot in
 * the group is NOT recognised: the bridge has no second-bot guard on the protocol path.
 */
export function isDroppedOneBotSender(msg: OneBotInbound): boolean {
  const selfId = msg.raw.self_id === undefined || msg.raw.self_id === null ? undefined : String(msg.raw.self_id)
  if (selfId !== undefined && msg.sender.userId === selfId) return true
  if (msg.raw.anonymous && typeof msg.raw.anonymous === "object") return true
  return false
}

function isImageAttachment(att: { mime: string; name: string }): boolean {
  if (att.mime.toLowerCase().startsWith("image/")) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name)
}

/** A machine code for the log line — never the error message, which can carry a signed URL. */
export function attachmentFailureReason(err: unknown): string {
  if (err instanceof OneBotAPIError) return `onebot.api.${err.retcode}`
  if (err instanceof OneBotError) return err.code
  if (err instanceof Error) return err.name || "Error"
  return "Error"
}

class GroupRuntime {
  readonly control = new RelayingControl()
  readonly limiter: UserRateLimiter
  readonly lastMessageId = new Map<string, string>()
  observerLink: IrohLink | undefined
  private outbox: Promise<void> = Promise.resolve()
  private readonly lastFriendNotice = new Map<string, number>()
  router!: BridgeRouter
  keyring!: Keyring
  posted!: PostedIds

  constructor(
    readonly groupId: string,
    readonly group: BridgeGroupConfig,
    private readonly transport: OneBotTransport,
    private readonly now: () => number,
  ) {
    this.limiter = new UserRateLimiter(undefined, undefined, now)
  }

  enqueue(intent: OutboundIntent): void {
    this.outbox = this.outbox.then(() => this.dispatch(intent)).catch(() => {})
  }

  private async dispatch(intent: OutboundIntent): Promise<void> {
    const groupTarget: ChatTarget = { type: "group", id: this.groupId }
    if (intent.dest === "group") {
      if (intent.media) {
        const observer = this.observerLink
        if (observer?.isAlive) {
          try {
            const payload = await observer.getMedia(intent.media.hash)
            const result = await this.transport.sendImage(
              groupTarget,
              { data: payload.bytes, mime: payload.mime || intent.media.mime },
              { text: intent.text || undefined },
            )
            if (result.ok) return
          } catch {
            // fall through to the name line — never pretend the image sent
          }
        }
        const fallback = intent.text || intent.media.name || ""
        if (fallback) await this.transport.sendText(groupTarget, fallback)
        return
      }
      if (intent.text) await this.transport.sendText(groupTarget, intent.text)
      return
    }
    if (intent.dest === "reply") {
      const replyTo = this.lastMessageId.get(intent.userId)
      if (replyTo) await this.transport.sendReply(groupTarget, replyTo, intent.text)
      else await this.transport.sendText(groupTarget, intent.text)
      return
    }
    // A private reply carries the group it belongs to, so NapCat can use the group temp
    // session when the two are not friends — but ONLY once NapCat has confirmed it can
    // resolve this member: with an unresolvable user NapCat falls back to posting into the
    // group itself, and a keeper-grade reply must never take that path (iron rule #3).
    // The check is LIVE (no cache) and short: a 10-minute-old "yes" is not a verdict, and this
    // await sits on the group's serial outbox. Anything but a confirmed member sends plain.
    const status = await this.transport.memberStatus(this.groupId, intent.userId, { fresh: true, timeoutMs: MEMBER_GATE_TIMEOUT_MS })
    const result =
      status === "member"
        ? await this.transport.sendText({ type: "group", id: this.groupId, userId: intent.userId }, intent.text, { private: true })
        : await this.transport.sendText({ type: "private", id: intent.userId }, intent.text)
    if (!result.ok) {
      // A transport hiccup is not "not friends": no friend notice for a failure that may
      // have nothing to do with friendship.
      if (status === "unknown") {
        console.warn("onebot.private_send_failed_unverified", result.error ?? "")
        return
      }
      const last = this.lastFriendNotice.get(intent.userId)
      if (last !== undefined && this.now() - last < FRIEND_NOTICE_MS) return
      this.lastFriendNotice.set(intent.userId, this.now())
      await this.transport.sendText(groupTarget, tt(this.router.locale(), "bridge.privateFailed"))
    }
  }
}

export async function runBridge(config: BridgeConfig, deps: BridgeDeps = {}): Promise<BridgeHandle> {
  const onLog = deps.onLog ?? ((text: string) => console.log(text))
  const hostLocal = deps.hostLocal ?? bringUpServer
  const now = deps.now ?? Date.now

  let ticket = config.ticket
  let keeperKey = config.keeper_key
  let host: HostHandle | undefined
  let pool: LinkPool | undefined
  let transport: OneBotTransport | undefined
  const sessions = new Map<string, GroupRuntime>()
  const catalog = new Map<string, LinkKind>()
  const lastGroupByUser = new Map<string, string>()

  const teardown = async (): Promise<void> => {
    try {
      if (transport) await transport.close()
    } catch {
      // keep going — every step of stop is independent
    }
    try {
      pool?.close()
    } catch {
      // ignore
    }
    for (const session of sessions.values()) {
      try {
        session.keyring.close()
      } catch {
        // ignore
      }
      try {
        await session.keyring.drainWrites()
      } catch {
        // ignore
      }
      try {
        await session.posted.flush()
      } catch {
        // ignore
      }
    }
    try {
      await flushSettingsWrites()
    } catch {
      // ignore
    }
    try {
      host?.stop()
    } catch {
      // ignore
    }
  }

  try {
  if (!ticket) {
    onLog(tt(config.locale, "bridge.cli.hosting"))
    const log: OnLog = (text) => onLog(redactKeeperSecrets(text))
    host = await hostLocal(log)
    ticket = host.host
    keeperKey = host.key
  }
  const resolved: BridgeConfig = { ...config, ticket, keeper_key: keeperKey }

  const idleCloseMs =
    resolved.idle_close_minutes > 0 ? resolved.idle_close_minutes * 60 * 1000 : 30 * 60 * 1000
  const playerIdleClose = resolved.idle_close_minutes > 0

  pool = new LinkPool({
    loadIroh: deps.loadIroh,
    clientInfo: deps.clientInfo ?? clientInfo(),
    idleCloseMs,
    setTimeoutFn: deps.setTimeoutFn,
    clearTimeoutFn: deps.clearTimeoutFn,
    onLinkReady: (memberKey, link, reason) => {
      const meta = catalog.get(memberKey)
      if (!meta) return
      const session = sessions.get(meta.groupId)
      if (!session) return
      if (meta.kind === "control") {
        session.control.bind(link)
        return
      }
      if (meta.kind === "observer") {
        session.observerLink = link
        session.router.attachLink("observer", memberKey, link, undefined, reason)
        return
      }
      session.router.attachLink(meta.role, memberKey, link, meta.userId, reason)
    },
    onLinkDown: (memberKey) => {
      const meta = catalog.get(memberKey)
      if (!meta || meta.kind === "control") return
      sessions.get(meta.groupId)?.router.onLinkDown(memberKey)
    },
  })
  await pool.connect(ticket)

  transport =
    deps.transport ??
    new OneBotTransport({
      ...onebotTransportOptions(resolved),
      connectFactory: deps.connectFactory,
      httpGet: deps.httpGet,
      resolveAddresses: deps.resolveAddresses,
    })

  // The operator's only view of the OneBot side: which account answered, when the socket
  // drops, and when a later self-check fails. "connecting"/"online" are implied by the
  // login line. Every line is throttled to once per minute per kind, except a login by a
  // DIFFERENT account, which always prints.
  const loggedAt = new Map<string, number>()
  const throttled = (kind: string): boolean => {
    const last = loggedAt.get(kind)
    if (last !== undefined && now() - last < STATUS_LOG_THROTTLE_MS) return true
    loggedAt.set(kind, now())
    return false
  }
  let lastLoginUser: string | undefined
  transport.onLogin((info) => {
    const changed = info.userId !== lastLoginUser
    lastLoginUser = info.userId
    if (!changed && throttled("login")) return
    onLog(tt(resolved.locale, "bridge.cli.onebotLoggedIn", { user: info.userId || "?", name: info.nickname || "?" }))
  })
  transport.onStatus((status: OneBotStatus) => {
    if (status !== "reconnecting" && status !== "offline") return
    if (throttled(status)) return
    onLog(tt(resolved.locale, status === "reconnecting" ? "bridge.cli.onebotReconnecting" : "bridge.cli.onebotOffline"))
  })
  transport.onSelfCheckFailed((code) => {
    if (throttled(code)) return
    onLog(tt(resolved.locale, code === "onebot.auth_rejected" ? "bridge.cli.onebotAuthRejected" : "bridge.cli.onebotSelfCheckFailed"))
  })

  for (const group of resolved.groups) {
    const groupKeeper = roomKeeperKey(resolved, group)
    if (!groupKeeper) {
      throw new Error(tt(resolved.locale, "bridge.cli.missingGroupKey", { group: group.group_id }))
    }
    const session = new GroupRuntime(group.group_id, group, transport, now)
    sessions.set(group.group_id, session)

    const settings = await loadGroupSettings(settingsPath(resolved.state_dir, group.group_id), {
      admins: group.admins,
      mode: group.mode,
      busyNotice: resolved.busy_notice,
    })
    session.posted = await PostedIds.load(postedPath(resolved.state_dir, group.group_id))

    catalog.set(groupKeeper, { kind: "control", groupId: group.group_id })
    await pool.open(groupKeeper, { idleClose: false })

    session.keyring = await Keyring.load({
      path: keyringPath(resolved.state_dir, group.group_id),
      groupId: group.group_id,
      control: session.control,
      admins: () => session.router?.adminIds ?? settings.admins,
      keeperKey: groupKeeper,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    })

    session.router = new BridgeRouter({
      groupId: group.group_id,
      ...(resolved.locale ? { locale: resolved.locale } : {}),
      mode: settings.mode,
      busyNotice: settings.busyNotice,
      admins: settings.admins,
      postedIds: session.posted,
      keyring: session.keyring,
      settingsPath: settingsPath(resolved.state_dir, group.group_id),
      onIntent: (intent) => session.enqueue(intent),
      onKickClose: (_userId, memberKey) => {
        catalog.delete(memberKey)
        pool?.closeLink(memberKey)
      },
      onLog,
      now,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    })

    const observer = await session.keyring.ensureObserver()
    catalog.set(observer.key, { kind: "observer", groupId: group.group_id })
    await pool.open(observer.key, { name: observerName(group.group_id), idleClose: false })
  }

  transport.onMessage((msg) => onInbound(msg))

  async function onInbound(msg: OneBotInbound): Promise<void> {
    if (!transport || !pool) return
    if (isDroppedOneBotSender(msg)) return
    const session = await resolveSession(msg)
    if (!session) return
    const userId = msg.sender.userId
    if (msg.chatType === "group") lastGroupByUser.set(userId, session.groupId)

    const rate = session.limiter.take(userId)
    if (rate === "drop") return
    if (rate === "notice") {
      const text = tt(session.router.locale(), "bridge.rateLimited")
      if (msg.chatType === "private") {
        await transport.sendText({ type: "private", id: userId }, text)
      } else if (msg.messageId) {
        await transport.sendReply({ type: "group", id: session.groupId }, msg.messageId, text)
      } else {
        await transport.sendText({ type: "group", id: session.groupId }, text)
      }
      return
    }
    if (msg.chatType === "group" && msg.messageId) session.lastMessageId.set(userId, msg.messageId)

    try {
      const previousKey = memberKeyFor(userId, session.groupId)
      // The group card (else nickname) becomes the key name — what the Keeper calls them.
      const entry = await session.keyring.ensure(userId, msg.sender.name)
      const role: LinkRole = entry.role === "keeper" ? "admin" : "player"
      if (previousKey && previousKey !== entry.key) {
        catalog.delete(previousKey)
        session.router.detachLink(previousKey)
        pool.closeLink(previousKey)
      }
      catalog.set(entry.key, { kind: "member", groupId: session.groupId, userId, role })
      await pool.open(entry.key, {
        name: msg.sender.name,
        idleClose: playerIdleClose,
      })
      pool.touch(entry.key)

      await session.router.handleInbound(
        {
          userId,
          memberKey: entry.key,
          text: msg.text,
          channel: msg.chatType,
          mentioned: msg.atSelf,
          isAdmin: session.router.adminIds.map(String).includes(String(userId)),
        },
        async () => {
          const live = pool!.get(entry.key)
          if (!live) return
          for (const att of msg.attachments) {
            if (!isImageAttachment(att)) continue
            try {
              const bytes = await transport!.fetchAttachment(att)
              await live.uploadMedia({
                name: att.name || "image.png",
                mime: att.mime || "image/png",
                bytes,
                sha256: sha256Hex(bytes),
              })
            } catch (err) {
              // No direct URL, an expired signed link, SSRF, size, or the server's media
              // policy — the text still goes through; the operator gets ONE line saying why.
              onLog(
                tt(session.router.locale(), "bridge.cli.attachmentFailed", {
                  name: att.name || att.id || "?",
                  reason: attachmentFailureReason(err),
                }),
              )
            }
          }
        },
      )
    } catch {
      onLog(tt(session.router.locale(), "bridge.seatFailed"))
      const text = tt(session.router.locale(), "bridge.seatFailed")
      if (msg.chatType === "private") {
        await transport.sendText({ type: "private", id: userId }, text)
      } else if (msg.messageId) {
        await transport.sendReply({ type: "group", id: session.groupId }, msg.messageId, text)
      } else {
        await transport.sendText({ type: "group", id: session.groupId }, text)
      }
    }
  }

  function memberKeyFor(userId: string, groupId: string): string | undefined {
    for (const [key, meta] of catalog) {
      if (meta.kind === "member" && meta.userId === userId && meta.groupId === groupId) return key
    }
    return undefined
  }

  async function resolveSession(msg: OneBotInbound): Promise<GroupRuntime | undefined> {
    if (msg.chatType === "group") return sessions.get(msg.chatId)
    const userId = msg.sender.userId
    const last = lastGroupByUser.get(userId)
    if (last) {
      const hit = sessions.get(last)
      if (hit) return hit
    }
    for (const session of sessions.values()) {
      if (session.router.adminIds.map(String).includes(String(userId))) return session
      if (session.keyring.get(userId)) return session
    }
    if (!transport) return undefined
    for (const session of sessions.values()) {
      if (await transport.isGroupMember(session.groupId, userId)) return session
    }
    return undefined
  }

  const connected = await transport.connect()
  if (!connected) {
    const reason = transport.lastConnectError
    const key =
      reason === "onebot.auth_rejected"
        ? "bridge.cli.onebotAuthRejected"
        : reason === "onebot.self_check_failed"
          ? "bridge.cli.onebotSelfCheckFailed"
          : "bridge.cli.onebotConnectFailed"
    throw new Error(tt(resolved.locale, key))
  }

  onLog(tt(resolved.locale, "bridge.cli.ready", { groups: resolved.groups.map((g) => g.group_id).join(", ") }))

  let stopping = false
  let stoppedResolve!: () => void
  const stopped = new Promise<void>((resolve) => {
    stoppedResolve = resolve
  })

  const stop = async (): Promise<void> => {
    if (stopping) return stopped
    stopping = true
    if (deps.installSignals !== false) {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    }
    try {
      await teardown()
      onLog(tt(resolved.locale, "bridge.cli.shutdown"))
    } finally {
      stoppedResolve()
    }
    return stopped
  }

  const onSignal = () => {
    void stop()
  }
  if (deps.installSignals !== false) {
    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)
  }

  return {
    stop,
    stopped,
    ticket,
    hosted: Boolean(host),
    groups: resolved.groups.map((g) => g.group_id),
  }
  } catch (error) {
    await teardown()
    throw error
  }
}

export async function runBridgeFromFile(path: string, deps: BridgeDeps = {}): Promise<BridgeHandle> {
  const load = deps.loadConfig ?? loadBridgeConfig
  const config = await load(path)
  return runBridge(config, deps)
}
