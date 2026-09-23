import { tt } from "../i18n"
import {
  OneBotTransport,
  type ChatTarget,
  type OneBotSendResult,
  type OneBotStatus,
} from "./onebot"
import type { BridgeMediaRef } from "./render/uiText"
import type { BridgeRouter, OutboundIntent } from "./router"

/** The live membership check before a private redirect; it sits on the group's serial outbox. */
export const MEMBER_GATE_TIMEOUT_MS = 3_000
export const FRIEND_NOTICE_MS = 10 * 60 * 1000
/**
 * How long the outbox holds a message while the OneBot connection is down. A Keeper turn
 * takes minutes; an implementation restart or a re-login in that window used to drop the
 * turn's narration for good (the observer had already marked it posted). Held messages go
 * out in order once the connection is back; past this bound they are dropped, logged.
 */
export const OUTBOX_HOLD_MS = 15 * 60 * 1000

const DISCONNECTED = new Set(["onebot.websocket.disconnected", "onebot.transport.unavailable"])

export interface Deliverer {
  attach(router: BridgeRouter): void
  close(): void | Promise<void>
}

export interface ObserverMediaLink {
  readonly isAlive: boolean
  getMedia(hash: string): Promise<{ bytes: Uint8Array; mime: string }>
}

export interface OneBotDelivererOptions {
  groupId: string
  transport: OneBotTransport
  getObserver: () => ObserverMediaLink | undefined
  getLastReplyId: (userId: string) => string | undefined
  getLocale: () => string
  now?: () => number
  holdMs?: number
  onLog?: (text: string) => void
}

/**
 * Thin wrapper over the OneBot outbox that used to live on `GroupRuntime.dispatch`.
 * Behaviour is unchanged: serial enqueue, image-via-observer, reply-to, live
 * member-gate on private, friend-notice throttle.
 */
export class OneBotDeliverer implements Deliverer {
  private router: BridgeRouter | undefined
  private outbox: Promise<void> = Promise.resolve()
  private readonly lastFriendNotice = new Map<string, number>()
  private readonly now: () => number
  private readonly holdMs: number
  private connected = true
  private readonly onlineWaiters = new Set<() => void>()
  private holding = false

  constructor(private readonly options: OneBotDelivererOptions) {
    this.now = options.now ?? Date.now
    this.holdMs = options.holdMs ?? OUTBOX_HOLD_MS
    options.transport.onStatus((status: OneBotStatus) => {
      this.connected = status === "online"
      if (!this.connected) return
      for (const wake of [...this.onlineWaiters]) wake()
    })
  }

  /** Resolves when the connection is next online, or after `ms` — whichever comes first. */
  private waitOnline(ms: number): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.onlineWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, ms))
      this.onlineWaiters.add(done)
    })
  }

  private noteHolding(): void {
    if (this.holding) return
    this.holding = true
    this.options.onLog?.(tt(this.locale(), "bridge.cli.outboxHolding"))
  }

  /**
   * One send, held across a dropped connection: while the implementation is away the
   * outbox waits (serially, so order holds) and sends again once it is back.
   */
  private async held(send: () => Promise<OneBotSendResult>): Promise<OneBotSendResult> {
    const deadline = this.now() + this.holdMs
    if (!this.connected) this.noteHolding()
    await this.waitOnline(deadline - this.now())
    let result = await send()
    while (!result.ok && DISCONNECTED.has(result.error ?? "") && this.now() < deadline) {
      this.noteHolding()
      this.connected = false
      await this.waitOnline(deadline - this.now())
      result = await send()
    }
    if (this.holding && result.ok) {
      this.holding = false
      this.options.onLog?.(tt(this.locale(), "bridge.cli.outboxResumed"))
    }
    if (!result.ok && DISCONNECTED.has(result.error ?? "")) this.options.onLog?.(tt(this.locale(), "bridge.cli.outboxDropped"))
    return result
  }

  attach(router: BridgeRouter): void {
    this.router = router
  }

  enqueue(intent: OutboundIntent): void {
    this.outbox = this.outbox.then(() => this.dispatch(intent)).catch(() => {})
  }

  async close(): Promise<void> {
    await this.outbox
  }

  private locale(): string {
    return this.router?.locale() ?? this.options.getLocale()
  }

  private async dispatch(intent: OutboundIntent): Promise<void> {
    const groupTarget: ChatTarget = { type: "group", id: this.options.groupId }
    if (intent.dest === "group") {
      if (intent.media) {
        await this.dispatchGroupMedia(groupTarget, intent)
        return
      }
      if (intent.text) await this.held(() => this.options.transport.sendText(groupTarget, intent.text))
      return
    }
    if (intent.dest === "reply") {
      const replyTo = this.options.getLastReplyId(intent.userId)
      if (replyTo) await this.held(() => this.options.transport.sendReply(groupTarget, replyTo, intent.text))
      else await this.held(() => this.options.transport.sendText(groupTarget, intent.text))
      return
    }
    if (intent.dest === "c2c_direct") return
    // The membership check below needs a live connection to mean anything.
    await this.waitOnline(this.holdMs)
    // A private reply carries the group it belongs to, so NapCat can use the group temp
    // session when the two are not friends — but ONLY once NapCat has confirmed it can
    // resolve this member: with an unresolvable user NapCat falls back to posting into the
    // group itself, and a keeper-grade reply must never take that path (iron rule #3).
    // The check is LIVE (no cache) and short: a 10-minute-old "yes" is not a verdict, and this
    // await sits on the group's serial outbox. Anything but a confirmed member sends plain.
    const status = await this.options.transport.memberStatus(this.options.groupId, intent.userId, {
      fresh: true,
      timeoutMs: MEMBER_GATE_TIMEOUT_MS,
    })
    const result: OneBotSendResult = await this.held(() =>
      status === "member"
        ? this.options.transport.sendText(
            { type: "group", id: this.options.groupId, userId: intent.userId },
            intent.text,
            { private: true },
          )
        : this.options.transport.sendText({ type: "private", id: intent.userId }, intent.text),
    )
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
      await this.options.transport.sendText(groupTarget, tt(this.locale(), "bridge.privateFailed"))
    }
  }

  private async dispatchGroupMedia(
    groupTarget: ChatTarget,
    intent: Extract<OutboundIntent, { dest: "group" }> & { media: BridgeMediaRef },
  ): Promise<void> {
    const observer = this.options.getObserver()
    if (observer?.isAlive) {
      try {
        const payload = await observer.getMedia(intent.media.hash)
        const result = await this.held(() =>
          this.options.transport.sendImage(
            groupTarget,
            { data: payload.bytes, mime: payload.mime || intent.media.mime },
            { text: intent.text || undefined },
          ),
        )
        if (result.ok) return
      } catch {
        // fall through to the name line — never pretend the image sent
      }
    }
    const fallback = intent.text || intent.media.name || ""
    if (fallback) await this.held(() => this.options.transport.sendText(groupTarget, fallback))
  }
}
