/**
 * Test doubles for the keyring tests. Nothing here sleeps: a test waits for the frame the
 * keyring actually sends (`FakeControl.waitForSent`) and fires a request timeout only by
 * hand (`ManualClock.fire`), so a starved runner changes how long a test takes, never
 * what it sees.
 */
import type { ClientFrame, ServerFrame } from "loreweaver-protocol"
import { ManualClock as BaseClock, waitFor } from "../testkit"
import type { ControlLink } from "./keyring"

export { settle, waitFor } from "../testkit"

/** Wait until the keyring holds an entry for `userId` (a late-mint adoption, say). */
export async function waitForEntry(ring: { get(userId: string): unknown }, userId: string): Promise<void> {
  await waitFor(`a keyring entry for ${userId}`, () => ring.get(userId) !== undefined)
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
export class ManualClock extends BaseClock {
  /** Fire the one armed timer (the outstanding request's timeout), advancing the clock to it. */
  fire(): void {
    if (this.timers.size !== 1) throw new Error(`expected exactly one armed timer, found ${this.timers.size}`)
    const [id, timer] = [...this.timers][0]!
    this.timers.delete(id)
    this.nowMs = Math.max(this.nowMs, timer.at)
    timer.fn()
  }
}
