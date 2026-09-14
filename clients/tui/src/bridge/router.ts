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
  runBridgeCommand,
  shouldForwardInbound,
  type BridgeCommandEffects,
} from "./commands"
import type { GroupMode } from "./config"
import type { Keyring } from "./keyring"
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
  onKickClose?: (userId: string, memberKey: string) => void
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  holdMs?: number
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
  private readonly lastNotAdmin = new Map<string, number>()
  private readonly holdTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private holdSeq = 0
  private lastTurn: "busy" | "idle" | undefined
  private mode: GroupMode
  private busyNotice: boolean
  private admins: string[]
  private welcomeLocale: string | undefined
  private duplicateHolds = 0
  private readonly holdMs: number
  private readonly now: () => number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(private readonly options: BridgeRouterOptions) {
    this.choices = options.choices ?? new ChoicesWindow()
    this.mode = options.mode ?? "mention"
    this.busyNotice = options.busyNotice ?? true
    this.admins = (options.admins ?? []).map(String)
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

  async handleInbound(msg: {
    userId: string
    memberKey: string
    text: string
    channel: InboundChannel
    mentioned?: boolean
    isAdmin: boolean
  }): Promise<void> {
    this.markChannel(msg.userId, msg.channel)
    const reply = (text: string) => {
      if (msg.channel === "private" || msg.isAdmin) this.emit({ dest: "private", userId: msg.userId, text })
      else this.emit({ dest: "reply", userId: msg.userId, text })
    }

    if (isBridgeCommand(msg.text)) {
      if (!msg.isAdmin) {
        const last = this.lastNotAdmin.get(msg.userId)
        if (last !== undefined && this.now() - last < NOT_ADMIN_COOLDOWN_MS) return
        this.lastNotAdmin.set(msg.userId, this.now())
      }
      const text = await runBridgeCommand(msg.text, msg.isAdmin, this.commandView(), this.commandEffects())
      if (text) reply(text)
      return
    }

    const choice = this.choices.match(msg.text, this.now())
    if (choice.kind === "hit") {
      this.queueInput(msg.memberKey, choice.input)
      return
    }
    if (
      shouldForwardInbound({
        text: msg.text,
        channel: msg.channel,
        mode: this.mode,
        mentioned: Boolean(msg.mentioned),
      })
    ) {
      this.queueInput(msg.memberKey, msg.text)
    }
  }

  private commandView() {
    const members = this.options.keyring?.list().map((row) => ({
      userId: row.userId,
      keyId: row.key_id,
      role: row.role,
    })) ?? []
    return {
      locale: this.locale(),
      groupId: this.options.groupId,
      mode: this.mode,
      busyNotice: this.busyNotice,
      admins: this.admins,
      members,
      lateHolds: this.duplicateHolds,
    }
  }

  private persistSettings(): void {
    if (!this.options.settingsPath) return
    void saveGroupSettings(this.options.settingsPath, {
      admins: this.admins,
      mode: this.mode,
      busyNotice: this.busyNotice,
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
        this.emit({
          dest: "group",
          text: frame.name,
          media: { hash: frame.hash, mime: frame.mime, name: frame.name },
        })
        return
      }
      case FrameType.AudioLibraryItem: {
        this.notePosted(key)
        this.emit({ dest: "group", text: frame.title || frame.name })
        return
      }
      case FrameType.TurnStatus: {
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
    if (frame.speaker === "kp") this.choices.close(this.now())
    const text =
      frame.speaker === "npc"
        ? renderNarrativeNpc(frame.name, frame.text, frame.format)
        : renderNarrativeText(frame.text, frame.format)
    this.emit({ dest: "group", text })
  }

  private onObserverDice(frame: DiceFrame, key: string | undefined): void {
    this.notePosted(key)
    this.emit({ dest: "group", text: diceLine(frame, this.locale()) })
  }

  private onObserverUi(frame: UiFrame, rendered: ReturnType<typeof renderUiBlocks> | undefined, key: string | undefined): void {
    const view = rendered ?? renderUiBlocks(frame.blocks)
    if (view.choices) this.choices.open(view.choices, this.now())
    this.notePosted(key)
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
    const channel = this.lastChannel.get(userId)
    if (channel === "group") this.emit({ dest: "reply", userId, text })
    else this.emit({ dest: "private", userId, text })
  }

  private onAdmin(slot: MemberSlot, frame: ServerFrame): void {
    if (frame.type === FrameType.System || frame.type === FrameType.Error) {
      const userId = slot.userId
      const text = unicastText(frame)
      if (userId && text) this.emit({ dest: "private", userId, text })
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
      const text = this.adminBroadcastText(frame, rendered)
      if (text) {
        if (seenKey) this.privatelySent.add(seenKey)
        this.emit({ dest: "private", userId, text })
      }
    }, this.holdMs)
    this.holdTimers.set(holdKey, timer)
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
