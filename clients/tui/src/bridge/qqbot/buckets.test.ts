import { describe, expect, test } from "bun:test"
import { ActiveQuota, GROUP_DAILY, GROUP_QPM, TokenBucket } from "./buckets"

describe("buckets", () => {
  test("token bucket refills at the configured rate with an injected now", () => {
    let now = 0
    const bucket = new TokenBucket(GROUP_QPM, GROUP_QPM / 60_000, () => now)
    for (let i = 0; i < GROUP_QPM; i++) expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
    expect(bucket.waitMs()).toBeGreaterThan(0)
    now += 60_000
    expect(bucket.tryTake()).toBe(true)
  })

  test("group active quota: 20/min, 1000/day, bot 30/min; dailyCap at 100%", () => {
    let now = 0
    const quota = new ActiveQuota({
      now: () => now,
      botQpm: 30,
      snapshot: { day: "1970-01-01", group: 999, bot: 0, c2c: {}, told100: false },
    })
    const hit = quota.tryGroup()
    expect(hit).toEqual({ ok: true, daily: "cap100" })
    const blocked = quota.tryGroup()
    expect(blocked).toEqual({ ok: false, reason: "daily" })
    expect(quota.snapshot().group).toBe(GROUP_DAILY)
  })

  test("C2C quota is per user", () => {
    const now = () => 0
    const quota = new ActiveQuota({ now, snapshot: { day: "1970-01-01", group: 0, bot: 0, c2c: { u1: 1000 } } })
    expect(quota.tryC2C("u1")).toEqual({ ok: false, reason: "daily" })
    expect(quota.tryC2C("u2").ok).toBe(true)
  })
})
