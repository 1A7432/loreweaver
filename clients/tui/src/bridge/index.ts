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
  OneBotTransport,
  type ChatTarget,
  type ConnectFactory,
  type FetchDeps,
  type OneBotInbound,
  type OneBotTransportOptions,
} from "./onebot"
import { PostedIds, postedPath } from "./postedIds"
import { BridgeRouter, type LinkRole, type OutboundIntent } from "./router"
import { loadGroupSettings, settingsPath } from "./settings"

export { loadBridgeConfig, parseBridgeConfig, BridgeConfigError } from "./config"
export type { BridgeConfig } from "./config"

type ControlLinkLike = {
  send(frame: ClientFrame): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
}

/** Fan-out control surface so a Keyring survives control-link redials. */
export class RelayingControl implements ControlLinkLike {
  private link: ControlLinkLike | undefined
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  private off: (() => void) | undefined

  bind(link: ControlLinkLike): void {
    this.off?.()
    this.link = link
    this.off = link.onMessage((frame) => {
      for (const handler of this.handlers) handler(frame)
    })
  }

  send(frame: ClientFrame): void {
    this.link?.send(frame)
  }

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => {
      this.handlers.delete(cb)
    }
  }
}

type LinkKind =
  | { kind: "control"; groupId: string }
  | { kind: "observer"; groupId: string }
  | { kind: "member"; groupId: string; userId: string }

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

export function isDroppedOneBotSender(msg: OneBotInbound): boolean {
  const selfId = msg.raw.self_id === undefined || msg.raw.self_id === null ? undefined : String(msg.raw.self_id)
  if (selfId !== undefined && msg.sender.userId === selfId) return true
  const sender = msg.raw.sender
  if (sender && typeof sender === "object") {
    const rec = sender as Record<string, unknown>
    if (rec.bot === true || rec.is_bot === true) return true
    if (String(rec.role ?? "").toLowerCase() === "bot") return true
  }
  if (msg.raw.anonymous && typeof msg.raw.anonymous === "object") return true
  return false
}

function isImageAttachment(att: { mime: string; name: string }): boolean {
  if (att.mime.toLowerCase().startsWith("image/")) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name)
}

class GroupRuntime {
  readonly control = new RelayingControl()
  readonly limiter: UserRateLimiter
  readonly lastMessageId = new Map<string, string>()
  observerLink: IrohLink | undefined
  private outbox: Promise<void> = Promise.resolve()
  router!: BridgeRouter
  keyring!: Keyring
  posted!: PostedIds

  constructor(
    readonly groupId: string,
    readonly group: BridgeGroupConfig,
    private readonly transport: OneBotTransport,
    now: () => number,
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
    const result = await this.transport.sendText({ type: "private", id: intent.userId }, intent.text)
    if (!result.ok) {
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
  if (!ticket) {
    onLog(tt(config.locale, "bridge.cli.hosting"))
    const log: OnLog = (text) => onLog(text)
    host = await hostLocal(log)
    ticket = host.host
    keeperKey = host.key
  }
  const resolved: BridgeConfig = { ...config, ticket, keeper_key: keeperKey }

  const sessions = new Map<string, GroupRuntime>()
  const catalog = new Map<string, LinkKind>()
  const lastGroupByUser = new Map<string, string>()

  const idleCloseMs =
    resolved.idle_close_minutes > 0 ? resolved.idle_close_minutes * 60 * 1000 : 30 * 60 * 1000
  const playerIdleClose = resolved.idle_close_minutes > 0

  const pool = new LinkPool({
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
      const role: LinkRole = session.keyring.get(meta.userId)?.role === "keeper" ? "admin" : "player"
      session.router.attachLink(role, memberKey, link, meta.userId, reason)
    },
    onLinkDown: (memberKey) => {
      const meta = catalog.get(memberKey)
      if (!meta || meta.kind === "control") return
      sessions.get(meta.groupId)?.router.onLinkDown(memberKey)
    },
  })
  await pool.connect(ticket)

  const transport =
    deps.transport ??
    new OneBotTransport({
      ...onebotTransportOptions(resolved),
      connectFactory: deps.connectFactory,
      httpGet: deps.httpGet,
      resolveAddresses: deps.resolveAddresses,
    })

  for (const group of resolved.groups) {
    const groupKeeper = roomKeeperKey(resolved, group)
    if (!groupKeeper) {
      pool.close()
      host?.stop()
      throw new Error(`group ${group.group_id} has no room keeper key`)
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
        pool.closeLink(memberKey)
      },
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
    if (isDroppedOneBotSender(msg)) return
    const session = resolveSession(msg)
    if (!session) return
    const userId = msg.sender.userId
    if (msg.chatType === "group") lastGroupByUser.set(userId, session.groupId)
    if (msg.messageId) session.lastMessageId.set(userId, msg.messageId)

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

    const entry = await session.keyring.ensure(userId)
    catalog.set(entry.key, { kind: "member", groupId: session.groupId, userId })
    const link = await pool.open(entry.key, {
      name: msg.sender.name,
      idleClose: playerIdleClose,
    })
    pool.touch(entry.key)

    for (const att of msg.attachments) {
      if (!isImageAttachment(att)) continue
      try {
        const bytes = await transport.fetchAttachment(att)
        await link.uploadMedia({
          name: att.name || "image.png",
          mime: att.mime || "image/png",
          bytes,
          sha256: sha256Hex(bytes),
        })
      } catch {
        // SSRF, size, or server media policy — skip this file, keep the text
      }
    }

    await session.router.handleInbound({
      userId,
      memberKey: entry.key,
      text: msg.text,
      channel: msg.chatType,
      mentioned: msg.atSelf,
      isAdmin: session.router.adminIds.map(String).includes(String(userId)),
    })
  }

  function resolveSession(msg: OneBotInbound): GroupRuntime | undefined {
    if (msg.chatType === "group") return sessions.get(msg.chatId)
    const last = lastGroupByUser.get(msg.sender.userId)
    if (last) {
      const hit = sessions.get(last)
      if (hit) return hit
    }
    if (sessions.size === 1) return [...sessions.values()][0]
    for (const session of sessions.values()) {
      if (session.router.adminIds.map(String).includes(String(msg.sender.userId))) return session
      if (session.keyring.get(msg.sender.userId)) return session
    }
    return undefined
  }

  const connected = await transport.connect()
  if (!connected) {
    pool.close()
    host?.stop()
    throw new Error("OneBot transport failed to connect")
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
      await transport.close()
      pool.close()
      for (const session of sessions.values()) {
        session.keyring.close()
        await session.posted.flush()
      }
      host?.stop()
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
}

export async function runBridgeFromFile(path: string, deps: BridgeDeps = {}): Promise<BridgeHandle> {
  const load = deps.loadConfig ?? loadBridgeConfig
  const config = await load(path)
  return runBridge(config, deps)
}
