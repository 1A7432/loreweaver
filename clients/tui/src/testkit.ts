/**
 * Shared test helpers. Nothing here sleeps on the wall clock: a test waits for the condition
 * it actually depends on (`waitFor`) and moves time only by hand (`ManualClock.advance`), so a
 * starved CI runner changes how long a test takes, never what it sees.
 */

/** Upper bound for one wait, below bun's 5 s test timeout so the failure names what was awaited. */
const WAIT_BOUND_MS = 3000

/** Yield to the event loop (I/O included) until `cond` holds; fail loudly instead of hanging. */
export async function waitFor(what: string, cond: () => boolean, detail?: () => string): Promise<void> {
  const deadline = Date.now() + WAIT_BOUND_MS
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${WAIT_BOUND_MS}ms${detail ? ` — ${detail()}` : ""}`)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** A few event-loop turns: lets something that must NOT happen show up if it were going to. */
export async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Manual timers + clock: a timer fires only when the test advances the clock past it. */
export class ManualClock {
  nowMs = 0
  private seq = 0
  protected readonly timers = new Map<number, { at: number; fn: () => void }>()
  now = (): number => this.nowMs
  setTimeoutFn = ((fn: () => void, ms = 0): ReturnType<typeof setTimeout> => {
    const id = ++this.seq
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    this.timers.delete(id as unknown as number)
  }) as unknown as typeof clearTimeout

  /** The options that route a component's timers and its clock through this clock. */
  get options(): { setTimeoutFn: typeof setTimeout; clearTimeoutFn: typeof clearTimeout; now: () => number } {
    return { setTimeoutFn: this.setTimeoutFn, clearTimeoutFn: this.clearTimeoutFn, now: this.now }
  }

  get armed(): number {
    return this.timers.size
  }

  /** Move the clock forward `ms`, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry
      }
      if (!next) break
      this.timers.delete(next[0])
      this.nowMs = Math.max(this.nowMs, next[1].at)
      next[1].fn()
    }
    this.nowMs = target
  }
}
