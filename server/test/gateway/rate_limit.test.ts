import { expect, test } from "bun:test";

import { MAX_RATE_BUCKETS, RateLimiter } from "../../src/gateway/rate_limit.ts";

test("a burst of `capacity`, then one token per refill interval, per member", () => {
  let now = 0;
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 0.5 }, () => now);
  expect([1, 2, 3, 4].map(() => limiter.allow("ada"))).toEqual([true, true, true, false]);
  expect(limiter.allow("bao")).toBe(true);
  now += 1_999;
  expect(limiter.allow("ada")).toBe(false);
  now += 1;
  expect(limiter.allow("ada")).toBe(true);
  expect(limiter.allow("ada")).toBe(false);
  // Refill never exceeds the capacity, however long the pause.
  now += 1_000_000;
  expect([1, 2, 3, 4].map(() => limiter.allow("ada"))).toEqual([true, true, true, false]);
});

test("the table is capped: full buckets are dropped, and a new member waits while every tracked one is mid-burst", () => {
  let now = 0;
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, () => now);
  for (let i = 0; i < MAX_RATE_BUCKETS; i++) expect(limiter.allow(`m${i}`)).toBe(true);
  expect(limiter.allow("late")).toBe(false);
  now += 1_000;
  expect(limiter.allow("late")).toBe(true);
});
