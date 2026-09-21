import { FrameType } from "loreweaver-protocol"
import type { SinkEvent } from "../router"
import { renderFrame, type RenderedQqFrame } from "./render"

export const WINDOW_MS = 5_000

export interface CoalescedWindow {
  events: SinkEvent[]
  rendered: RenderedQqFrame[]
  reason: "window" | "idle" | "manual"
}

/**
 * 5-second windows of classified frames. `turn_status` busy is ignored here
 * (the deliverer owns the thinking line). `idle` flushes immediately as the
 * turn tail. Inject `now` / `setTimeout` — no uncontrolled timers.
 */
export class Coalescer {
  private items: SinkEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(
    private readonly opts: {
      onFlush: (window: CoalescedWindow) => void
      now: () => number
      setTimeoutFn: typeof setTimeout
      clearTimeoutFn: typeof clearTimeout
      windowMs?: number
      locale?: () => string
    },
  ) {}

  get pending(): number {
    return this.items.length
  }

  push(event: SinkEvent): void {
    if (this.closed) return
    if (event.frame.type === FrameType.TurnStatus) {
      if (event.frame.status === "idle") this.flush("idle")
      return
    }
    this.items.push(event)
    if (this.timer !== undefined) return
    this.timer = this.opts.setTimeoutFn(() => {
      this.timer = undefined
      this.flush("window")
    }, this.opts.windowMs ?? WINDOW_MS)
  }

  flush(reason: CoalescedWindow["reason"] = "manual"): void {
    if (this.timer !== undefined) {
      this.opts.clearTimeoutFn(this.timer)
      this.timer = undefined
    }
    const events = this.items
    this.items = []
    if (reason !== "idle" && events.length === 0) return
    const locale = this.opts.locale?.()
    this.opts.onFlush({
      events,
      rendered: events.map((event) => renderFrame(event.frame, locale)),
      reason,
    })
  }

  close(): void {
    this.closed = true
    if (this.timer !== undefined) {
      this.opts.clearTimeoutFn(this.timer)
      this.timer = undefined
    }
    this.items = []
  }
}
