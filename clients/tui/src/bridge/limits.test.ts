import { describe, expect, test } from "bun:test"
import { UserRateLimiter } from "./limits"

describe("UserRateLimiter", () => {
  test("a burst yields one notice then silent drops, then recovers", () => {
    let now = 0
    const limiter = new UserRateLimiter(3, 1000, () => now)
    expect(limiter.take("7")).toBe("ok")
    expect(limiter.take("7")).toBe("ok")
    expect(limiter.take("7")).toBe("ok")
    expect(limiter.take("7")).toBe("notice")
    expect(limiter.take("7")).toBe("drop")
    expect(limiter.take("7")).toBe("drop")
    expect(limiter.take("8")).toBe("ok")
    now = 5000
    expect(limiter.take("7")).toBe("ok")
  })
})
