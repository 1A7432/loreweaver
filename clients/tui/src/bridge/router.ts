import {
  FrameType,
  type ClientFrame,
  type DiceFrame,
  type ErrorFrame,
  type NarrativeFrame,
  type ServerFrame,
  type SystemFrame,
  type UiFrame,
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
import { LastKeeperError, type Keyring } from "./keyring"
import { dicePostedId, type PostedIds } from "./postedIds"
import { diceLine } from "./render/dice"
import { renderNarrativeNpc, renderNarrativeText, splitText } from "./render/narrative"
import { renderUiBlocks, type BridgeMediaRef } from "./render/uiText"

export const ADMIN_HOLD_MS = 1000

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

function frameId(frame: ServerFrame): string | undefined {
  if ("id" in frame && typeof (frame as { id?: unknown }).id === "string") {
    const id = (frame as { id: string }).id
    return id || undefined
  }
  return undefined
}

interface MemberSlot {
  role: LinkRole
  memberKey: string
  userId?: string
  link: BridgeLink
  off: () => void
  gated: boolean
}

export interface BridgeRouterOptions {
  groupId: string
  locale?: string
  mode?: GroupMode
  busyNotice?: boolean
  admins?: string[]
  postedIds: PostedIds
  choices?: ChoicesWindow
  keyring?: Keyring
  onIntent: (intent: OutboundIntent) => void
  /** Close the playing link after a successful kick. */
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
 * kinds are held 1 s and dropped if the observer saw the same `id`.
 * `state` / `ui_manifest` are never rendered.
 */
export class BridgeRouter {
  readonly choices: ChoicesWindow
  private readonly slots = new Map<string, MemberSlot>()
  private readonly down = new Set<string>()
  private readonly queues = new Map<string, string[]>()
  private readonly observerSeen = new Set<string>()
  private readonly lastChannel = new Map<string, InboundChannel>()
  private readonly holdTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastTurn: "busy" | "idle" | undefined
  private mode: GroupMode
  private busyNotice: boolean
  private admins: string[]
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

  /**
   * Re-arm the replay gate on every `onLinkReady` (`open` and `redial`).
   * Subscriptions do not migrate across redials — attach the new link here.
   */
  attachLink(role: LinkRole, memberKey: string, link: BridgeLink, userId?: string): void {
    const existing = this.slots.get(memberKey)
    existing?.off()
    this.down.delete(memberKey)
    const slot: MemberSlot = {
      role,
      memberKey,
      userId,
      link,
      gated: true,
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
    if (!slot || slot.gated || this.down.has(memberKey)) {
      const queue = this.queues.get(memberKey) ?? []
      queue.push(text)
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
      const text = await runBridgeCommand(msg.text, msg.isAdmin, this.commandView(), this.commandEffects())
      if (text) reply(text)
      return
    }

    const choice = this.choices.match(msg.text, this.now())
    if (choice.kind === "hit") {
      this.queueInput(msg.memberKey, choice.input)
      return
    }
    if (choice.kind === "expired") {
      this.queueInput(msg.memberKey, msg.text)
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
      locale: this.options.locale,
      groupId: this.options.groupId,
      mode: this.mode,
      busyNotice: this.busyNotice,
      admins: this.admins,
      members,
    }
  }

  private commandEffects(): BridgeCommandEffects {
    return {
      setMode: (mode) => {
        this.mode = mode
      },
      setBusyNotice: (on) => {
        this.busyNotice = on
      },
      addAdmin: (userId) => {
        if (!this.admins.includes(userId)) this.admins.push(userId)
      },
      removeAdmin: (userId) => {
        this.admins = this.admins.filter((id) => id !== userId)
      },
      kick: async (userId) => {
        const keyring = this.options.keyring
        if (!keyring) throw new Error("no keyring")
        try {
          const entry = await keyring.kick(userId)
          this.options.onKickClose?.(userId, entry.key)
          for (const [memberKey, slot] of this.slots) {
            if (slot.userId === userId || memberKey === entry.key) this.detachLink(memberKey)
          }
        } catch (error) {
          if (error instanceof LastKeeperError) throw error
          throw error
        }
      },
    }
  }

  private onFrame(slot: MemberSlot, frame: ServerFrame): void {
    if (frame.type === FrameType.UiManifest) {
      if (slot.gated) {
        slot.gated = false
        this.flush(slot.memberKey)
      }
      return
    }
    if (slot.gated) return
    if (NEVER_RENDER.has(frame.type)) return
    if (slot.role === "observer") this.onObserver(frame)
    else if (slot.role === "player") this.onPlayer(slot, frame)
    else this.onAdmin(slot, frame)
  }

  private flush(memberKey: string): void {
    const slot = this.slots.get(memberKey)
    if (!slot || slot.gated || this.down.has(memberKey)) return
    const queue = this.queues.get(memberKey)
    if (!queue?.length) return
    this.queues.set(memberKey, [])
    for (const text of queue) slot.link.sendInput(text)
  }

  private onObserver(frame: ServerFrame): void {
    const id = frameId(frame)
    if (id) this.observerSeen.add(id)

    switch (frame.type) {
      case FrameType.Narrative:
        this.onObserverNarrative(frame)
        return
      case FrameType.Dice:
        this.onObserverDice(frame)
        return
      case FrameType.Ui:
        this.onObserverUi(frame)
        return
      case FrameType.Media: {
        this.emit({
          dest: "group",
          text: frame.name,
          media: { hash: frame.hash, mime: frame.mime, name: frame.name },
        })
        return
      }
      case FrameType.AudioLibraryItem: {
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
            this.emit({ dest: "group", text: tt(this.options.locale, "bridge.busy") })
          }
          this.lastTurn = "busy"
        }
        return
      }
      default:
        return
    }
  }

  private onObserverNarrative(frame: NarrativeFrame): void {
    if (frame.speaker === "player") return
    if (!frame.text) return
    if (this.options.postedIds.has(frame.id)) return
    void this.options.postedIds.add(frame.id)
    if (frame.speaker === "kp") this.choices.close()
    const text =
      frame.speaker === "npc"
        ? renderNarrativeNpc(frame.name, frame.text, frame.format)
        : renderNarrativeText(frame.text, frame.format)
    for (const part of splitText(text)) this.emit({ dest: "group", text: part })
  }

  private onObserverDice(frame: DiceFrame): void {
    const id = dicePostedId(frame)
    if (this.options.postedIds.has(id)) return
    void this.options.postedIds.add(id)
    this.emit({ dest: "group", text: diceLine(frame) })
  }

  private onObserverUi(frame: UiFrame): void {
    const rendered = renderUiBlocks(frame.blocks)
    if (rendered.choices) this.choices.open(rendered.choices, this.now())
    const text = rendered.lines.join("\n")
    if (text) this.emit({ dest: "group", text })
    for (const media of rendered.media) {
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
    const id = frameId(frame)
    const userId = slot.userId
    if (!userId) return
    const holdKey = `${slot.memberKey}:${id ?? `${frame.type}:${this.now()}`}`
    const timer = this.setTimeoutFn(() => {
      this.holdTimers.delete(holdKey)
      if (id && this.observerSeen.has(id)) return
      const text = adminBroadcastText(frame)
      if (text) this.emit({ dest: "private", userId, text })
    }, this.holdMs)
    this.holdTimers.set(holdKey, timer)
  }

  private emit(intent: OutboundIntent): void {
    this.options.onIntent(intent)
  }
}

function unicastText(frame: SystemFrame | ErrorFrame): string {
  if (frame.type === FrameType.System) return frame.text
  return frame.message
}

function adminBroadcastText(frame: ServerFrame): string {
  switch (frame.type) {
    case FrameType.Narrative:
      if (!frame.text) return ""
      return frame.speaker === "npc"
        ? renderNarrativeNpc(frame.name, frame.text, frame.format)
        : renderNarrativeText(frame.text, frame.format)
    case FrameType.Dice:
      return diceLine(frame)
    case FrameType.Ui:
      return renderUiBlocks(frame.blocks).lines.join("\n")
    case FrameType.Media:
      return frame.name
    case FrameType.AudioLibraryItem:
      return frame.title || frame.name
    default:
      return ""
  }
}
