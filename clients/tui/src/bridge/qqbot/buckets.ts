import type { QuotaSnapshot } from "./anchors"

export const GROUP_QPM = 20
export const GROUP_DAILY = 1000
export const BOT_QPM_DEFAULT = 30
export const C2C_QPM = 20
export const C2C_DAILY = 1000

const MINUTE_MS = 60_000

export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number,
    tokens?: number,
  ) {
    this.tokens = tokens ?? capacity
    this.last = now()
  }

  peek(): number {
    this.refill()
    return this.tokens
  }

  tryTake(): boolean {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /** Milliseconds until one token is available. 0 if a take would succeed now. */
  waitMs(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    if (this.refillPerMs <= 0) return Number.POSITIVE_INFINITY
    return Math.ceil((1 - this.tokens) / this.refillPerMs)
  }

  private refill(): void {
    const now = this.now()
    const elapsed = Math.max(0, now - this.last)
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.last = now
  }
}

export type DailyTake = "ok" | "warn80" | "cap100" | "blocked"

export class DailyCap {
  day: string
  used: number
  warned80: boolean
  told100: boolean

  constructor(
    readonly cap: number,
    private readonly now: () => number,
    state?: { day: string; used: number; warned80?: boolean; told100?: boolean },
  ) {
    const today = utcDayKey(now())
    if (state && state.day === today) {
      this.day = state.day
      this.used = state.used
      this.warned80 = Boolean(state.warned80)
      this.told100 = Boolean(state.told100)
    } else {
      this.day = today
      this.used = 0
      this.warned80 = false
      this.told100 = false
    }
  }

  remaining(): number {
    this.roll()
    return Math.max(0, this.cap - this.used)
  }

  take(): DailyTake {
    this.roll()
    if (this.used >= this.cap) return "blocked"
    this.used += 1
    if (this.used >= this.cap) {
      this.told100 = true
      return "cap100"
    }
    if (this.used >= Math.ceil(this.cap * 0.8) && !this.warned80) {
      this.warned80 = true
      return "warn80"
    }
    return "ok"
  }

  snapshot(): { day: string; used: number; warned80: boolean; told100: boolean } {
    this.roll()
    return { day: this.day, used: this.used, warned80: this.warned80, told100: this.told100 }
  }

  private roll(): void {
    const today = utcDayKey(this.now())
    if (today === this.day) return
    this.day = today
    this.used = 0
    this.warned80 = false
    this.told100 = false
  }
}

export type GroupQuotaResult =
  | { ok: true; daily: DailyTake }
  | { ok: false; reason: "wait"; waitMs: number }
  | { ok: false; reason: "daily" }

/**
 * Three token buckets for ON-mode active messages. Passive replies bypass this.
 * Group: 20/min + 1,000/day. Bot: `botQpm`/min (default 30). C2C per user: 20/min + 1,000/day.
 */
export class ActiveQuota {
  readonly groupMinute: TokenBucket
  readonly groupDay: DailyCap
  readonly botMinute: TokenBucket
  private readonly c2cMinute = new Map<string, TokenBucket>()
  private readonly c2cDay = new Map<string, DailyCap>()
  private readonly now: () => number
  private readonly botQpm: number

  constructor(opts: { now?: () => number; botQpm?: number; snapshot?: QuotaSnapshot } = {}) {
    this.now = opts.now ?? Date.now
    this.botQpm = opts.botQpm ?? BOT_QPM_DEFAULT
    const snap = opts.snapshot
    const today = utcDayKey(this.now())
    this.groupMinute = new TokenBucket(GROUP_QPM, GROUP_QPM / MINUTE_MS, this.now)
    this.botMinute = new TokenBucket(this.botQpm, this.botQpm / MINUTE_MS, this.now)
    this.groupDay = new DailyCap(GROUP_DAILY, this.now, snap && snap.day === today ? {
      day: snap.day,
      used: snap.group,
      warned80: snap.warned80,
      told100: snap.told100,
    } : undefined)
    if (snap && snap.day === today) {
      for (const [user, used] of Object.entries(snap.c2c)) {
        this.c2cDay.set(user, new DailyCap(C2C_DAILY, this.now, { day: snap.day, used }))
      }
    }
  }

  tryGroup(): GroupQuotaResult {
    const waitMs = Math.max(this.groupMinute.waitMs(), this.botMinute.waitMs())
    if (waitMs > 0) return { ok: false, reason: "wait", waitMs }
    if (this.groupDay.remaining() <= 0) return { ok: false, reason: "daily" }
    this.groupMinute.tryTake()
    this.botMinute.tryTake()
    const daily = this.groupDay.take()
    return { ok: true, daily }
  }

  tryC2C(userOpenid: string): GroupQuotaResult {
    const minute = this.c2cMinuteOf(userOpenid)
    const day = this.c2cDayOf(userOpenid)
    const waitMs = Math.max(minute.waitMs(), this.botMinute.waitMs())
    if (waitMs > 0) return { ok: false, reason: "wait", waitMs }
    if (day.remaining() <= 0) return { ok: false, reason: "daily" }
    minute.tryTake()
    this.botMinute.tryTake()
    const daily = day.take()
    return { ok: true, daily }
  }

  snapshot(): QuotaSnapshot {
    const c2c: Record<string, number> = {}
    for (const [user, cap] of this.c2cDay) c2c[user] = cap.snapshot().used
    const group = this.groupDay.snapshot()
    return {
      day: group.day,
      group: group.used,
      bot: 0,
      c2c,
      warned80: group.warned80,
      told100: group.told100,
    }
  }

  private c2cMinuteOf(user: string): TokenBucket {
    let bucket = this.c2cMinute.get(user)
    if (!bucket) {
      bucket = new TokenBucket(C2C_QPM, C2C_QPM / MINUTE_MS, this.now)
      this.c2cMinute.set(user, bucket)
    }
    return bucket
  }

  private c2cDayOf(user: string): DailyCap {
    let cap = this.c2cDay.get(user)
    if (!cap) {
      cap = new DailyCap(C2C_DAILY, this.now)
      this.c2cDay.set(user, cap)
    }
    return cap
  }
}
