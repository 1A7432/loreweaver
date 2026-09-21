import { FrameType, type UiChoicesBlock } from "loreweaver-protocol"
import { tt } from "../../i18n"
import type { ChoicesWindow } from "../choices"
import type { Deliverer } from "../deliverer"
import type { BridgeRouter, SinkEvent } from "../router"
import {
  AnchorRegistry,
  anchorsPath,
  type Anchor,
  DEFAULT_SEND_TIMEOUT_MS,
} from "./anchors"
import { ActiveQuota, utcDayKey } from "./buckets"
import { Coalescer, type CoalescedWindow } from "./coalescer"
import {
  DeferredStore,
  deferredPath,
  mediaFromRef,
  nextDeferredId,
  type DeferredItem,
} from "./deferred"
import {
  isSendOk,
  numericCode,
  type QQBotSendPort,
  type QQBotSendRequest,
  type QQBotSendResult,
} from "./port"
import {
  cutMarkdown,
  QQBOT_CHUNK_CHARS,
  recutHalf,
  renderFrame,
  replaceUrls,
  toPlain,
  URL_PLACEHOLDER,
} from "./render"

const DEAD_CODES = new Set([40034128, 40034005, 304027, 40034024, 40034025, 40034026, 40034027])
const LENGTH_CODES = new Set([40054007, 40054018])
const STOP_CODES = new Set([40054002, 40054003, 40034101, 40054013])
const BACKOFF_MS = [1000, 2000, 4000]
const DAY_MS = 24 * 60 * 60 * 1000

export interface QQBotMediaSource {
  getMedia(hash: string): Promise<{ bytes: Uint8Array; mime: string } | undefined>
}

export interface QQBotDelivererOptions {
  groupOpenid: string
  port: QQBotSendPort
  stateDir: string
  locale?: string
  busyNotice?: boolean
  urlWhitelist?: string[]
  maxChunkChars?: number
  botQpm?: number
  sendTimeoutMs?: number
  /** Override 1s/2s/4s HTTP 429 backoff. Tests pass `[0, 0, 0]`. */
  backoffMs?: number[]
  getMedia?: QQBotMediaSource["getMedia"]
  onLog?: (text: string) => void
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export interface PendingReview {
  text: string
  auditId: string
  at: number
}

/**
 * Anchored, budgeted deliverer for the official QQ Bot route. Renders markdown
 * itself; the router sink hands it classified frames before the OneBot
 * plain-text path. Iron rule #3: admin-scope never rides a group anchor.
 */
export class QQBotDeliverer implements Deliverer {
  readonly anchors: AnchorRegistry
  readonly deferred: DeferredStore
  readonly quota: ActiveQuota
  readonly pendingReview: PendingReview[] = []
  private readonly coalescer: Coalescer
  private router: BridgeRouter | undefined
  private offEvent: (() => void) | undefined
  private closed = false
  private outbox: Promise<void> = Promise.resolve()
  private readonly pendingSleeps = new Map<ReturnType<typeof setTimeout>, () => void>()
  private readonly stopped = new Set<string>()
  private thinkingThisTurn = false
  private contentThisTurn = false
  private heldForTail: CoalescedWindow | undefined
  private narrativeGeneration = 0
  private readonly busyNotice: boolean
  private readonly whitelist: readonly string[]
  private readonly maxChunk: number
  private readonly now: () => number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly groupOpenid: string
  private readonly port: QQBotSendPort
  private readonly getMedia: QQBotDelivererOptions["getMedia"]
  private readonly onLog: (text: string) => void
  private localeOverride: string | undefined
  private readonly backoffMs: number[]

  private constructor(
    options: QQBotDelivererOptions,
    anchors: AnchorRegistry,
    deferred: DeferredStore,
  ) {
    this.groupOpenid = options.groupOpenid
    this.port = options.port
    this.anchors = anchors
    this.deferred = deferred
    this.quota = new ActiveQuota({
      now: options.now,
      botQpm: options.botQpm,
      snapshot: anchors.quota,
    })
    this.busyNotice = options.busyNotice ?? true
    this.whitelist = options.urlWhitelist ?? []
    this.maxChunk = options.maxChunkChars ?? QQBOT_CHUNK_CHARS
    this.now = options.now ?? Date.now
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    this.getMedia = options.getMedia
    this.onLog = options.onLog ?? (() => {})
    this.localeOverride = options.locale
    this.backoffMs = options.backoffMs ?? BACKOFF_MS
    this.coalescer = new Coalescer({
      now: this.now,
      setTimeoutFn: this.setTimeoutFn,
      clearTimeoutFn: this.clearTimeoutFn,
      locale: () => this.locale(),
      onFlush: (window) => this.enqueue(() => this.deliverWindow(window)),
    })
    this.offEvent = this.port.onEvent((event) => this.onPortEvent(event))
  }

  static async load(options: QQBotDelivererOptions): Promise<QQBotDeliverer> {
    const anchors = await AnchorRegistry.load(anchorsPath(options.stateDir, options.groupOpenid), {
      sendTimeoutMs: options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      now: options.now,
    })
    const deferred = await DeferredStore.load(deferredPath(options.stateDir, options.groupOpenid), {
      now: options.now,
    })
    return new QQBotDeliverer(options, anchors, deferred)
  }

  attach(router: BridgeRouter): void {
    this.router = router
    router.setSink((event) => this.onSink(event))
  }

  async close(): Promise<void> {
    this.closed = true
    this.coalescer.close()
    this.heldForTail = undefined
    for (const [id, resolve] of this.pendingSleeps) {
      this.clearTimeoutFn(id)
      resolve()
    }
    this.pendingSleeps.clear()
    this.router?.setSink(undefined)
    this.offEvent?.()
    this.offEvent = undefined
    await this.outbox
    await this.persist()
  }

  /** Every accepted inbound creates an anchor (seq starts at 0). */
  openAnchor(input: {
    id: string
    scope: "group" | "c2c"
    target: string
    seat?: string
    receivedAt?: number
  }): Promise<Anchor> {
    return this.enqueue(() => this.openAnchorLocked(input))
  }

  setGroupActive(on: boolean | null): void {
    this.anchors.setGroupActive(on)
    void this.persist()
  }

  setC2CActive(userOpenid: string, on: boolean): void {
    this.anchors.setC2CActive(userOpenid, on)
    if (on) this.enqueue(() => this.drainPrivateActive(userOpenid))
    void this.persist()
  }

  get thinkingSent(): boolean {
    return this.thinkingThisTurn
  }

  /** Wait until the serial outbox is empty. Tests use this after advancing the clock. */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const snapshot = this.outbox
      await snapshot
      if (this.outbox === snapshot) return
    }
  }

  /** Close the current 5 s window now (still serialised on the outbox). */
  flushWindows(): void {
    this.coalescer.flush("manual")
  }

  private locale(): string {
    return this.localeOverride || this.router?.locale() || "en"
  }

  private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.outbox.then(work, work)
    this.outbox = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private onSink(event: SinkEvent): void {
    if (this.closed) return
    if (event.scope === "group") {
      // Stamp attribution at arrival (spec §4.2) and arm the 5 s timer
      // synchronously so tests can advance the injected clock immediately.
      this.coalescer.push(event)
      return
    }
    this.enqueue(() => this.handleSink(event))
  }

  private async handleSink(event: SinkEvent): Promise<void> {
    if (this.closed) return
    if (event.scope === "admin") {
      await this.handleAdmin(event)
      return
    }
    if (event.scope === "player") {
      await this.handlePlayer(event)
      return
    }
    this.coalescer.push(event)
  }

  private async handleAdmin(event: SinkEvent): Promise<void> {
    const rendered = renderFrame(event.frame, this.locale())
    if (rendered.skip || rendered.isQueuedNotice) return
    const user = event.seat
    if (!user) return
    const item = this.itemFromRendered("admin", user, rendered, event.seat)
    const flag = this.anchors.c2cFlag(user)
    if (flag === true && !this.anchors.activeUnpermitted) {
      const sent = await this.sendActiveC2C(user, item)
      if (sent) return
    }
    this.deferred.pushPrivate(user, item)
    const c2c = this.anchors.newestOpen("c2c", user)
    if (c2c && this.anchors.isOpen(c2c)) {
      const room = Math.max(0, c2c.budget - 1)
      const taken = this.deferred.takePrivate(user, room)
      for (const next of taken) await this.deliverItem(next, c2c, { late: false })
      await this.persist()
      return
    }
    await this.maybePrivateHeld()
    await this.persist()
  }

  private async handlePlayer(event: SinkEvent): Promise<void> {
    const rendered = renderFrame(event.frame, this.locale())
    if (rendered.skip || rendered.isQueuedNotice) return
    const seat = event.seat
    if (!seat) return
    const item = this.itemFromRendered("player", this.groupOpenid, rendered, seat)
    const anchor = this.anchors.newestOpenForSeat(seat)
    if (!anchor) {
      this.deferred.pushPlayerHold(seat, item)
      await this.persist()
      return
    }
    await this.deliverItem(item, anchor, { late: false })
    await this.persist()
  }

  private async openAnchorLocked(input: {
    id: string
    scope: "group" | "c2c"
    target: string
    seat?: string
    receivedAt?: number
  }): Promise<Anchor> {
    const anchor = this.anchors.create({
      id: input.id,
      scope: input.scope,
      target: input.target,
      seat: input.seat,
      receivedAt: input.receivedAt ?? this.now(),
    })
    if (input.scope === "group") {
      const late = this.deferred.takeLate(2)
      for (const item of late) await this.deliverItem(item, anchor, { late: true })
    }
    if (input.seat) {
      const holds = this.deferred.takePlayerHolds(input.seat)
      for (const item of holds) await this.deliverItem(item, anchor, { late: false })
    }
    if (input.scope === "c2c") {
      const room = Math.max(0, anchor.budget - 1)
      const taken = this.deferred.takePrivate(input.target, room)
      for (const item of taken) await this.deliverItem(item, anchor, { late: false })
    }
    if (input.scope === "group" && this.busyNotice && !this.thinkingThisTurn) {
      const sent = await this.sendNotice(anchor, tt(this.locale(), "bridge.qqbot.thinking"))
      if (sent) this.thinkingThisTurn = true
    }
    await this.persist()
    return anchor
  }

  private async deliverWindow(window: CoalescedWindow): Promise<void> {
    if (this.closed) return
    const isTail = window.reason === "idle"
    if (isTail) {
      const held = this.heldForTail
      this.heldForTail = undefined
      const merged: CoalescedWindow = held
        ? {
            events: [...held.events, ...window.events],
            rendered: [...held.rendered, ...window.rendered],
            reason: "idle",
          }
        : window
      await this.dispatchGroupWindow(merged, true)
      if (this.thinkingThisTurn && !this.contentThisTurn) {
        const anchor = this.anchors.newestOpen("group", this.groupOpenid)
        if (anchor) await this.sendNotice(anchor, tt(this.locale(), "bridge.qqbot.nothingToShow"))
      }
      this.thinkingThisTurn = false
      this.contentThisTurn = false
      await this.persist()
      return
    }
    const mode = this.anchors.groupActive
    const anchor = this.anchors.newestOpen("group", this.groupOpenid)
    if (mode !== true && anchor && anchor.budget <= 1) {
      if (this.heldForTail) {
        this.heldForTail = {
          events: [...this.heldForTail.events, ...window.events],
          rendered: [...this.heldForTail.rendered, ...window.rendered],
          reason: "window",
        }
      } else {
        this.heldForTail = window
      }
      return
    }
    await this.dispatchGroupWindow(window, false)
    await this.persist()
  }

  private async dispatchGroupWindow(window: CoalescedWindow, isTail: boolean): Promise<void> {
    const item = this.windowToItem(window)
    if (!item) return
    const anchor = this.anchors.newestOpen("group", this.groupOpenid)
    if (anchor) {
      await this.deliverItem(item, anchor, { late: false, isTail })
      this.contentThisTurn = true
      return
    }
    // Unknown or ON: try an active send once passive budget is gone. OFF never does.
    if (this.anchors.groupActive !== false && !this.anchors.activeUnpermitted) {
      const sent = await this.sendActiveGroup(item)
      if (sent) {
        this.contentThisTurn = true
        return
      }
    }
    const drop = this.deferred.pushGroup({ ...item, late: true })
    if (drop?.notice) await this.sendGroupLine(tt(this.locale(), "bridge.qqbot.deferredDropped"))
  }

  private windowToItem(window: CoalescedWindow): DeferredItem | undefined {
    const texts: string[] = []
    const media: DeferredItem["media"] = []
    let choices: UiChoicesBlock | undefined
    let choicesExpired = false
    for (const rendered of window.rendered) {
      if (rendered.skip || rendered.isQueuedNotice) continue
      if (rendered.isKpNarrative) {
        this.narrativeGeneration += 1
        this.router?.choices.close(this.now())
        if (choices) choicesExpired = true
      }
      if (rendered.text) texts.push(rendered.text)
      media.push(...rendered.media.map(mediaFromRef))
      if (rendered.choices) {
        choices = rendered.choices
        choicesExpired = false
      }
    }
    let text = texts.join("\n")
    if (choices && choicesExpired) {
      text = text ? `${text}\n${tt(this.locale(), "bridge.qqbot.choiceExpired")}` : tt(this.locale(), "bridge.qqbot.choiceExpired")
    }
    if (!text && media.length === 0) return undefined
    return {
      id: nextDeferredId(this.now()),
      scope: "group",
      target: this.groupOpenid,
      text,
      media,
      createdAt: this.now(),
      choices: choicesExpired ? undefined : choices,
      late: false,
      queuedGeneration: this.narrativeGeneration,
    }
  }

  private itemFromRendered(
    scope: DeferredItem["scope"],
    target: string,
    rendered: ReturnType<typeof renderFrame>,
    seat?: string,
  ): DeferredItem {
    return {
      id: nextDeferredId(this.now()),
      scope,
      target,
      ...(seat ? { seat } : {}),
      text: rendered.text,
      media: rendered.media.map(mediaFromRef),
      createdAt: this.now(),
      choices: rendered.choices,
      late: false,
      queuedGeneration: this.narrativeGeneration,
    }
  }

  private async deliverItem(
    item: DeferredItem,
    anchor: Anchor,
    opts: { late: boolean; isTail?: boolean },
  ): Promise<void> {
    if (this.stopped.has(anchor.target) || this.closed) {
      this.requeue(item, opts.late)
      return
    }
    if (!this.anchors.isOpen(anchor) && this.anchors.groupActive !== true) {
      this.requeue(item, true)
      return
    }
    let text = item.text
    if (opts.late && item.late !== false && item.scope === "group") {
      const prefix = tt(this.locale(), "bridge.qqbot.lateDelivery")
      text = text ? `${prefix} ${text}` : prefix
    }
    if (item.choices) {
      const stale =
        item.queuedGeneration !== undefined && this.narrativeGeneration > item.queuedGeneration
      if (stale) {
        text = text
          ? `${text}\n${tt(this.locale(), "bridge.qqbot.choiceExpired")}`
          : tt(this.locale(), "bridge.qqbot.choiceExpired")
      } else {
        this.router?.choices.open(item.choices, this.now())
      }
    }
    const chunks = text ? cutMarkdown(replaceUrls(text, this.whitelist), this.maxChunk) : [""]
    const usePassive = this.anchors.isOpen(anchor)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      const lastChunk = i === chunks.length - 1
      if (!chunk && !(lastChunk && item.media.length)) continue
      if (usePassive && !this.anchors.isOpen(anchor)) {
        this.requeue({ ...item, text: chunks.slice(i).join(""), media: lastChunk ? item.media : [] }, true)
        return
      }
      if (chunk) {
        const outcome = await this.postText({
          channel: anchor.scope,
          target: anchor.target,
          text: chunk,
          anchor: usePassive ? anchor : undefined,
        })
        if (outcome === "dead") {
          this.anchors.markDead(anchor)
          this.requeue({ ...item, text: chunks.slice(i).join(""), media: lastChunk ? item.media : [] }, true)
          return
        }
        if (outcome === "stopped") {
          this.stopped.add(anchor.target)
          this.requeue({ ...item, text: chunks.slice(i).join(""), media: lastChunk ? item.media : [] }, true)
          return
        }
        if (outcome === "dropped" || outcome === "pending") return
        if (outcome === "deferred") {
          this.requeue({ ...item, text: chunks.slice(i).join(""), media: lastChunk ? item.media : [] }, true)
          return
        }
      }
    }
    if (item.media.length) {
      for (let m = 0; m < item.media.length; m++) {
        const media = item.media[m]!
        if (usePassive && !this.anchors.isOpen(anchor)) {
          this.requeue({ ...item, text: "", media: item.media.slice(m) }, true)
          return
        }
        const caption = item.text ? "" : media.name || ""
        const outcome = await this.postMedia({
          channel: anchor.scope,
          target: anchor.target,
          media,
          caption,
          anchor: usePassive ? anchor : undefined,
        })
        if (outcome === "dead") {
          this.anchors.markDead(anchor)
          this.requeue({ ...item, text: "", media: item.media.slice(m) }, true)
          return
        }
        if (outcome === "stopped") {
          this.stopped.add(anchor.target)
          this.requeue({ ...item, text: "", media: item.media.slice(m) }, true)
          return
        }
      }
    }
  }

  private requeue(item: DeferredItem, late: boolean): void {
    if (item.scope === "admin") {
      this.deferred.pushPrivate(item.target, item)
      return
    }
    if (item.scope === "player" && item.seat) {
      this.deferred.pushPlayerHold(item.seat, { ...item, late: false })
      return
    }
    const drop = this.deferred.pushGroup({ ...item, late: true })
    if (drop?.notice) {
      this.enqueue(() => this.sendGroupLine(tt(this.locale(), "bridge.qqbot.deferredDropped")))
    }
  }

  private async sendNotice(anchor: Anchor, text: string): Promise<boolean> {
    const outcome = await this.postText({
      channel: anchor.scope,
      target: anchor.target,
      text,
      anchor,
    })
    return outcome === "sent" || outcome === "pending"
  }

  private async sendGroupLine(text: string): Promise<void> {
    const anchor = this.anchors.newestOpen("group", this.groupOpenid)
    if (anchor) {
      await this.postText({ channel: "group", target: this.groupOpenid, text, anchor })
      return
    }
    if (this.anchors.groupActive === true) {
      await this.postText({ channel: "group", target: this.groupOpenid, text })
    }
  }

  private async sendActiveGroup(item: DeferredItem): Promise<boolean> {
    let text = item.text
    if (item.late) {
      const prefix = tt(this.locale(), "bridge.qqbot.lateDelivery")
      text = text ? `${prefix} ${text}` : prefix
    }
    if (item.choices) this.router?.choices.open(item.choices, this.now())
    if (text) {
      const outcome = await this.postText({ channel: "group", target: this.groupOpenid, text })
      if (outcome !== "sent" && outcome !== "pending") return false
    }
    for (const media of item.media) {
      const outcome = await this.postMedia({
        channel: "group",
        target: this.groupOpenid,
        media,
        caption: text ? "" : media.name || "",
      })
      if (outcome !== "sent" && outcome !== "pending") return false
    }
    return true
  }

  private async sendActiveC2C(user: string, item: DeferredItem): Promise<boolean> {
    if (this.stopped.has(user)) return false
    const outcome = await this.postText({ channel: "c2c", target: user, text: item.text })
    if (outcome === "sent" || outcome === "pending") {
      this.anchors.setC2CActive(user, true)
      return true
    }
    return false
  }

  private async drainPrivateActive(user: string): Promise<void> {
    const items = this.deferred.takePrivate(user, 50)
    for (const item of items) {
      const ok = await this.sendActiveC2C(user, item)
      if (!ok) {
        this.deferred.pushPrivate(user, item)
        break
      }
    }
    await this.persist()
  }

  private async maybePrivateHeld(): Promise<void> {
    const any = Object.values(this.deferred.privateOutboxes).some((list) => list.length > 0)
    if (!any) return
    if (!this.deferred.shouldPrivateHeld(this.now())) return
    this.deferred.markPrivateHeld(this.now())
    await this.sendGroupLine(tt(this.locale(), "bridge.qqbot.privateHeld"))
  }

  private async postText(opts: {
    channel: "group" | "c2c"
    target: string
    text: string
    anchor?: Anchor
  }): Promise<"sent" | "deferred" | "dropped" | "pending" | "dead" | "stopped"> {
    let text = replaceUrls(opts.text, this.whitelist)
    let markdown = true
    let recut = false
    let urlRetry = false
    let dedupeRetry = false
    let backoff = 0
    while (!this.closed) {
      if (!opts.anchor) {
        const gate = await this.waitActive(opts.channel, opts.target)
        if (gate === "daily") return "deferred"
        if (gate === "off") return "deferred"
        if (gate === "stopped") return "stopped"
      } else if (!this.anchors.isOpen(opts.anchor)) {
        return "dead"
      }
      const req = this.buildTextRequest(opts.anchor, text, markdown)
      const result = await this.send(opts.channel, opts.target, req)
      const accepted = isSendOk(result) || result.code === "timeout"
      if (accepted && opts.anchor) this.anchors.spendBudget(opts.anchor)
      if (isSendOk(result)) {
        if (!opts.anchor) this.markActiveSuccess(opts.channel, opts.target)
        if (result.auditId) {
          this.pendingReview.push({ text, auditId: result.auditId, at: this.now() })
          this.onLog(`qqbot.audit.pending ${result.auditId}`)
          await this.persist()
          return "pending"
        }
        await this.persist()
        return "sent"
      }
      const code = result.code
      const num = numericCode(result)
      if (code === "timeout") {
        this.onLog("qqbot.send.timeout")
        await this.persist()
        return "sent"
      }
      if (num !== undefined && DEAD_CODES.has(num)) {
        if (opts.anchor) this.anchors.markDead(opts.anchor)
        await this.persist()
        return "dead"
      }
      if (num === 40054005 && !dedupeRetry && opts.anchor) {
        dedupeRetry = true
        continue
      }
      if (num !== undefined && LENGTH_CODES.has(num) && !recut) {
        recut = true
        text = recutHalf(text)
        continue
      }
      if (code === "markdown_refused" && markdown) {
        markdown = false
        continue
      }
      if (num === 40054010 && !urlRetry) {
        urlRetry = true
        text = replaceUrls(text, [])
        if (!text.includes(URL_PLACEHOLDER) && !text.includes("http")) text = text.replace(/\S+:\/\/\S+/g, URL_PLACEHOLDER)
        continue
      }
      if ((num === 429 || num === 40034100) && backoff < this.backoffMs.length) {
        await this.sleep(this.backoffMs[backoff]!)
        backoff += 1
        continue
      }
      if (num === 40034105) {
        await this.onActiveOff(opts.channel, opts.target)
        if (opts.anchor) continue
        return "deferred"
      }
      if (num === 40034102) {
        this.anchors.activeUnpermitted = true
        this.anchors.setGroupActive(false)
        this.onLog("qqbot.active.unpermitted")
        await this.persist()
        return "deferred"
      }
      if (num === 40034006) {
        this.onLog("qqbot.audit.rejected")
        await this.sendGroupLine(tt(this.locale(), "bridge.qqbot.auditRejected"))
        await this.persist()
        return "dropped"
      }
      if (num !== undefined && STOP_CODES.has(num)) {
        this.stopped.add(opts.target)
        this.onLog(`qqbot.target.stopped ${num}`)
        await this.persist()
        return "stopped"
      }
      if (num === 40054004) {
        this.onLog("qqbot.c2c.not_reachable")
        this.stopped.add(opts.target)
        await this.persist()
        return "stopped"
      }
      this.onLog(`qqbot.send.failed ${String(code)}`)
      await this.persist()
      return "deferred"
    }
    return "deferred"
  }

  private buildTextRequest(anchor: Anchor | undefined, text: string, markdown: boolean): QQBotSendRequest {
    const req: QQBotSendRequest = markdown
      ? { msg_type: 2, markdown: { content: text }, content: text }
      : { msg_type: 0, content: toPlain(text) }
    if (anchor) {
      req.msg_id = anchor.id
      req.msg_seq = this.anchors.bumpSeq(anchor)
    }
    return req
  }

  private async postMedia(opts: {
    channel: "group" | "c2c"
    target: string
    media: { hash: string; mime?: string; name?: string }
    caption: string
    anchor?: Anchor
  }): Promise<"sent" | "deferred" | "dropped" | "pending" | "dead" | "stopped"> {
    const bytes = this.getMedia ? await this.getMedia(opts.media.hash) : undefined
    if (!bytes) {
      const fallback = opts.caption || opts.media.name || ""
      if (!fallback) return "dropped"
      return this.postText({ channel: opts.channel, target: opts.target, text: fallback, anchor: opts.anchor })
    }
    const uploaded =
      opts.channel === "group"
        ? await this.port.uploadGroupMedia(opts.target, bytes.bytes, bytes.mime || opts.media.mime, opts.media.name)
        : await this.port.uploadC2CMedia(opts.target, bytes.bytes, bytes.mime || opts.media.mime, opts.media.name)
    if (!uploaded?.file_info) {
      const fallback = opts.caption || opts.media.name || ""
      if (!fallback) return "dropped"
      return this.postText({ channel: opts.channel, target: opts.target, text: fallback, anchor: opts.anchor })
    }
    if (!opts.anchor) {
      const gate = await this.waitActive(opts.channel, opts.target)
      if (gate !== "ok") return "deferred"
    }
    const req: QQBotSendRequest = {
      msg_type: 7,
      media: { file_info: uploaded.file_info },
      ...(opts.caption ? { content: opts.caption } : {}),
    }
    if (opts.anchor) {
      req.msg_id = opts.anchor.id
      req.msg_seq = this.anchors.bumpSeq(opts.anchor)
    }
    const result = await this.send(opts.channel, opts.target, req)
    const accepted = isSendOk(result) || result.code === "timeout"
    if (accepted && opts.anchor) this.anchors.spendBudget(opts.anchor)
    if (isSendOk(result)) {
      if (!opts.anchor) this.markActiveSuccess(opts.channel, opts.target)
      if (result.auditId) {
        this.pendingReview.push({ text: opts.caption, auditId: result.auditId, at: this.now() })
        this.onLog(`qqbot.audit.pending ${result.auditId}`)
      }
      await this.persist()
      return result.auditId ? "pending" : "sent"
    }
    if (result.code === "timeout") {
      this.onLog("qqbot.send.timeout")
      return "sent"
    }
    const num = numericCode(result)
    if (num !== undefined && DEAD_CODES.has(num)) {
      if (opts.anchor) this.anchors.markDead(opts.anchor)
      return "dead"
    }
    if (num === 40034105) {
      await this.onActiveOff(opts.channel, opts.target)
      return "deferred"
    }
    return "deferred"
  }

  private async send(
    channel: "group" | "c2c",
    target: string,
    req: QQBotSendRequest,
  ): Promise<QQBotSendResult> {
    try {
      return channel === "group" ? await this.port.sendGroup(target, req) : await this.port.sendC2C(target, req)
    } catch {
      return { ok: false, code: "timeout" }
    }
  }

  private async waitActive(channel: "group" | "c2c", target: string): Promise<"ok" | "daily" | "off" | "stopped"> {
    if (this.stopped.has(target)) return "stopped"
    if (this.anchors.activeUnpermitted) return "off"
    if (channel === "group" && this.anchors.groupActive === false) return "off"
    if (channel === "c2c" && this.anchors.c2cFlag(target) === false) return "off"
    while (!this.closed) {
      const result = channel === "group" ? this.quota.tryGroup() : this.quota.tryC2C(target)
      if (result.ok) {
        if (result.daily === "warn80") this.onLog("qqbot.daily.80")
        if (result.daily === "cap100") {
          this.anchors.quota = this.quota.snapshot()
          const line = tt(this.locale(), "bridge.qqbot.dailyCap")
          const anchor = this.anchors.newestOpen("group", this.groupOpenid)
          if (anchor) await this.postText({ channel: "group", target: this.groupOpenid, text: line, anchor })
          else {
            this.onLog("qqbot.daily.100")
            this.deferred.pushGroup({
              id: nextDeferredId(this.now()),
              scope: "group",
              target: this.groupOpenid,
              text: line,
              media: [],
              createdAt: this.now(),
              late: false,
            })
          }
        }
        this.anchors.quota = this.quota.snapshot()
        return "ok"
      }
      if (result.reason === "daily") {
        this.anchors.quota = this.quota.snapshot()
        return "daily"
      }
      await this.sleep(Math.min(result.waitMs, 60_000))
    }
    return "off"
  }

  private async onActiveOff(channel: "group" | "c2c", target: string): Promise<void> {
    if (channel === "group") this.anchors.setGroupActive(false)
    else this.anchors.setC2CActive(target, false)
    const now = this.now()
    const last = this.anchors.lastActiveOffAt
    const onceADay = last === undefined || utcDayKey(last) !== utcDayKey(now) || now - last >= DAY_MS
    if (channel === "group" && onceADay) {
      this.anchors.lastActiveOffAt = now
      const line = tt(this.locale(), "bridge.qqbot.activeOff")
      const anchor = this.anchors.newestOpen("group", this.groupOpenid)
      if (anchor) await this.sendNotice(anchor, line)
      else {
        this.deferred.pushGroup({
          id: nextDeferredId(now),
          scope: "group",
          target: this.groupOpenid,
          text: line,
          media: [],
          createdAt: now,
          late: false,
        })
      }
    }
    this.onLog("qqbot.active.off")
    await this.persist()
  }

  private onPortEvent(event: { type: string; groupOpenid?: string; userOpenid?: string }): void {
    if (event.type === "groupMsgReceive" && event.groupOpenid === this.groupOpenid) {
      this.anchors.activeUnpermitted = false
      this.setGroupActive(true)
    } else if (event.type === "groupMsgReject" && event.groupOpenid === this.groupOpenid) {
      this.setGroupActive(false)
    } else if (event.type === "c2cMsgReceive" && event.userOpenid) {
      this.setC2CActive(event.userOpenid, true)
    } else if (event.type === "c2cMsgReject" && event.userOpenid) {
      this.setC2CActive(event.userOpenid, false)
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.closed || ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const id = this.setTimeoutFn(() => {
        this.pendingSleeps.delete(id)
        resolve()
      }, ms)
      this.pendingSleeps.set(id, resolve)
    })
  }

  private markActiveSuccess(channel: "group" | "c2c", target: string): void {
    if (channel === "group") this.anchors.setGroupActive(true)
    else this.anchors.setC2CActive(target, true)
  }

  private async persist(): Promise<void> {
    this.anchors.quota = this.quota.snapshot()
    await Promise.all([this.anchors.flush(), this.deferred.flush()])
  }
}
