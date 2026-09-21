import { describe, expect, test } from "bun:test"
import { FrameType, type ServerFrame } from "loreweaver-protocol"
import { Coalescer, WINDOW_MS, type CoalescedWindow } from "./coalescer"

class ManualClock {
  nowMs = 0
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()
  now = () => this.nowMs
  setTimeoutFn = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = ++this.seq
    this.timers.set(id, { at: this.nowMs + ms, fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeoutFn = (id: ReturnType<typeof setTimeout>) => {
    this.timers.delete(id as unknown as number)
  }
  advance(ms: number): void {
    this.nowMs += ms
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.nowMs) {
        this.timers.delete(id)
        timer.fn()
      }
    }
  }
}

const KP = (text: string): ServerFrame => ({
  type: FrameType.Narrative,
  id: text,
  speaker: "kp",
  text,
  format: "plain",
})

describe("coalescer", () => {
  test("5-second window merges frames into one flush", () => {
    const clock = new ManualClock()
    const flushed: CoalescedWindow[] = []
    const c = new Coalescer({
      onFlush: (window) => flushed.push(window),
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn as typeof setTimeout,
      clearTimeoutFn: clock.clearTimeoutFn as typeof clearTimeout,
    })
    c.push({ scope: "group", frame: KP("one") })
    c.push({ scope: "group", frame: KP("two") })
    expect(flushed).toEqual([])
    clock.advance(WINDOW_MS)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.reason).toBe("window")
    expect(flushed[0]?.rendered.map((row) => row.text)).toEqual(["one", "two"])
  })

  test("idle flushes immediately as the tail, including buffered frames", () => {
    const clock = new ManualClock()
    const flushed: CoalescedWindow[] = []
    const c = new Coalescer({
      onFlush: (window) => flushed.push(window),
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn as typeof setTimeout,
      clearTimeoutFn: clock.clearTimeoutFn as typeof clearTimeout,
    })
    c.push({ scope: "group", frame: KP("body") })
    c.push({ scope: "group", frame: { type: FrameType.TurnStatus, status: "idle" } })
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.reason).toBe("idle")
    expect(flushed[0]?.rendered[0]?.text).toBe("body")
    clock.advance(WINDOW_MS)
    expect(flushed).toHaveLength(1)
  })

  test("close drops the buffer and never fires the timer", () => {
    const clock = new ManualClock()
    const flushed: CoalescedWindow[] = []
    const c = new Coalescer({
      onFlush: (window) => flushed.push(window),
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn as typeof setTimeout,
      clearTimeoutFn: clock.clearTimeoutFn as typeof clearTimeout,
    })
    c.push({ scope: "group", frame: KP("lost") })
    c.close()
    clock.advance(WINDOW_MS)
    expect(flushed).toEqual([])
  })
})
