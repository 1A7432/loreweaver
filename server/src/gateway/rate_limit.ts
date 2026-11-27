// How often one member may put something to the room: a token bucket per member, ported
// from the reference's `gateway/ops.py` `RateLimiter`. A member starts with `capacity`
// tokens; each input or command spends one; tokens come back at `refillPerSecond` up to
// the capacity. With no token left the input is refused (`rate_limited`), not queued.
//
// Time is injected (milliseconds), so a test steps it by hand. The bucket table is capped:
// past `MAX_RATE_BUCKETS` members the buckets that have refilled completely are dropped
// (such a bucket is exactly what a fresh one would be, so nothing is forgotten); when none
// has, a member not yet tracked is refused until one has.

/** Members tracked at once before full buckets are dropped. */
export const MAX_RATE_BUCKETS = 4096;

export interface RateLimitSettings {
  /** The burst a member may send at once. */
  readonly capacity: number;
  /** Tokens returned per second. */
  readonly refillPerSecond: number;
}

/** The reference's defaults: a burst of five, then one every two seconds. */
export const DEFAULT_RATE_LIMIT: RateLimitSettings = { capacity: 5, refillPerSecond: 0.5 };

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(settings: RateLimitSettings, now: () => number) {
    this.#capacity = settings.capacity;
    this.#refillPerMs = settings.refillPerSecond / 1000;
    this.#now = now;
  }

  /** Spend one token of `key`'s bucket; false when it has none. */
  allow(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key);
    const tokens = bucket === undefined ? this.#capacity : this.#level(bucket, now);
    if (tokens < 1) {
      this.#buckets.set(key, { tokens, last: now });
      return false;
    }
    if (bucket === undefined && this.#buckets.size >= MAX_RATE_BUCKETS) {
      this.#prune(now);
      // Every tracked member is mid-burst: a new one waits rather than grow the table.
      if (this.#buckets.size >= MAX_RATE_BUCKETS) return false;
    }
    this.#buckets.set(key, { tokens: tokens - 1, last: now });
    return true;
  }

  #level(bucket: Bucket, now: number): number {
    return Math.min(this.#capacity, bucket.tokens + Math.max(0, now - bucket.last) * this.#refillPerMs);
  }

  #prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (this.#level(bucket, now) >= this.#capacity) this.#buckets.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// An hourly quota: for an action that costs a model call a member can trigger at will
// (`genchar`, a player's card import). A sliding hour per key; time is passed in by the
// caller (the server's clock), so a test steps it by hand. The table of keys is capped like
// the buckets above: past `MAX_QUOTA_KEYS`, keys with nothing left in the hour are dropped,
// and when none has, a key not yet tracked is refused until one has.
// ---------------------------------------------------------------------------

/** Keys an hourly quota tracks at once. */
export const MAX_QUOTA_KEYS = 4096;
/** The window of an hourly quota. */
export const QUOTA_WINDOW_MS = 3_600_000;

export class HourlyQuota {
  readonly #perHour: number;
  readonly #spent = new Map<string, number[]>();

  constructor(perHour: number) {
    this.#perHour = perHour;
  }

  /** Spend one of `key`'s uses this hour; false when none is left. */
  take(key: string, now: number): boolean {
    const recent = (this.#spent.get(key) ?? []).filter((at) => now - at < QUOTA_WINDOW_MS);
    if (recent.length >= this.#perHour) {
      this.#spent.set(key, recent);
      return false;
    }
    if (!this.#spent.has(key) && this.#spent.size >= MAX_QUOTA_KEYS) {
      for (const [other, times] of this.#spent) if (times.every((at) => now - at >= QUOTA_WINDOW_MS)) this.#spent.delete(other);
      if (this.#spent.size >= MAX_QUOTA_KEYS) return false;
    }
    recent.push(now);
    this.#spent.set(key, recent);
    return true;
  }
}
