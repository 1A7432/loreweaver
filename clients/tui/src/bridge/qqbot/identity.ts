import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto"
import { tt } from "../../i18n"
import { keyNameFromDisplay } from "../keyring"
import { readPrivateJson, writePrivateAtomic } from "../persist"

/** Crockford-ish: no 0/O, 1/I/L. Length 32 divides 256, so sampling is unbiased. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const CLAIM_CODE_LENGTH = 8
export const LINK_CODE_LENGTH = 6
export const CLAIM_CODE_TTL_MS = 30 * 60 * 1000
export const LINK_CODE_TTL_MS = 5 * 60 * 1000
export const CLAIM_REJECT_COOLDOWN_MS = 30_000
export const UNBOUND_C2C_LOG_EVERY_MS = 10 * 60 * 1000

const C2C_CLAIM_RE = /^\s*[./。]bridge\s+claim\b/i

export function identityPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.identity.json`
}

export function isC2CClaimText(text: string): boolean {
  return C2C_CLAIM_RE.test(text)
}

/** Last 4 hex digits of `openid`; hashed tail when the id has no hex. */
export function openidTail(openid: string): string {
  const hex = [...openid].filter((ch) => /[0-9a-fA-F]/.test(ch)).join("").toLowerCase()
  if (hex.length >= 4) return hex.slice(-4)
  return createHash("sha256").update(openid, "utf8").digest("hex").slice(-4)
}

/**
 * Display name for a new seat: cleaned `username` when present, else the
 * anonymous i18n form. Collision with another seat is the keyring's rule at mint.
 */
export function seatName(event: { username?: string; memberOpenid: string }, locale?: string): string {
  const fromUser = keyNameFromDisplay(event.username)
  if (fromUser) return fromUser
  return tt(locale, "bridge.qqbot.anonymousSeat", { tail: openidTail(event.memberOpenid) })
}

export type C2CInboundAction = "claim" | "forward" | "ignore"

export interface PendingClaim {
  userOpenid: string
  unionOpenid?: string
  linkHash: string
  linkExpiresAt: number
}

export interface IdentityBinding {
  memberOpenid: string
  userOpenid: string
}

export interface ClaimInput {
  channel: "group" | "private"
  code: string
  userOpenid?: string
  memberOpenid?: string
  unionOpenid?: string
}

export type ClaimOutcome =
  | { outcome: "link_issued"; linkCode: string; userOpenid: string }
  | { outcome: "done"; memberOpenid: string; userOpenid: string }
  | { outcome: "rejected" }
  | { outcome: "cooldown" }
  | { outcome: "usage" }

export interface IdentityState {
  claimHash?: string
  claimExpiresAt?: number
  pending: PendingClaim[]
  bindings: IdentityBinding[]
  chosenNames: Record<string, string>
  claimRejectUntil: Record<string, number>
  unboundC2cLogAt: Record<string, number>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex")
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase()
}

function randomCode(length: number, randomBytes: (n: number) => Uint8Array): string {
  const out: string[] = []
  while (out.length < length) {
    const buf = randomBytes(Math.max(1, length - out.length))
    for (const byte of buf) {
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!)
      if (out.length >= length) break
    }
  }
  return out.join("")
}

function parsePending(raw: unknown): PendingClaim[] {
  if (!Array.isArray(raw)) return []
  const out: PendingClaim[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const userOpenid = rec ? asString(rec.userOpenid) : undefined
    const linkHash = rec ? asString(rec.linkHash) : undefined
    const linkExpiresAt = rec ? asNumber(rec.linkExpiresAt) : undefined
    if (!userOpenid || !linkHash || linkExpiresAt === undefined) continue
    const unionOpenid = rec ? asString(rec.unionOpenid) : undefined
    out.push({ userOpenid, linkHash, linkExpiresAt, ...(unionOpenid ? { unionOpenid } : {}) })
  }
  return out
}

function parseBindings(raw: unknown): IdentityBinding[] {
  if (!Array.isArray(raw)) return []
  const out: IdentityBinding[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const memberOpenid = rec ? asString(rec.memberOpenid) : undefined
    const userOpenid = rec ? asString(rec.userOpenid) : undefined
    if (!memberOpenid || !userOpenid) continue
    out.push({ memberOpenid, userOpenid })
  }
  return out
}

function parseStringMap(raw: unknown): Record<string, string> {
  const rec = asRecord(raw)
  if (!rec) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === "string" && value) out[key] = value
  }
  return out
}

function parseNumberMap(raw: unknown): Record<string, number> {
  const rec = asRecord(raw)
  if (!rec) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value
  }
  return out
}

export class IdentityStore {
  claimHash: string | undefined
  claimExpiresAt: number | undefined
  pending: PendingClaim[] = []
  bindings: IdentityBinding[] = []
  chosenNames: Record<string, string> = {}
  claimRejectUntil: Record<string, number> = {}
  unboundC2cLogAt: Record<string, number> = {}
  private writeChain: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly randomBytes: (n: number) => Uint8Array
  private readonly onLog: (line: string) => void
  private readonly locale: string | undefined

  constructor(
    private readonly path: string,
    private readonly groupId: string,
    opts: {
      now?: () => number
      randomBytes?: (n: number) => Uint8Array
      onLog?: (line: string) => void
      locale?: string
    } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.randomBytes = opts.randomBytes ?? ((n) => nodeRandomBytes(n))
    this.onLog = opts.onLog ?? (() => {})
    this.locale = opts.locale
  }

  static async load(
    path: string,
    groupId: string,
    opts: ConstructorParameters<typeof IdentityStore>[2] = {},
  ): Promise<IdentityStore> {
    const store = new IdentityStore(path, groupId, opts)
    const rec = asRecord(await readPrivateJson(path))
    if (!rec) return store
    store.claimHash = asString(rec.claimHash)
    store.claimExpiresAt = asNumber(rec.claimExpiresAt)
    store.pending = parsePending(rec.pending)
    store.bindings = parseBindings(rec.bindings)
    store.chosenNames = parseStringMap(rec.chosenNames)
    store.claimRejectUntil = parseNumberMap(rec.claimRejectUntil)
    store.unboundC2cLogAt = parseNumberMap(rec.unboundC2cLogAt)
    store.prune(store.now())
    return store
  }

  /**
   * Console-only: 8-char claim code, 30 minutes, one use. A new issue invalidates
   * the previous unused claim code for this group. Never logged.
   */
  async issueClaimCode(groupId = this.groupId): Promise<string> {
    const code = randomCode(CLAIM_CODE_LENGTH, this.randomBytes)
    this.claimHash = hashCode(code)
    this.claimExpiresAt = this.now() + CLAIM_CODE_TTL_MS
    this.onLog(`qqbot.claim.issued ${groupId}`)
    await this.flush()
    return code
  }

  resolveC2C(seat: string): string | undefined {
    return this.bindings.find((row) => row.memberOpenid === seat)?.userOpenid
  }

  isBoundC2C(userOpenid: string): boolean {
    return this.bindings.some((row) => row.userOpenid === userOpenid)
  }

  seatForC2C(userOpenid: string): string | undefined {
    return this.bindings.find((row) => row.userOpenid === userOpenid)?.memberOpenid
  }

  isAdminMember(memberOpenid: string): boolean {
    return this.bindings.some((row) => row.memberOpenid === memberOpenid)
  }

  chosenName(memberOpenid: string): string | undefined {
    const name = this.chosenNames[memberOpenid]
    return name || undefined
  }

  displayNameFor(memberOpenid: string, event?: { username?: string }, locale = this.locale): string {
    const chosen = this.chosenName(memberOpenid)
    if (chosen) return chosen
    return seatName({ username: event?.username, memberOpenid }, locale)
  }

  async setChosenName(memberOpenid: string, name: string): Promise<string> {
    const cleaned = keyNameFromDisplay(name)
    if (!cleaned) return cleaned
    this.chosenNames[memberOpenid] = cleaned
    await this.flush()
    return cleaned
  }

  /**
   * Unbound C2C is claim-only. Everything else is ignored: no seat, no forward,
   * one `qqbot.c2c.unbound` line per openid per 10 minutes.
   */
  acceptC2CInbound(userOpenid: string, text: string): C2CInboundAction {
    if (isC2CClaimText(text)) return "claim"
    if (this.isBoundC2C(userOpenid)) return "forward"
    void this.noteUnboundC2C(userOpenid)
    return "ignore"
  }

  async noteUnboundC2C(userOpenid: string): Promise<boolean> {
    const now = this.now()
    const last = this.unboundC2cLogAt[userOpenid]
    if (last !== undefined && now - last < UNBOUND_C2C_LOG_EVERY_MS) return false
    this.unboundC2cLogAt[userOpenid] = now
    this.onLog("qqbot.c2c.unbound")
    await this.flush()
    return true
  }

  /**
   * Assumption A2: a later group message with the same non-empty unionOpenid
   * as a pending C2C claim completes the link with no code. Empty on either
   * side never links. Never trusted for anything else.
   */
  async tryUnionLink(input: { memberOpenid: string; unionOpenid?: string }): Promise<IdentityBinding | undefined> {
    const union = input.unionOpenid?.trim()
    if (!union || !input.memberOpenid) return undefined
    this.prune(this.now())
    const pending = this.pending.find((row) => row.unionOpenid && row.unionOpenid === union)
    if (!pending) return undefined
    const binding = this.bind(input.memberOpenid, pending.userOpenid)
    this.pending = this.pending.filter((row) => row !== pending)
    this.onLog("qqbot.claim.union_linked")
    await this.flush()
    return binding
  }

  async claim(input: ClaimInput): Promise<ClaimOutcome> {
    const code = normalizeCode(input.code)
    if (!code) return { outcome: "usage" }
    this.prune(this.now())

    if (input.channel === "private") {
      return this.claimFromC2C(code, input)
    }
    return this.claimFromGroup(code, input)
  }

  snapshot(): IdentityState {
    this.prune(this.now())
    return {
      ...(this.claimHash ? { claimHash: this.claimHash, claimExpiresAt: this.claimExpiresAt } : {}),
      pending: this.pending.map((row) => ({ ...row })),
      bindings: this.bindings.map((row) => ({ ...row })),
      chosenNames: { ...this.chosenNames },
      claimRejectUntil: { ...this.claimRejectUntil },
      unboundC2cLogAt: { ...this.unboundC2cLogAt },
    }
  }

  flush(): Promise<void> {
    const body = JSON.stringify(this.snapshot())
    this.writeChain = this.writeChain
      .then(() => writePrivateAtomic(this.path, body))
      .catch(() => {
        this.onLog(`qqbot.persist.failed ${this.path}`)
      })
    return this.writeChain
  }

  async drainWrites(): Promise<void> {
    await this.writeChain
  }

  private async claimFromC2C(code: string, input: ClaimInput): Promise<ClaimOutcome> {
    const userOpenid = input.userOpenid?.trim()
    if (!userOpenid) return { outcome: "rejected" }

    const now = this.now()
    const until = this.claimRejectUntil[userOpenid]
    if (until !== undefined && now < until) return { outcome: "cooldown" }

    if (this.isBoundC2C(userOpenid)) {
      const seat = this.seatForC2C(userOpenid)
      if (seat) return { outcome: "done", memberOpenid: seat, userOpenid }
    }

    // Link codes are never accepted on C2C, even if the string matches a pending hash.
    if (code.length !== CLAIM_CODE_LENGTH) {
      return this.rejectClaim(userOpenid)
    }

    if (!this.claimValid(code)) return this.rejectClaim(userOpenid)

    this.claimHash = undefined
    this.claimExpiresAt = undefined
    const linkCode = randomCode(LINK_CODE_LENGTH, this.randomBytes)
    const unionOpenid = input.unionOpenid?.trim() || undefined
    this.pending = this.pending.filter((row) => row.userOpenid !== userOpenid)
    this.pending.push({
      userOpenid,
      linkHash: hashCode(linkCode),
      linkExpiresAt: now + LINK_CODE_TTL_MS,
      ...(unionOpenid ? { unionOpenid } : {}),
    })
    await this.flush()
    return { outcome: "link_issued", linkCode, userOpenid }
  }

  private async claimFromGroup(code: string, input: ClaimInput): Promise<ClaimOutcome> {
    const memberOpenid = input.memberOpenid?.trim()
    if (!memberOpenid) return { outcome: "rejected" }

    const existing = this.bindings.find((row) => row.memberOpenid === memberOpenid)
    if (existing) return { outcome: "done", memberOpenid, userOpenid: existing.userOpenid }

    const union = input.unionOpenid?.trim()
    if (union) {
      const byUnion = this.pending.find((row) => row.unionOpenid && row.unionOpenid === union)
      if (byUnion) {
        const binding = this.bind(memberOpenid, byUnion.userOpenid)
        this.pending = this.pending.filter((row) => row !== byUnion)
        this.onLog("qqbot.claim.union_linked")
        await this.flush()
        return { outcome: "done", memberOpenid: binding.memberOpenid, userOpenid: binding.userOpenid }
      }
    }

    // Claim codes are never accepted in the group, even if the hash would match.
    if (code.length !== LINK_CODE_LENGTH) return { outcome: "rejected" }

    const hashed = hashCode(code)
    const now = this.now()
    const pending = this.pending.find((row) => hashesEqual(row.linkHash, hashed) && now < row.linkExpiresAt)
    if (!pending) return { outcome: "rejected" }

    const binding = this.bind(memberOpenid, pending.userOpenid)
    this.pending = this.pending.filter((row) => row !== pending)
    await this.flush()
    return { outcome: "done", memberOpenid: binding.memberOpenid, userOpenid: binding.userOpenid }
  }

  private claimValid(code: string): boolean {
    if (!this.claimHash || this.claimExpiresAt === undefined) return false
    if (this.now() >= this.claimExpiresAt) return false
    if (code.length !== CLAIM_CODE_LENGTH) return false
    return hashesEqual(this.claimHash, hashCode(code))
  }

  private async rejectClaim(userOpenid: string): Promise<ClaimOutcome> {
    this.claimRejectUntil[userOpenid] = this.now() + CLAIM_REJECT_COOLDOWN_MS
    await this.flush()
    return { outcome: "rejected" }
  }

  private bind(memberOpenid: string, userOpenid: string): IdentityBinding {
    this.bindings = this.bindings.filter((row) => row.memberOpenid !== memberOpenid && row.userOpenid !== userOpenid)
    const binding = { memberOpenid, userOpenid }
    this.bindings.push(binding)
    return binding
  }

  private prune(now: number): void {
    if (this.claimExpiresAt !== undefined && now >= this.claimExpiresAt) {
      this.claimHash = undefined
      this.claimExpiresAt = undefined
    }
    this.pending = this.pending.filter((row) => now < row.linkExpiresAt)
    for (const [key, until] of Object.entries(this.claimRejectUntil)) {
      if (until <= now) delete this.claimRejectUntil[key]
    }
    for (const [key, at] of Object.entries(this.unboundC2cLogAt)) {
      if (now - at >= UNBOUND_C2C_LOG_EVERY_MS * 2) delete this.unboundC2cLogAt[key]
    }
  }
}
