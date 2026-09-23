import type { ClientInfo } from "loreweaver-protocol"
import { bringUpServer, type HostHandle, type OnLog } from "../hostLocal"
import { tt } from "../i18n"
import { sha256Hex } from "../media"
import { clientInfo } from "../version"
import type { IrohLink, LoadIroh } from "../irohLink"
import {
  loadBridgeConfig,
  onebotTimeoutsMs,
  requireOneBot,
  roomKeeperKey,
  type BridgeConfig,
  type BridgeGroupConfig,
} from "./config"
import { Keyring, keyringPath, observerName } from "./keyring"
import { LinkPool } from "./linkPool"
import { UserRateLimiter } from "./limits"
import {
  OneBotTransport,
  type ConnectFactory,
  type FetchDeps,
  type OneBotInbound,
  type OneBotStatus,
  type OneBotTransportOptions,
} from "./onebot"
import { OneBotDeliverer } from "./deliverer"
import { PostedIds, postedPath } from "./postedIds"
import { BridgeRouter, type LinkRole, type OutboundIntent } from "./router"
import {
  RelayingControl,
  attachmentFailureReason,
  isImageAttachment,
  redactKeeperSecrets,
} from "./runtime"
import { flushSettingsWrites, loadGroupSettings, settingsPath } from "./settings"
import { runQQBotBridge } from "./qqbot/entry"
import type { QQBotTransport } from "./qqbot/transport"

export { loadBridgeConfig, parseBridgeConfig, BridgeConfigError } from "./config"
export type { BridgeConfig } from "./config"
export { RelayingControl, attachmentFailureReason, redactKeeperSecrets } from "./runtime"

const STATUS_LOG_THROTTLE_MS = 60 * 1000
/** Between startup dials while the OneBot implementation is not up yet. */
const STARTUP_RETRY_MS = 5 * 1000

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
  /** Official-bot path: inject a transport pointed at the WS1 fakes. */
  qqbotTransport?: QQBotTransport
  /** Delay between startup dials while OneBot is not up; 0 = fail on the first miss. */
  startupRetryMs?: number
}

export interface BridgeHandle {
  stop(): Promise<void>
  readonly stopped: Promise<void>
  readonly ticket: string
  readonly hosted: boolean
  readonly groups: readonly string[]
}

export function onebotTransportOptions(config: BridgeConfig): OneBotTransportOptions {
  const onebot = requireOneBot(config)
  const timeouts = onebotTimeoutsMs(onebot)
  if (onebot.mode === "forward") {
    return {
      mode: "forward",
      wsUrl: onebot.ws_url,
      accessToken: onebot.access_token,
      requestTimeoutMs: timeouts.requestTimeoutMs,
      reconnectDelayMs: timeouts.reconnectDelayMs,
    }
  }
  return {
    mode: "reverse",
    listenHost: onebot.listen_host,
    listenPort: onebot.listen_port,
    path: onebot.path,
    accessToken: onebot.access_token,
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

class GroupRuntime {
  readonly control = new RelayingControl()
  readonly limiter: UserRateLimiter
  readonly lastMessageId = new Map<string, string>()
  observerLink: IrohLink | undefined
  readonly deliverer: OneBotDeliverer
  router!: BridgeRouter
  keyring!: Keyring
  posted!: PostedIds

  constructor(
    readonly groupId: string,
    readonly group: BridgeGroupConfig,
    transport: OneBotTransport,
    now: () => number,
    onLog?: (text: string) => void,
  ) {
    this.limiter = new UserRateLimiter(undefined, undefined, now)
    this.deliverer = new OneBotDeliverer({
      groupId,
      transport,
      getObserver: () => this.observerLink,
      getLastReplyId: (userId) => this.lastMessageId.get(userId),
      getLocale: () => this.router?.locale() ?? "en",
      now,
      onLog,
    })
  }

  enqueue(intent: OutboundIntent): void {
    this.deliverer.enqueue(intent)
  }
}

export async function runBridge(config: BridgeConfig, deps: BridgeDeps = {}): Promise<BridgeHandle> {
  if (config.platform === "qqbot") return runQQBotBridge(config, deps)
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
        await session.deliverer.close()
      } catch {
        // ignore
      }
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
    const session = new GroupRuntime(group.group_id, group, transport, now, onLog)
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
      // Long text reaches the transport whole: over one message it becomes a forward card.
      textLimit: Number.POSITIVE_INFINITY,
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
    session.deliverer.attach(session.router)

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
      const previous = previousKey ? catalog.get(previousKey) : undefined
      // A new key (first seat, a rename) or the SAME key with a new role (an admin added
      // or removed — the key keeps its identity, so the character stays): either way the
      // live link joined under the old terms and must dial again.
      const roleChanged = previous?.kind === "member" && previous.role !== role
      if (previousKey && (previousKey !== entry.key || roleChanged)) {
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

  let connected = await transport.connect()
  // NapCat opens its OneBot port only once QQ is logged in, so a bridge started first (a
  // host reboot, a QR re-login in progress) waits for it instead of exiting — the same
  // patience the running bridge has for a dropped connection. A rejected token or an
  // endpoint that is not OneBot still fails at once: those never fix themselves.
  const retryMs = deps.startupRetryMs ?? STARTUP_RETRY_MS
  let waitingLogged = false
  while (!connected && retryMs > 0 && transport.lastConnectError === "onebot.websocket.connect_timeout") {
    if (!waitingLogged) {
      onLog(tt(resolved.locale, "bridge.cli.onebotWaiting"))
      waitingLogged = true
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs))
    connected = await transport.connect()
  }
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
