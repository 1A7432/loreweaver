import type { QQBotClock } from "../shared"

export type { QQBotClock }

/**
 * Deterministic clock for token-refresh / backoff tests. `sleep` parks until
 * `advance` moves `now` past the deadline (or the abort signal fires).
 */
export class FakeClock implements QQBotClock {
  nowMs: number
  private nextId = 1
  private readonly waiters: Array<{ id: number; at: number; resolve: () => void }> = []

  constructor(startMs = 0) {
    this.nowMs = startMs
  }

  now(): number {
    return this.nowMs
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const id = this.nextId
      this.nextId += 1
      const entry = { id, at: this.nowMs + ms, resolve }
      this.waiters.push(entry)
      const onAbort = () => {
        const index = this.waiters.findIndex((item) => item.id === id)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  async advance(ms: number): Promise<void> {
    this.nowMs += ms
    const due = this.waiters.filter((item) => item.at <= this.nowMs)
    const rest = this.waiters.filter((item) => item.at > this.nowMs)
    this.waiters.length = 0
    this.waiters.push(...rest)
    for (const item of due) item.resolve()
    await Promise.resolve()
  }
}
