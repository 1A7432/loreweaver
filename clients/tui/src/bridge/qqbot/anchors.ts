import { readPrivateJson, writePrivateAtomic } from "../persist"

export const GROUP_WINDOW_MS = 5 * 60 * 1000
export const C2C_WINDOW_MS = 60 * 60 * 1000
export const GROUP_BUDGET = 5
export const C2C_BUDGET = 4
export const MIN_MARGIN_MS = 10_000
export const DEFAULT_SEND_TIMEOUT_MS = 5_000

export type AnchorScope = "group" | "c2c"

export interface Anchor {
  id: string
  scope: AnchorScope
  target: string
  seat?: string
  received_at: number
  expires_at: number
  /** Remaining accepted-passive budget. */
  budget: number
  budgetMax: number
  /** Attempt counter; every POST (retries included) increments this. */
  seq: number
  dead?: boolean
}

export interface QuotaSnapshot {
  day: string
  group: number
  bot: number
  c2c: Record<string, number>
  warned80?: boolean
  told100?: boolean
}

export interface AnchorState {
  anchors: Anchor[]
  /** `null` = unknown at startup; first active send settles it. */
  groupActive: boolean | null
  c2cActive: Record<string, boolean>
  activeUnpermitted: boolean
  lastActiveOffAt?: number
  quota?: QuotaSnapshot
}

export function anchorsPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.anchors.json`
}

export function windowMs(scope: AnchorScope): number {
  return scope === "group" ? GROUP_WINDOW_MS : C2C_WINDOW_MS
}

export function budgetMaxFor(scope: AnchorScope): number {
  return scope === "group" ? GROUP_BUDGET : C2C_BUDGET
}

/**
 * Platform window end minus remaining planned sends × send timeout, never less
 * than 10 s of margin.
 */
export function computeExpiresAt(
  receivedAt: number,
  scope: AnchorScope,
  remainingPlannedSends: number,
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
): number {
  const margin = Math.max(MIN_MARGIN_MS, Math.max(0, remainingPlannedSends) * sendTimeoutMs)
  return receivedAt + windowMs(scope) - margin
}

export function isAnchorOpen(anchor: Anchor, now: number): boolean {
  if (anchor.dead) return false
  if (anchor.budget <= 0) return false
  return now < anchor.expires_at
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function parseAnchor(raw: unknown): Anchor | undefined {
  const rec = asRecord(raw)
  if (!rec) return undefined
  const id = asString(rec.id)
  const scope = rec.scope === "group" || rec.scope === "c2c" ? rec.scope : undefined
  const target = asString(rec.target)
  const received_at = asNumber(rec.received_at)
  const expires_at = asNumber(rec.expires_at)
  const budget = asNumber(rec.budget)
  const seq = asNumber(rec.seq)
  if (!id || !scope || !target || received_at === undefined || expires_at === undefined || budget === undefined || seq === undefined) {
    return undefined
  }
  const budgetMax = asNumber(rec.budgetMax) ?? budgetMaxFor(scope)
  const seat = asString(rec.seat)
  const dead = rec.dead === true
  return {
    id,
    scope,
    target,
    ...(seat ? { seat } : {}),
    received_at,
    expires_at,
    budget,
    budgetMax,
    seq,
    ...(dead ? { dead: true } : {}),
  }
}

function parseState(raw: unknown): AnchorState {
  const rec = asRecord(raw)
  const anchors: Anchor[] = []
  const list = rec && Array.isArray(rec.anchors) ? rec.anchors : Array.isArray(raw) ? raw : []
  for (const item of list) {
    const parsed = parseAnchor(item)
    if (parsed) anchors.push(parsed)
  }
  const groupActive = rec && "groupActive" in rec ? (rec.groupActive === null ? null : asBoolean(rec.groupActive) ?? null) : null
  const c2cActive: Record<string, boolean> = {}
  const c2cRaw = rec ? asRecord(rec.c2cActive) : undefined
  if (c2cRaw) {
    for (const [key, value] of Object.entries(c2cRaw)) {
      if (typeof value === "boolean") c2cActive[key] = value
    }
  }
  const quotaRaw = rec ? asRecord(rec.quota) : undefined
  let quota: QuotaSnapshot | undefined
  if (quotaRaw) {
    const day = asString(quotaRaw.day)
    const group = asNumber(quotaRaw.group)
    const bot = asNumber(quotaRaw.bot)
    if (day && group !== undefined && bot !== undefined) {
      const c2c: Record<string, number> = {}
      const c2cCounts = asRecord(quotaRaw.c2c)
      if (c2cCounts) {
        for (const [key, value] of Object.entries(c2cCounts)) {
          if (typeof value === "number" && Number.isFinite(value)) c2c[key] = value
        }
      }
      quota = {
        day,
        group,
        bot,
        c2c,
        warned80: quotaRaw.warned80 === true,
        told100: quotaRaw.told100 === true,
      }
    }
  }
  return {
    anchors,
    groupActive,
    c2cActive,
    activeUnpermitted: rec?.activeUnpermitted === true,
    lastActiveOffAt: rec ? asNumber(rec.lastActiveOffAt) : undefined,
    quota,
  }
}

export class AnchorRegistry {
  private anchors: Anchor[] = []
  groupActive: boolean | null = null
  readonly c2cActive = new Map<string, boolean>()
  activeUnpermitted = false
  lastActiveOffAt: number | undefined
  quota: QuotaSnapshot | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private readonly sendTimeoutMs: number
  private readonly now: () => number

  constructor(
    private readonly path: string,
    opts: { sendTimeoutMs?: number; now?: () => number } = {},
  ) {
    this.sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
    this.now = opts.now ?? Date.now
  }

  static async load(
    path: string,
    opts: { sendTimeoutMs?: number; now?: () => number } = {},
  ): Promise<AnchorRegistry> {
    const store = new AnchorRegistry(path, opts)
    const parsed = parseState(await readPrivateJson(path))
    store.anchors = parsed.anchors
    store.groupActive = parsed.groupActive
    store.activeUnpermitted = parsed.activeUnpermitted
    store.lastActiveOffAt = parsed.lastActiveOffAt
    store.quota = parsed.quota
    for (const [key, value] of Object.entries(parsed.c2cActive)) store.c2cActive.set(key, value)
    return store
  }

  list(): readonly Anchor[] {
    return this.anchors
  }

  get(id: string): Anchor | undefined {
    return this.anchors.find((item) => item.id === id)
  }

  create(input: {
    id: string
    scope: AnchorScope
    target: string
    seat?: string
    receivedAt: number
  }): Anchor {
    const existing = this.get(input.id)
    if (existing) return existing
    const budgetMax = budgetMaxFor(input.scope)
    const anchor: Anchor = {
      id: input.id,
      scope: input.scope,
      target: input.target,
      ...(input.seat ? { seat: input.seat } : {}),
      received_at: input.receivedAt,
      expires_at: computeExpiresAt(input.receivedAt, input.scope, budgetMax, this.sendTimeoutMs),
      budget: budgetMax,
      budgetMax,
      seq: 0,
    }
    this.anchors.push(anchor)
    return anchor
  }

  /** Increment the attempt counter and return the seq to send. */
  bumpSeq(anchor: Anchor): number {
    anchor.seq += 1
    this.refreshExpiry(anchor)
    return anchor.seq
  }

  spendBudget(anchor: Anchor): void {
    if (anchor.budget > 0) anchor.budget -= 1
    this.refreshExpiry(anchor)
  }

  markDead(anchor: Anchor): void {
    anchor.dead = true
    anchor.budget = 0
  }

  refreshExpiry(anchor: Anchor): void {
    anchor.expires_at = computeExpiresAt(anchor.received_at, anchor.scope, anchor.budget, this.sendTimeoutMs)
  }

  isOpen(anchor: Anchor, now = this.now()): boolean {
    return isAnchorOpen(anchor, now)
  }

  newestOpen(scope: AnchorScope, target?: string, now = this.now()): Anchor | undefined {
    let best: Anchor | undefined
    for (const anchor of this.anchors) {
      if (anchor.scope !== scope) continue
      if (target !== undefined && anchor.target !== target) continue
      if (!this.isOpen(anchor, now)) continue
      if (!best || anchor.received_at > best.received_at || (anchor.received_at === best.received_at && this.anchors.indexOf(anchor) > this.anchors.indexOf(best))) {
        best = anchor
      }
    }
    return best
  }

  newestOpenForSeat(seat: string, now = this.now()): Anchor | undefined {
    let best: Anchor | undefined
    for (const anchor of this.anchors) {
      if (anchor.seat !== seat) continue
      if (!this.isOpen(anchor, now)) continue
      if (!best || anchor.received_at > best.received_at) best = anchor
    }
    return best
  }

  setGroupActive(on: boolean | null): void {
    this.groupActive = on
  }

  setC2CActive(userOpenid: string, on: boolean): void {
    this.c2cActive.set(userOpenid, on)
  }

  c2cFlag(userOpenid: string): boolean | undefined {
    return this.c2cActive.get(userOpenid)
  }

  snapshot(): AnchorState {
    const c2cActive: Record<string, boolean> = {}
    for (const [key, value] of this.c2cActive) c2cActive[key] = value
    return {
      anchors: this.anchors.map((item) => ({ ...item })),
      groupActive: this.groupActive,
      c2cActive,
      activeUnpermitted: this.activeUnpermitted,
      lastActiveOffAt: this.lastActiveOffAt,
      quota: this.quota ? { ...this.quota, c2c: { ...this.quota.c2c } } : undefined,
    }
  }

  flush(): Promise<void> {
    const body = JSON.stringify(this.snapshot())
    this.writeChain = this.writeChain.then(() => writePrivateAtomic(this.path, body)).catch(() => {})
    return this.writeChain
  }
}
