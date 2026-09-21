import {
  FrameType,
  type ClientFrame,
  type DiceFrame,
  type ErrorFrame,
  type NarrativeFrame,
  type ServerFrame,
  type SystemFrame,
  type UiFrame,
  type WelcomeFrame,
} from "loreweaver-protocol"
import { tt } from "../i18n"
import { ChoicesWindow } from "./choices"
import {
  isBridgeCommand,
  parseBridgeCommand,
  runBridgeCommand,
  shouldForwardInbound,
  type BridgeCommandEffects,
  type DeferredSummary,
} from "./commands"
import type { GroupMode } from "./config"
import type { Keyring } from "./keyring"
import type { IdentityStore } from "./qqbot/identity"
import type { LinkReadyReason } from "./linkPool"
import { observerSeenKey, type PostedIds } from "./postedIds"
import { diceLine } from "./render/dice"
import { renderNarrativeNpc, renderNarrativeText, splitText } from "./render/narrative"
import { renderUiBlocks, type BridgeMediaRef } from "./render/uiText"
import { saveGroupSettings } from "./settings"

export const ADMIN_HOLD_MS = 2000
export const STATE_UNGATE_MS = 2000
export const QUEUE_CAP = 50
export const OBSERVER_SEEN_CAP = 4096
export const NOT_ADMIN_COOLDOWN_MS = 30_000

export type LinkRole = "observer" | "player" | "admin"
export type InboundChannel = "group" | "private"
/** Classified outbound scope handed to a `FrameSink` before plain-text rendering. */
export type FrameScope = "group" | "player" | "admin"

export interface SinkEvent {
  scope: FrameScope
  seat?: string
  frame: ServerFrame
  /** Channel the seat last typed on. Observer frames are always `"group"`. */
  channel: InboundChannel
}

export type FrameSink = (event: SinkEvent) => void

export type OutboundIntent =
  | { dest: "group"; text: string; media?: BridgeMediaRef }
  | { dest: "reply"; userId: string; text: string }
  | { dest: "private"; userId: string; text: string }

export interface BridgeLink {
  send(frame: ClientFrame): void
  sendInput(text: string): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
  readonly isAlive: boolean
}

const NEVER_RENDER = new Set<string>([
  FrameType.State,
  FrameType.UiManifest,
  FrameType.Presence,
  FrameType.NarrativeDelta,
  FrameType.PanelEvent,
  FrameType.Pong,
  FrameType.Welcome,
])

class CappedSet {
  private readonly ids = new Set<string>()
  private readonly order: string[] = []
  constructor(private readonly cap: number) {}
  has(id: string): boolean {
    return this.ids.has(id)
  }
  add(id: string): void {
    if (!id || this.ids.has(id)) return
    this.ids.add(id)
    this.order.push(id)
    while (this.order.length > this.cap) {
      const oldest = this.order.shift()
      if (oldest) this.ids.delete(oldest)
    }
  }
}

interface MemberSlot {
  role: LinkRole
  memberKey: string
  userId?: string
  link: BridgeLink
  off: () => void
  gated: boolean
  reason: LinkReadyReason
  stateUngate?: ReturnType<typeof setTimeout>
}

export interface BridgeRouterOptions {
  groupId: string
  /** Config override. When omitted, locale comes from the observer's `welcome`. */
  locale?: string
  mode?: GroupMode
  busyNotice?: boolean
  admins?: string[]
  postedIds: PostedIds
  choices?: ChoicesWindow
  keyring?: Keyring
  settingsPath?: string
  onIntent: (intent: OutboundIntent) => void
  /**
   * Frame-level hand-off AFTER role/kind classification and BEFORE plain-text
   * rendering. When set, the router does not emit `onIntent` for that frame
   * (the deliverer owns rendering, busy notice, and the choices window).
   * The OneBot path leaves this unset and keeps today's render-and-send path.
   */
  sink?: FrameSink
  onKickClose?: (userId: string, memberKey: string) => void
  onLog?: (text: string) => void
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  holdMs?: number
  /** QQ official-bot identity. Unset on the OneBot path. */
  identity?: IdentityStore
  hasCharacter?: (seat: string) => boolean
  deferredSummary?: () => DeferredSummary
  /** Old seat key after `.bridge name` remint; WS4 closes the previous link. */
  onSeatReminted?: (userId: string, previousKey: string) => void
}

/**
 * Three-role routing + per-link replay gate. Observer frames become group
 * posts; player `system`/`error` become reply-to (or private if the input
 * came from private chat); admin unicast is always private; admin broadcast
 * kinds are held and dropped if the observer saw the same seen-key.
 */
export class BridgeRouter {
  readonly choices: ChoicesWindow
  private readonly slots = new Map<string, MemberSlot>()
  private readonly down = new Set<string>()
  private readonly queues = new Map<string, string[]>()
  private readonly observerSeen = new CappedSet(OBSERVER_SEEN_CAP)
  private readonly privatelySent = new CappedSet(OBSERVER_SEEN_CAP)
  private readonly lastChannel = new Map<string, InboundChannel>()
  private readonly inputChannels = new Map<string, InboundChannel[]>()
  private readonly lastNotAdmin = new Map<string, number>()
  private readonly holdTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private holdSeq = 0
  private lastTurn: "busy" | "idle" | undefined
  private mode: GroupMode
  private busyNotice: boolean
  private admins: string[]
  private welcomeLocale: string | undefined
  private duplicateHolds = 0
  private sink: FrameSink | undefined
  private readonly holdMs: number
  private readonly now: () => number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(private readonly options: BridgeRouterOptions) {
    this.choices = options.choices ?? new ChoicesWindow()
    this.mode = options.mode ?? "mention"
    this.busyNotice = options.busyNotice ?? true
    this.admins = (options.admins ?? []).map(String)
    this.sink = options.sink
    this.holdMs = options.holdMs ?? ADMIN_HOLD_MS
    this.now = options.now ?? Date.now
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  }

  get groupMode(): GroupMode {
    return this.mode
  }

  get noticeOn(): boolean {
    return this.busyNotice
  }

  get adminIds(): readonly string[] {
    return this.admins
  }

  get lateHolds(): number {
    return this.duplicateHolds
  }

  locale(): string {
    return this.options.locale || this.welcomeLocale || "en"
  }

  /** Register (or clear) the pre-render frame sink. Used by `Deliverer.attach`. */
  setSink(sink: FrameSink | undefined): void {
    this.sink = sink
  }

  /**
   * Re-arm the replay gate on every `onLinkReady`. Observer + `"open"`: full
   * gate. Observer + `"redial"`: narrative passes (deduped by postedIds);
   * dice/ui/media/audio/turn_status stay gated. Player/admin: full gate always.
   */
  attachLink(role: LinkRole, memberKey: string, link: BridgeLink, userId?: string, reason: LinkReadyReason = "open"): void {
    const existing = this.slots.get(memberKey)
    existing?.off()
    if (existing?.stateUngate) this.clearTimeoutFn(existing.stateUngate)
    this.down.delete(memberKey)
    const slot: MemberSlot = {
      role,
      memberKey,
      userId,
      link,
      gated: true,
      reason,
      off: () => {},
    }
    slot.off = link.onMessage((frame) => this.onFrame(slot, frame))
    this.slots.set(memberKey, slot)
  }

  onLinkDown(memberKey: string): void {
    this.down.add(memberKey)
  }

  detachLink(memberKey: string): void {
    const slot = this.slots.get(memberKey)
    slot?.off()
    if (slot?.stateUngate) this.clearTimeoutFn(slot.stateUngate)
    this.slots.delete(memberKey)
    this.down.delete(memberKey)
    this.queues.delete(memberKey)
    const prefix = `${memberKey}:`
    for (const [key, timer] of this.holdTimers) {
      if (key.startsWith(prefix)) {
        this.clearTimeoutFn(timer)
        this.holdTimers.delete(key)
      }
    }
  }

  markChannel(userId: string, channel: InboundChannel): void {
    this.lastChannel.set(userId, channel)
  }

  queueInput(memberKey: string, text: string): void {
    const slot = this.slots.get(memberKey)
    if (!slot || slot.gated || this.down.has(memberKey) || !slot.link.isAlive) {
      const queue = this.queues.get(memberKey) ?? []
      queue.push(text)
      while (queue.length > QUEUE_CAP) queue.shift()
      this.queues.set(memberKey, queue)
      return
    }
    slot.link.sendInput(text)
  }

  async handleInbound(
    msg: {
      userId: string
      memberKey: string
      text: string
      channel: InboundChannel
      mentioned?: boolean
      isAdmin: boolean
      userOpenid?: string
      memberOpenid?: string
      unionOpenid?: string
      username?: string
    },
    onForward?: () => Promise<void>,
  ): Promise<boolean> {
    this.markChannel(msg.userId, msg.channel)
    const userOpenid = msg.userOpenid ?? (msg.channel === "private" ? msg.userId : undefined)
    const memberOpenid =
      msg.memberOpenid ?? (msg.channel === "group" ? msg.userId : this.options.identity?.seatForC2C(userOpenid ?? ""))
    const unionOpenid = msg.unionOpenid?.trim() || undefined

    let unionBound: { memberOpenid: string; userOpenid: string } | undefined
    if (this.options.identity && msg.channel === "group" && memberOpenid && unionOpenid) {
      unionBound = await this.options.identity.tryUnionLink({ memberOpenid, unionOpenid })
    }

    const reply = (text: string) => {
      if (msg.channel === "private" || msg.isAdmin) this.emit({ dest: "private", userId: msg.userId, text })
      else this.emit({ dest: "reply", userId: msg.userId, text })
    }

    if (isBridgeCommand(msg.text)) {
      const parsed = parseBridgeCommand(msg.text)
      const isClaim = parsed?.name === "claim"
      const isName = parsed?.name === "name" && Boolean(this.options.identity)
      if (!msg.isAdmin && !isClaim && !isName) {
        const last = this.lastNotAdmin.get(msg.userId)
        if (last !== undefined && this.now() - last < NOT_ADMIN_COOLDOWN_MS) return false
        this.lastNotAdmin.set(msg.userId, this.now())
      }
      const text = await runBridgeCommand(
        msg.text,
        msg.isAdmin,
        this.commandView({
          channel: msg.channel,
          seat: memberOpenid ?? msg.userId,
          userOpenid,
          memberOpenid,
          unionOpenid,
          username: msg.username,
        }),
        this.commandEffects(),
      )
      if (text) {
        if (isClaim) {
          if (msg.channel === "private") this.emit({ dest: "private", userId: msg.userId, text })
          else this.emit({ dest: "reply", userId: msg.userId, text })
        } else {
          reply(text)
        }
      }
      return false
    }

    if (unionBound) await this.promoteBoundAdmin(unionBound.memberOpenid, msg.username)

    const choice = this.choices.match(msg.text, this.now())
    if (choice.kind === "hit") {
      if (onForward) await onForward()
      this.noteInputChannel(msg.userId, msg.channel)
      this.queueInput(msg.memberKey, choice.input)
      return true
    }
    if (
      shouldForwardInbound({
        text: msg.text,
        channel: msg.channel,
        mode: this.mode,
        mentioned: Boolean(msg.mentioned),
      })
    ) {
      if (onForward) await onForward()
      this.noteInputChannel(msg.userId, msg.channel)
      this.queueInput(msg.memberKey, msg.text)
      return true
    }
    return false
  }

  private noteInputChannel(userId: string, channel: InboundChannel): void {
    const queue = this.inputChannels.get(userId) ?? []
    queue.push(channel)
    this.inputChannels.set(userId, queue)
  }

  private consumeInputChannel(userId: string): InboundChannel | undefined {
    const queue = this.inputChannels.get(userId)
    if (queue && queue.length > 0) return queue.shift()
    return this.lastChannel.get(userId)
  }

  private commandView(
    extra: {
      channel?: InboundChannel
      seat?: string
      userOpenid?: string
      memberOpenid?: string
      unionOpenid?: string
      username?: string
    } = {},
  ) {
    const members = this.options.keyring?.list().map((row) => ({
      userId: row.userId,
      keyId: row.key_id,
      role: row.role,
      name: row.name ?? "",
    })) ?? []
    return {
      locale: this.locale(),
      groupId: this.options.groupId,
      mode: this.mode,
      busyNotice: this.busyNotice,
      admins: this.admins,
      members,
      lateHolds: this.duplicateHolds,
      deferredSummary: this.options.deferredSummary?.(),
      ...extra,
    }
  }

  private persistSettings(): void {
    if (!this.options.settingsPath) return
    void saveGroupSettings(this.options.settingsPath, {
      admins: this.admins,
      mode: this.mode,
      busyNotice: this.busyNotice,
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.onLog?.(`bridge.settings_save_failed ${detail}`)
    })
  }

  private commandEffects(): BridgeCommandEffects {
    return {
      setMode: (mode) => {
        this.mode = mode
        this.persistSettings()
      },
      setBusyNotice: (on) => {
        this.busyNotice = on
        this.persistSettings()
      },
      addAdmin: (userId) => {
        if (!this.admins.includes(userId)) this.admins.push(userId)
        this.persistSettings()
      },
      removeAdmin: (userId) => {
        this.admins = this.admins.filter((id) => id !== userId)
        this.persistSettings()
      },
      kick: async (userId) => {
        const keyring = this.options.keyring
        if (!keyring) throw new Error("no keyring")
        const entry = await keyring.kick(userId)
        this.options.onKickClose?.(userId, entry.key)
        for (const [memberKey, slot] of [...this.slots]) {
          if (slot.userId === userId || memberKey === entry.key) this.detachLink(memberKey)
        }
      },
      identity: this.options.identity,
      hasCharacter: this.options.hasCharacter,
      remintSeat: async (userId, displayName) => {
        const keyring = this.options.keyring
        if (!keyring) return { name: displayName }
        const previous = keyring.get(userId)
        const { previous: remintedPrev, entry } = await keyring.remint(userId, displayName)
        const previousKey = (remintedPrev ?? previous)?.key
        return { previousKey: previousKey && previousKey !== entry.key ? previousKey : undefined, name: entry.name ?? displayName }
      },
      onSeatReminted: this.options.onSeatReminted,
    }
  }

  private async promoteBoundAdmin(memberOpenid: string, username?: string): Promise<void> {
    if (!this.admins.includes(memberOpenid)) {
      this.admins.push(memberOpenid)
      this.persistSettings()
    }
    const keyring = this.options.keyring
    if (!keyring) return
    const identity = this.options.identity
    const display = identity?.displayNameFor(memberOpenid, { username }, this.locale()) ?? username
    const previous = keyring.get(memberOpenid)
    try {
      const entry = await keyring.ensure(memberOpenid, display)
      const previousKey = previous?.key
      if (previousKey && previousKey !== entry.key) this.options.onSeatReminted?.(memberOpenid, previousKey)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.onLog?.(`qqbot.claim.mint_failed ${detail}`)
    }
  }

  private effectiveRole(slot: MemberSlot): LinkRole {
    if (slot.role === "observer") return "observer"
    if (slot.userId && this.options.keyring?.get(slot.userId)?.role === "keeper" && slot.role === "player") {
      console.warn("bridge: keeper-keyed link mislabeled player; treating as admin")
      return "admin"
    }
    return slot.role
  }

  private onFrame(slot: MemberSlot, frame: ServerFrame): void {
    if (frame.type === FrameType.Welcome) {
      this.onWelcome(slot, frame)
      return
    }
    if (frame.type === FrameType.UiManifest) {
      this.ungate(slot)
      return
    }
    if (frame.type === FrameType.State) {
      this.armStateUngate(slot)
      return
    }
    if (slot.gated) {
      if (slot.role === "observer" && slot.reason === "redial" && frame.type === FrameType.Narrative) {
        this.onObserver(frame)
      }
      return
    }
    if (NEVER_RENDER.has(frame.type)) return
    const role = this.effectiveRole(slot)
    if (role === "observer") this.onObserver(frame)
    else if (role === "player") this.onPlayer(slot, frame)
    else this.onAdmin(slot, frame)
  }

  private onWelcome(_slot: MemberSlot, frame: WelcomeFrame): void {
    if (!this.options.locale && frame.locale) this.welcomeLocale = frame.locale
  }

  private ungate(slot: MemberSlot): void {
    if (slot.stateUngate) {
      this.clearTimeoutFn(slot.stateUngate)
      slot.stateUngate = undefined
    }
    if (slot.gated) {
      slot.gated = false
      this.flush(slot.memberKey)
    }
  }

  private armStateUngate(slot: MemberSlot): void {
    if (!slot.gated || slot.stateUngate) return
    slot.stateUngate = this.setTimeoutFn(() => {
      slot.stateUngate = undefined
      if (slot.gated) this.ungate(slot)
    }, STATE_UNGATE_MS)
  }

  private flush(memberKey: string): void {
    const slot = this.slots.get(memberKey)
    if (!slot || slot.gated || this.down.has(memberKey) || !slot.link.isAlive) return
    const queue = this.queues.get(memberKey)
    if (!queue?.length) return
    this.queues.set(memberKey, [])
    for (const text of queue) slot.link.sendInput(text)
  }

  private onObserver(frame: ServerFrame): void {
    const rendered = frame.type === FrameType.Ui ? renderUiBlocks(frame.blocks) : undefined
    const key = observerSeenKey(frame, rendered ? { lines: rendered.lines, mediaHashes: rendered.media.map((item) => item.hash) } : undefined)
    if (key) this.observerSeen.add(key)

    switch (frame.type) {
      case FrameType.Narrative:
        this.onObserverNarrative(frame, key)
        return
      case FrameType.Dice:
        this.onObserverDice(frame, key)
        return
      case FrameType.Ui:
        this.onObserverUi(frame, rendered, key)
        return
      case FrameType.Media: {
        this.notePosted(key)
        if (this.handoff("group", frame)) return
        this.emit({
          dest: "group",
          text: frame.name,
          media: { hash: frame.hash, mime: frame.mime, name: frame.name },
        })
        return
      }
      case FrameType.AudioLibraryItem: {
        this.notePosted(key)
        if (this.handoff("group", frame)) return
        this.emit({ dest: "group", text: frame.title || frame.name })
        return
      }
      case FrameType.TurnStatus: {
        if (this.handoff("group", frame)) return
        if (frame.status === "idle") {
          this.lastTurn = "idle"
          return
        }
        if (frame.status === "busy") {
          if (this.busyNotice && this.lastTurn !== "busy") {
            this.emit({ dest: "group", text: tt(this.locale(), "bridge.busy") })
          }
          this.lastTurn = "busy"
        }
        return
      }
      default:
        return
    }
  }

  private notePosted(key: string | undefined): void {
    if (key && this.privatelySent.has(key)) this.duplicateHolds += 1
  }

  private onObserverNarrative(frame: NarrativeFrame, key: string | undefined): void {
    if (frame.speaker === "player") return
    if (!frame.text) return
    if (this.options.postedIds.has(frame.id)) return
    void this.options.postedIds.add(frame.id)
    this.notePosted(key)
    if (this.handoff("group", frame)) return
    if (frame.speaker === "kp") this.choices.close(this.now())
    const text =
      frame.speaker === "npc"
        ? renderNarrativeNpc(frame.name, frame.text, frame.format)
        : renderNarrativeText(frame.text, frame.format)
    this.emit({ dest: "group", text })
  }

  private onObserverDice(frame: DiceFrame, key: string | undefined): void {
    this.notePosted(key)
    if (this.handoff("group", frame)) return
    this.emit({ dest: "group", text: diceLine(frame, this.locale()) })
  }

  private onObserverUi(frame: UiFrame, rendered: ReturnType<typeof renderUiBlocks> | undefined, key: string | undefined): void {
    const view = rendered ?? renderUiBlocks(frame.blocks)
    this.notePosted(key)
    if (this.handoff("group", frame)) return
    if (view.choices) this.choices.open(view.choices, this.now())
    const text = view.lines.join("\n")
    if (text) this.emit({ dest: "group", text })
    for (const media of view.media) {
      this.emit({ dest: "group", text: media.name || "", media })
    }
  }

  private onPlayer(slot: MemberSlot, frame: ServerFrame): void {
    if (frame.type !== FrameType.System && frame.type !== FrameType.Error) return
    const userId = slot.userId
    if (!userId) return
    const text = unicastText(frame)
    if (!text) return
    const channel = this.consumeInputChannel(userId) ?? "group"
    if (this.handoff("player", frame, userId, channel)) return
    if (channel === "group") this.emit({ dest: "reply", userId, text })
    else this.emit({ dest: "private", userId, text })
  }

  private onAdmin(slot: MemberSlot, frame: ServerFrame): void {
    if (frame.type === FrameType.System || frame.type === FrameType.Error) {
      const userId = slot.userId
      const text = unicastText(frame)
      if (userId && text) {
        const channel = this.consumeInputChannel(userId) ?? this.lastChannel.get(userId) ?? "private"
        if (this.handoff("admin", frame, userId, channel)) return
        this.emit({ dest: "private", userId, text })
      }
      return
    }
    const userId = slot.userId
    if (!userId) return
    const rendered = frame.type === FrameType.Ui ? renderUiBlocks(frame.blocks) : undefined
    const seenKey = observerSeenKey(frame, rendered ? { lines: rendered.lines, mediaHashes: rendered.media.map((item) => item.hash) } : undefined)
    const holdKey = `${slot.memberKey}:${seenKey ?? `anon:${++this.holdSeq}`}`
    const timer = this.setTimeoutFn(() => {
      this.holdTimers.delete(holdKey)
      if (seenKey && this.observerSeen.has(seenKey)) return
      const channel = this.lastChannel.get(userId) ?? "private"
      if (this.handoff("admin", frame, userId, channel)) return
      const text = this.adminBroadcastText(frame, rendered)
      if (text) {
        if (seenKey) this.privatelySent.add(seenKey)
        this.emit({ dest: "private", userId, text })
      }
    }, this.holdMs)
    this.holdTimers.set(holdKey, timer)
  }

  /**
   * Hand a classified frame to the registered sink. Returns true when the
   * caller must skip the plain-text `onIntent` path (qqbot). OneBot leaves
   * the sink unset, so this is always false there.
   */
  private handoff(scope: FrameScope, frame: ServerFrame, seat?: string, channel: InboundChannel = "group"): boolean {
    if (!this.sink) return false
    try {
      this.sink(seat ? { scope, seat, frame, channel } : { scope, frame, channel })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.onLog?.(`bridge.sink_failed ${detail}`)
    }
    return true
  }

  private adminBroadcastText(frame: ServerFrame, rendered?: ReturnType<typeof renderUiBlocks>): string {
    switch (frame.type) {
      case FrameType.Narrative:
        if (!frame.text) return ""
        return frame.speaker === "npc"
          ? renderNarrativeNpc(frame.name, frame.text, frame.format)
          : renderNarrativeText(frame.text, frame.format)
      case FrameType.Dice:
        return diceLine(frame, this.locale())
      case FrameType.Ui:
        return (rendered ?? renderUiBlocks(frame.blocks)).lines.join("\n")
      case FrameType.Media:
        return frame.name
      case FrameType.AudioLibraryItem:
        return frame.title || frame.name
      default:
        return ""
    }
  }

  private emit(intent: OutboundIntent): void {
    if (intent.dest === "group" && intent.media && !intent.text) {
      this.options.onIntent(intent)
      return
    }
    const parts = splitText(intent.text)
    parts.forEach((part, index) => {
      if (intent.dest === "group") {
        this.options.onIntent({
          dest: "group",
          text: part,
          media: index === 0 ? intent.media : undefined,
        })
      } else {
        this.options.onIntent({ ...intent, text: part })
      }
    })
  }
}

function unicastText(frame: SystemFrame | ErrorFrame): string {
  if (frame.type === FrameType.System) return frame.text
  return frame.message
}
