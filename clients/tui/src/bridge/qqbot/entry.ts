import { bringUpServer, type HostHandle, type OnLog } from "../../hostLocal"
import { tt } from "../../i18n"
import type { IrohLink } from "../../irohLink"
import { sha256Hex } from "../../media"
import { clientInfo } from "../../version"
import {
  requireQQBot,
  roomKeeperKey,
  secondsToMs,
  type BridgeConfig,
  type BridgeGroupConfig,
} from "../config"
import type { BridgeDeps, BridgeHandle } from "../index"
import { Keyring, keyringPath, observerName } from "../keyring"
import { LinkPool } from "../linkPool"
import { UserRateLimiter } from "../limits"
import { fetchAttachment } from "../onebot/fetch"
import { PostedIds, postedPath } from "../postedIds"
import { BridgeRouter, type LinkRole } from "../router"
import {
  RelayingControl,
  attachmentFailureReason,
  isImageAttachment,
  redactKeeperSecrets,
} from "../runtime"
import { flushSettingsWrites, loadGroupSettings, settingsPath } from "../settings"
import { QQBotTransportPort } from "./adapter"
import { QQBotDeliverer } from "./deliverer"
import type { QQBotEvent, QQBotMessageEvent } from "./events"
import { C2CIdentityRouter, IdentityStore, identityPath } from "./identity"
import type { QQBotSwitchEvent } from "./port"
import { QQBotApiError } from "./shared"
import { QQBotTransport } from "./transport"

const STATUS_LOG_THROTTLE_MS = 60 * 1000

type LinkKind =
  | { kind: "control"; groupId: string }
  | { kind: "observer"; groupId: string }
  | { kind: "member"; groupId: string; userId: string; role: LinkRole }

class QQBotGroupRuntime {
  readonly control = new RelayingControl()
  readonly limiter: UserRateLimiter
  observerLink: IrohLink | undefined
  deliverer!: QQBotDeliverer
  router!: BridgeRouter
  keyring!: Keyring
  posted!: PostedIds
  identity!: IdentityStore

  constructor(
    readonly groupId: string,
    readonly group: BridgeGroupConfig,
    now: () => number,
  ) {
    this.limiter = new UserRateLimiter(undefined, undefined, now)
  }
}

function receivedAtMs(timestamp: string, fallback: number): number {
  if (!timestamp) return fallback
  const asNum = Number(timestamp)
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum < 1e12 ? asNum * 1000 : asNum
  }
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asSwitchEvent(event: QQBotEvent): QQBotSwitchEvent | undefined {
  if (event.type === "groupMsgReceive" || event.type === "groupMsgReject") {
    return { type: event.type, groupOpenid: event.groupOpenid }
  }
  if (event.type === "c2cMsgReceive" || event.type === "c2cMsgReject") {
    return { type: event.type, userOpenid: event.userOpenid }
  }
  return undefined
}

export async function runQQBotBridge(config: BridgeConfig, deps: BridgeDeps = {}): Promise<BridgeHandle> {
  const qqbot = requireQQBot(config)
  const secrets = [qqbot.client_secret]
  const rawLog = deps.onLog ?? ((text: string) => console.log(text))
  const onLog = (text: string) => rawLog(redactKeeperSecrets(text, secrets))
  const hostLocal = deps.hostLocal ?? bringUpServer
  const now = deps.now ?? Date.now

  let ticket = config.ticket
  let keeperKey = config.keeper_key
  let host: HostHandle | undefined
  let pool: LinkPool | undefined
  let transport: QQBotTransport | undefined
  const sessions = new Map<string, QQBotGroupRuntime>()
  const catalog = new Map<string, LinkKind>()
  let offTransport: (() => void) | undefined

  const teardown = async (): Promise<void> => {
    try {
      offTransport?.()
    } catch {
      // ignore
    }
    offTransport = undefined
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
        await session.identity.drainWrites()
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
      const log: OnLog = (text) => onLog(redactKeeperSecrets(text, secrets))
      host = await hostLocal(log)
      ticket = host.host
      keeperKey = host.key
    }
    const resolved: BridgeConfig = { ...config, ticket, keeper_key: keeperKey }
    const locale = resolved.locale

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
      deps.qqbotTransport ??
      new QQBotTransport({
        appId: qqbot.app_id,
        clientSecret: qqbot.client_secret,
        transport: "websocket",
        receiveAll: qqbot.receive_all,
        requestTimeoutMs: secondsToMs(qqbot.send_timeout),
      })
    const port = new QQBotTransportPort(transport)
    const sendTimeoutMs = secondsToMs(qqbot.send_timeout)

    const loggedAt = new Map<string, number>()
    const throttled = (kind: string): boolean => {
      const last = loggedAt.get(kind)
      if (last !== undefined && now() - last < STATUS_LOG_THROTTLE_MS) return true
      loggedAt.set(kind, now())
      return false
    }
    transport.onStatus((status) => {
      if (status !== "reconnecting" && status !== "offline") return
      if (throttled(status)) return
      onLog(
        tt(
          locale,
          status === "reconnecting" ? "bridge.qqbot.reconnecting" : "bridge.qqbot.offline",
        ),
      )
    })

    for (const group of resolved.groups) {
      const groupKeeper = roomKeeperKey(resolved, group)
      if (!groupKeeper) {
        throw new Error(tt(locale, "bridge.cli.missingGroupKey", { group: group.group_id }))
      }
      const session = new QQBotGroupRuntime(group.group_id, group, now)
      sessions.set(group.group_id, session)

      const settings = await loadGroupSettings(settingsPath(resolved.state_dir, group.group_id), {
        admins: group.admins,
        mode: group.mode,
        busyNotice: resolved.busy_notice,
      })
      session.posted = await PostedIds.load(postedPath(resolved.state_dir, group.group_id))
      session.identity = await IdentityStore.load(identityPath(resolved.state_dir, group.group_id), group.group_id, {
        now,
        onLog,
        locale,
      })

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

      session.deliverer = await QQBotDeliverer.load({
        groupOpenid: group.group_id,
        port,
        stateDir: resolved.state_dir,
        locale,
        busyNotice: settings.busyNotice,
        urlWhitelist: qqbot.url_whitelist,
        maxChunkChars: qqbot.max_chunk_chars,
        botQpm: qqbot.bot_qpm,
        sendTimeoutMs,
        resolveC2C: (seat) => session.identity.resolveC2C(seat),
        getMedia: async (hash) => {
          const observer = session.observerLink
          if (!observer?.isAlive) return undefined
          try {
            const payload = await observer.getMedia(hash)
            return { bytes: payload.bytes, mime: payload.mime }
          } catch {
            return undefined
          }
        },
        onLog,
        now,
        setTimeoutFn: deps.setTimeoutFn,
        clearTimeoutFn: deps.clearTimeoutFn,
      })

      session.router = new BridgeRouter({
        groupId: group.group_id,
        ...(locale ? { locale } : {}),
        mode: settings.mode,
        busyNotice: false,
        admins: settings.admins,
        postedIds: session.posted,
        keyring: session.keyring,
        settingsPath: settingsPath(resolved.state_dir, group.group_id),
        identity: session.identity,
        deferredSummary: () => session.deliverer.deferred.summary(now()),
        onIntent: (intent) => session.deliverer.enqueue(intent),
        onKickClose: (_userId, memberKey) => {
          catalog.delete(memberKey)
          pool?.closeLink(memberKey)
        },
        onSeatReminted: (_userId, previousKey) => {
          catalog.delete(previousKey)
          session.router.detachLink(previousKey)
          pool?.closeLink(previousKey)
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

    const c2cRouter = new C2CIdentityRouter(
      [...sessions.values()].map((session) => session.identity),
      { now, onLog },
    )

    const memberKeyFor = (userId: string, groupId: string): string | undefined => {
      for (const [key, meta] of catalog) {
        if (meta.kind === "member" && meta.userId === userId && meta.groupId === groupId) return key
      }
      return undefined
    }

    const closePrevious = (session: QQBotGroupRuntime, previousKey: string | undefined, nextKey: string) => {
      if (!previousKey || previousKey === nextKey) return
      catalog.delete(previousKey)
      session.router.detachLink(previousKey)
      pool?.closeLink(previousKey)
    }

    const bindSeat = async (
      session: QQBotGroupRuntime,
      userId: string,
      displayName: string | undefined,
    ) => {
      const previousKey = memberKeyFor(userId, session.groupId)
      const entry = await session.keyring.ensure(userId, displayName)
      closePrevious(session, previousKey, entry.key)
      const role: LinkRole = entry.role === "keeper" ? "admin" : "player"
      catalog.set(entry.key, { kind: "member", groupId: session.groupId, userId, role })
      await pool!.open(entry.key, { name: displayName, idleClose: playerIdleClose })
      pool!.touch(entry.key)
      return entry
    }

    const forwardAttachments = async (session: QQBotGroupRuntime, memberKey: string, msg: QQBotMessageEvent) => {
      const live = pool!.get(memberKey)
      if (!live) return
      for (const att of msg.attachments) {
        const name = att.filename || "image.png"
        const mime = att.contentType || "image/png"
        if (!isImageAttachment({ mime, name })) continue
        try {
          const bytes = await fetchAttachment(att.url, {
            httpGet: deps.httpGet,
            resolveAddresses: deps.resolveAddresses,
          })
          await live.uploadMedia({
            name,
            mime,
            bytes,
            sha256: sha256Hex(bytes),
          })
        } catch (err) {
          onLog(
            tt(session.router.locale(), "bridge.cli.attachmentFailed", {
              name,
              reason: attachmentFailureReason(err),
            }),
          )
        }
      }
    }

    const onGroupMessage = async (event: QQBotMessageEvent): Promise<void> => {
      const groupOpenid = event.groupOpenid
      const memberOpenid = event.memberOpenid
      if (!groupOpenid || !memberOpenid) return
      const session = sessions.get(groupOpenid)
      if (!session) {
        onLog(`qqbot.group.unknown ${groupOpenid}`)
        onLog(tt(locale, "bridge.qqbot.unknownGroup", { group: groupOpenid }))
        return
      }
      const rate = session.limiter.take(memberOpenid)
      if (rate === "drop") return
      const display = session.identity.displayNameFor(memberOpenid, { username: event.username }, session.router.locale())
      try {
        await session.deliverer.openAnchor({
          id: event.id,
          scope: "group",
          target: groupOpenid,
          seat: memberOpenid,
          receivedAt: receivedAtMs(event.timestamp, now()),
        })
        if (rate === "notice") {
          session.deliverer.enqueue({
            dest: "reply",
            userId: memberOpenid,
            text: tt(session.router.locale(), "bridge.rateLimited"),
          })
          return
        }
        const entry = await bindSeat(session, memberOpenid, display)
        await session.router.handleInbound(
          {
            userId: memberOpenid,
            memberKey: entry.key,
            text: event.content,
            channel: "group",
            mentioned: event.type === "groupAtMessage",
            isAdmin: session.router.adminIds.map(String).includes(String(memberOpenid)),
            memberOpenid,
            unionOpenid: event.unionOpenid,
            username: event.username,
          },
          () => forwardAttachments(session, entry.key, event),
        )
        const latest = await bindSeat(session, memberOpenid, display)
        const role: LinkRole = latest.role === "keeper" ? "admin" : "player"
        catalog.set(latest.key, { kind: "member", groupId: session.groupId, userId: memberOpenid, role })
        const live = pool.get(latest.key)
        if (live) session.router.attachLink(role, latest.key, live, memberOpenid)
      } catch {
        onLog(tt(session.router.locale(), "bridge.seatFailed"))
        session.deliverer.enqueue({
          dest: "reply",
          userId: memberOpenid,
          text: tt(session.router.locale(), "bridge.seatFailed"),
        })
      }
    }

    const onC2CMessage = async (event: QQBotMessageEvent): Promise<void> => {
      const userOpenid = event.userOpenid
      if (!userOpenid) return
      const classified = c2cRouter.classify(userOpenid, event.content)
      if (classified.kind === "ignore") return
      const session = sessions.get(classified.store.id)
      if (!session) return
      const rate = session.limiter.take(userOpenid)
      if (rate === "drop") return
      await session.deliverer.openAnchor({
        id: event.id,
        scope: "c2c",
        target: userOpenid,
        seat: classified.kind === "bound" ? classified.seat : undefined,
        receivedAt: receivedAtMs(event.timestamp, now()),
      })
      if (rate === "notice") {
        session.deliverer.enqueue({
          dest: "c2c_direct",
          userOpenid,
          text: tt(session.router.locale(), "bridge.rateLimited"),
        })
        return
      }
      if (classified.kind === "claim") {
        await session.router.handleInbound({
          userId: userOpenid,
          memberKey: userOpenid,
          text: event.content,
          channel: "private",
          isAdmin: false,
          userOpenid,
          unionOpenid: event.unionOpenid,
          username: event.username,
        })
        return
      }
      const seat = classified.seat
      const display = session.identity.displayNameFor(seat, { username: event.username }, session.router.locale())
      try {
        const entry = await bindSeat(session, seat, display)
        await session.router.handleInbound(
          {
            userId: seat,
            memberKey: entry.key,
            text: event.content,
            channel: "private",
            isAdmin: session.router.adminIds.map(String).includes(String(seat)),
            userOpenid,
            memberOpenid: seat,
            unionOpenid: event.unionOpenid,
            username: event.username,
          },
          () => forwardAttachments(session, entry.key, event),
        )
      } catch {
        onLog(tt(session.router.locale(), "bridge.seatFailed"))
      }
    }

    const onInboundEvent = (event: QQBotEvent): void => {
      const switchEvent = asSwitchEvent(event)
      if (switchEvent) {
        port.emitSwitch(switchEvent)
        return
      }
      if (event.type === "groupAddRobot") {
        if (!sessions.has(event.groupOpenid)) {
          onLog(`qqbot.group.unknown ${event.groupOpenid}`)
          onLog(tt(locale, "bridge.qqbot.unknownGroup", { group: event.groupOpenid }))
        }
        return
      }
      if (event.type === "groupDelRobot" || event.type === "friendAdd" || event.type === "friendDel") {
        return
      }
      if (event.type === "c2cMessage") {
        void onC2CMessage(event)
        return
      }
      if (event.type === "groupAtMessage" || event.type === "groupMessage") {
        void onGroupMessage(event)
      }
    }

    offTransport = transport.onEvent(onInboundEvent)

    try {
      await transport.start()
    } catch (err) {
      if (err instanceof QQBotApiError) {
        throw new Error(tt(locale, "bridge.qqbot.connectFailed"))
      }
      throw new Error(tt(locale, "bridge.qqbot.connectFailed"))
    }

    const login = transport.lastLogin
    onLog(
      tt(locale, "bridge.qqbot.loggedIn", {
        user: login.botOpenid || login.appId || "?",
        name: login.username || "?",
      }),
    )

    for (const session of sessions.values()) {
      const code = await session.identity.issueClaimCode()
      onLog(tt(locale, "bridge.qqbot.claimCode", { group: session.groupId, code }))
    }

    onLog(tt(locale, "bridge.cli.ready", { groups: resolved.groups.map((g) => g.group_id).join(", ") }))

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
        onLog(tt(locale, "bridge.cli.shutdown"))
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
