/** Burst size: a handful of messages pass, then one notice. */
export const BRIDGE_RATE_BURST = 5
/** One token restored per this many milliseconds. */
export const BRIDGE_RATE_REFILL_MS = 1000

export type RateTake = "ok" | "notice" | "drop"

/**
 * Per-user token bucket at OneBot intake. A burst yields ONE reply-to notice
 * instead of a wall of `rate_limited` errors from the engine.
 */
export class UserRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number; warned: boolean }>()

  constructor(
    private readonly burst = BRIDGE_RATE_BURST,
    private readonly refillMs = BRIDGE_RATE_REFILL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  take(userId: string): RateTake {
    const now = this.now()
    let bucket = this.buckets.get(userId)
    if (!bucket) {
      bucket = { tokens: this.burst, last: now, warned: false }
      this.buckets.set(userId, bucket)
    }
    if (this.refillMs > 0) {
      const elapsed = Math.max(0, now - bucket.last)
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed / this.refillMs)
    }
    bucket.last = now
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      bucket.warned = false
      return "ok"
    }
    if (!bucket.warned) {
      bucket.warned = true
      return "notice"
    }
    return "drop"
  }
}
