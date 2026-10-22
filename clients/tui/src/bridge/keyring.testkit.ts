/**
 * Test doubles for the keyring tests. Nothing here sleeps: a test waits for the frame the
 * keyring actually sends (`FakeControl.waitForSent`) and fires a request timeout only by
 * hand (`ManualClock.fire`), so a starved runner changes how long a test takes, never
 * what it sees.
 */
import type { ClientFrame, ServerFrame } from "loreweaver-protocol"
import type { ControlLink } from "./keyring"

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

/** Wait until the keyring holds an entry for `userId` (a late-mint adoption, say). */
export async function waitForEntry(ring: { get(userId: string): unknown }, userId: string): Promise<void> {
  await waitFor(`a keyring entry for ${userId}`, () => ring.get(userId) !== undefined)
}

/** A few event-loop turns: lets a frame that must NOT be sent show up if it were going to. */
export async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

export class FakeControl implements ControlLink {
  sent: ClientFrame[] = []
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  send(frame: ClientFrame): void {
    this.sent.push(frame)
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => {
      this.handlers.delete(cb)
    }
  }
  push(frame: ServerFrame): void {
    for (const handler of this.handlers) handler(frame)
  }
  /** Wait until the keyring has sent `count` frames in total; returns the `count`-th. */
  async waitForSent(count: number): Promise<ClientFrame> {
    await waitFor(`${count} sent control frame(s)`, () => this.sent.length >= count, () => `sent so far: ${JSON.stringify(this.sent)}`)
    return this.sent[count - 1]!
  }
}

/** Manual timers + clock: a request timeout fires only when the test calls `fire()`. */
export class ManualClock {
  nowMs = 0
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()
  now = (): number => this.nowMs
  setTimeoutFn = ((fn: () => void, ms = 0): ReturnType<typeof setTimeout> => {
    const id = ++this.seq
    this.timers.set(id, { at: this.nowMs + ms, fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    this.timers.delete(id as unknown as number)
  }) as unknown as typeof clearTimeout

  /** The Keyring options that route its timers and its late-mint clock through this clock. */
  get options(): { setTimeoutFn: typeof setTimeout; clearTimeoutFn: typeof clearTimeout; now: () => number } {
    return { setTimeoutFn: this.setTimeoutFn, clearTimeoutFn: this.clearTimeoutFn, now: this.now }
  }

  get armed(): number {
    return this.timers.size
  }

  /** Fire the one armed timer (the outstanding request's timeout), advancing the clock to it. */
  fire(): void {
    if (this.timers.size !== 1) throw new Error(`expected exactly one armed timer, found ${this.timers.size}`)
    const [id, timer] = [...this.timers][0]!
    this.timers.delete(id)
    this.nowMs = Math.max(this.nowMs, timer.at)
    timer.fn()
  }
}
