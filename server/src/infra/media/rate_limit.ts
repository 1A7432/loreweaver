// A refilling bucket per key: `perMinute` tokens at most, one back every
// `60 / perMinute` seconds, one spent per offer. Time comes from the injected clock.

interface Bucket {
  tokens: number;
  at: number;
}

// Buckets that have refilled completely carry no information; once the map grows past
// this many entries those are dropped, so idle members do not accumulate forever.
const PRUNE_ABOVE = 1024;

export class RateLimiter {
  readonly #capacity: number;
  readonly #perMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(perMinute: number, now: () => number) {
    this.#capacity = perMinute;
    this.#perMs = perMinute / 60_000;
    this.#now = now;
  }

  /** Spend one token for `key`; false (and nothing spent) when the bucket is empty. */
  take(key: string): boolean {
    const now = this.#now();
    if (this.#buckets.size > PRUNE_ABOVE) this.#prune(now);
    const bucket = this.#buckets.get(key);
    const tokens = bucket === undefined ? this.#capacity : this.#level(bucket, now);
    if (tokens < 1) {
      this.#buckets.set(key, { tokens, at: now });
      return false;
    }
    this.#buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  #level(bucket: Bucket, now: number): number {
    // A clock that steps backwards refills nothing rather than draining the bucket.
    const elapsed = Math.max(0, now - bucket.at);
    return Math.min(this.#capacity, bucket.tokens + elapsed * this.#perMs);
  }

  #prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (this.#level(bucket, now) >= this.#capacity) this.#buckets.delete(key);
    }
  }
}
