import { createHash } from "node:crypto"
import {
  FrameType,
  type AdminErrorFrame,
  type AdminKeysFrame,
  type ClientFrame,
  type PlayerRole,
  type ServerFrame,
} from "loreweaver-protocol"
import { readPrivateJson, writePrivateAtomic } from "./persist"

const MINT_TIMEOUT_MS = 10_000
const LATE_MINT_CAP = 32

export function keyringPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.keyring.json`
}

export interface KeyringEntry {
  key: string
  key_id: string
  role: PlayerRole
  /** The key's name as minted — the group card at first message, else `qq:<userId>`. */
  name?: string
}

/** Longest key name minted from a group card; longer cards are cut, never rejected. */
export const MAX_KEY_NAME_CHARS = 32

/** A group card as a key name: trimmed, one-spaced, control characters out, capped. */
export function keyNameFromDisplay(display: string | undefined): string {
  const cleaned = (display ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return [...cleaned].slice(0, MAX_KEY_NAME_CHARS).join("")
}

export interface ControlLink {
  send(frame: ClientFrame): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
}

export class LastKeeperError extends Error {
  readonly code = "last_keeper" as const
  constructor(message = "last_keeper") {
    super(message)
    this.name = "LastKeeperError"
  }
}

export class ObserverProtectedError extends Error {
  readonly code = "observer_protected" as const
  constructor() {
    super("observer_protected")
    this.name = "ObserverProtectedError"
  }
}

type Pending =
  | {
      kind: "mint"
      seq: number
      name: string
      role: PlayerRole
      resolve: (entry: KeyringEntry) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  | {
      kind: "delete"
      seq: number
      id: string
      resolve: (frame: AdminKeysFrame) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }

export function keyIdFromSecret(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16)
}

export function observerName(groupId: string): string {
  return `qq:observer:${groupId}`
}

export function observerUserId(groupId: string): string {
  return `observer:${groupId}`
}

export function memberName(userId: string): string {
  return `qq:${userId}`
}

function isAdminError(frame: ServerFrame): frame is AdminErrorFrame {
  return frame.type === FrameType.AdminError
}

function isAdminKeys(frame: ServerFrame): frame is AdminKeysFrame {
  return frame.type === FrameType.AdminKeys
}

/**
 * QQ id → `{key, key_id, role, name}`. Mints on first message via the control link's
 * `admin_mint_key` (`purpose:"join"`; `role:"keeper"` for configured admins).
 * A member key is NAMED after the player's group card (nickname when there is no card,
 * `qq:<userId>` when the event carries neither): the engine shows a member under its
 * key name and ignores the join-time name (anti-impersonation), so this is the only way
 * the Keeper ever sees "阿绫" rather than "qq:123456789". Names are not unique — the
 * QQ id → key map lives in this file, never in the name. The observer stays
 * `qq:observer:<groupId>`. Mint and delete share one request chain (at most one control
 * request outstanding).
 */
export class Keyring {
  private readonly entries = new Map<string, KeyringEntry>()
  private readonly inflight = new Map<string, Promise<KeyringEntry>>()
  /**
   * Mints that timed out client-side: a late reply with this name+role is adopted for that
   * user. Bounded (LATE_MINT_CAP) and short-lived (2× the mint timeout); names repeat, so
   * the oldest matching candidate wins and a stale one is never kept around.
   */
  private readonly lateMints: Array<{ name: string; role: PlayerRole; userId: string; at: number }> = []
  /** Users kicked since the last mint for them: a late mint for them is deleted, not adopted. */
  private readonly kicked = new Set<string>()
  private pending: Pending | undefined
  private chain: Promise<void> = Promise.resolve()
  private seq = 0
  private writeChain: Promise<void> = Promise.resolve()
  private readonly unsubscribe: () => void

  constructor(
    private readonly options: {
      path: string
      groupId: string
      control: ControlLink
      admins: () => readonly string[]
      keeperKey?: string
      setTimeoutFn?: typeof setTimeout
      clearTimeoutFn?: typeof clearTimeout
      mintTimeoutMs?: number
    },
  ) {
    this.unsubscribe = options.control.onMessage((frame) => this.onControl(frame))
  }

  static async load(options: ConstructorParameters<typeof Keyring>[0]): Promise<Keyring> {
    const ring = new Keyring(options)
    const parsed = await readPrivateJson(options.path)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ring
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue
      const rec = value as Record<string, unknown>
      const key = typeof rec.key === "string" ? rec.key : ""
      const key_id = typeof rec.key_id === "string" ? rec.key_id : ""
      const role = rec.role === "keeper" ? "keeper" : rec.role === "player" ? "player" : ""
      if (!userId || !key || !key_id || !role) continue
      if (options.keeperKey && key === options.keeperKey) continue
      const name = typeof rec.name === "string" && rec.name ? rec.name : undefined
      ring.entries.set(userId, { key, key_id, role, ...(name ? { name } : {}) })
    }
    return ring
  }

  get(userId: string): KeyringEntry | undefined {
    return this.entries.get(userId)
  }

  isObserver(userId: string): boolean {
    return userId === observerUserId(this.options.groupId)
  }

  list(): Array<{ userId: string } & KeyringEntry> {
    return [...this.entries.entries()]
      .filter(([userId]) => !this.isObserver(userId))
      .map(([userId, entry]) => ({ userId, ...entry }))
  }

  isAdmin(userId: string): boolean {
    return this.options.admins().map(String).includes(String(userId))
  }

  roleFor(userId: string): PlayerRole {
    if (this.isObserver(userId)) return "player"
    return this.isAdmin(userId) ? "keeper" : "player"
  }

  isKeeperKey(key: string): boolean {
    return Boolean(this.options.keeperKey && key === this.options.keeperKey)
  }

  /**
   * The entry for this QQ id, minting one on first sight. `displayName` (group card,
   * else nickname) becomes the key name at mint time; an existing entry keeps the name
   * it was minted with — a later card change does not re-mint.
   */
  async ensure(userId: string, displayName?: string): Promise<KeyringEntry> {
    this.kicked.delete(userId) // speaking again after a kick is a legitimate new seat
    const existing = this.entries.get(userId)
    const want = this.roleFor(userId)
    if (existing && existing.role === want && !this.isKeeperKey(existing.key)) return existing
    const inflight = this.inflight.get(userId)
    if (inflight) return inflight
    const pending = this.ensureFresh(userId, want, existing, this.keyName(userId, displayName))
    this.inflight.set(userId, pending)
    try {
      return await pending
    } finally {
      if (this.inflight.get(userId) === pending) this.inflight.delete(userId)
    }
  }

  async ensureObserver(): Promise<KeyringEntry> {
    return this.ensure(observerUserId(this.options.groupId))
  }

  async kick(userId: string): Promise<KeyringEntry> {
    if (this.isObserver(userId)) throw new ObserverProtectedError()
    const entry = this.entries.get(userId)
    if (!entry) throw new Error(`no keyring entry for ${userId}`)
    await this.enqueueDelete(entry.key_id)
    this.entries.delete(userId)
    // A mint for this user still in flight server-side must not revive the seat: its late
    // reply is attributed through lateMints and then DELETED (see adoptOrphanMint).
    this.kicked.add(userId)
    await this.flush()
    return entry
  }

  close(): void {
    this.unsubscribe()
    if (this.pending) {
      ;(this.options.clearTimeoutFn ?? clearTimeout)(this.pending.timer)
      this.pending.reject(new Error("keyring closed"))
      this.pending = undefined
    }
  }

  /** Wait for the persist chain. Shutdown flushes through this. */
  async drainWrites(): Promise<void> {
    await this.writeChain
  }

  private userIdFromName(name: string): string | undefined {
    if (name === observerName(this.options.groupId)) return observerUserId(this.options.groupId)
    if (name.startsWith("qq:") && !name.startsWith("qq:observer:")) return name.slice(3) || undefined
    return undefined
  }

  private keyName(userId: string, displayName?: string): string {
    if (this.isObserver(userId)) return observerName(this.options.groupId)
    const wanted = keyNameFromDisplay(displayName)
    // A card that would wear another seat's name, the observer's, or the `qq:` fallback
    // shape is not a name this seat may take: fall back to the id form.
    if (!wanted || wanted.startsWith("qq:") || this.nameTaken(wanted, userId)) return memberName(userId)
    return wanted
  }

  private nameTaken(name: string, userId: string): boolean {
    if (name === observerName(this.options.groupId)) return true
    for (const [otherId, entry] of this.entries) {
      if (otherId !== userId && entry.name === name) return true
    }
    return false
  }

  private async ensureFresh(
    userId: string,
    role: PlayerRole,
    existing: KeyringEntry | undefined,
    name: string,
  ): Promise<KeyringEntry> {
    const minted = await this.enqueueMint(name, role, userId)
    this.entries.set(userId, minted)
    await this.flush()
    if (existing && existing.key_id !== minted.key_id) {
      try {
        await this.enqueueDelete(existing.key_id)
      } catch (error) {
        if (error instanceof LastKeeperError) {
          this.entries.set(userId, existing)
          await this.flush()
          void this.enqueueDelete(minted.key_id).catch(() => {})
          throw error
        }
        throw error
      }
    }
    return minted
  }

  private enqueueMint(name: string, role: PlayerRole, userId: string): Promise<KeyringEntry> {
    return this.enqueue((seq) => new Promise<KeyringEntry>((resolve, reject) => {
      const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
      const timer = setTimeoutFn(() => {
        if (this.pending?.seq === seq) {
          this.pending = undefined
          // The server may still answer: remember who this mint was for so the late
          // reply is adopted instead of orphaned (names no longer encode the QQ id).
          this.pruneLateMints()
          this.lateMints.push({ name, role, userId, at: Date.now() })
          while (this.lateMints.length > LATE_MINT_CAP) this.lateMints.shift()
          reject(new Error("admin_mint_key timed out"))
        }
      }, this.options.mintTimeoutMs ?? MINT_TIMEOUT_MS)
      this.pending = { kind: "mint", seq, name, role, resolve, reject, timer }
      this.options.control.send({
        type: FrameType.AdminMintKey,
        name,
        role,
        purpose: "join",
      })
    }))
  }

  private enqueueDelete(id: string): Promise<AdminKeysFrame> {
    return this.enqueue((seq) => new Promise<AdminKeysFrame>((resolve, reject) => {
      const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
      const timer = setTimeoutFn(() => {
        if (this.pending?.seq === seq) {
          this.pending = undefined
          reject(new Error("admin_delete_key timed out"))
        }
      }, this.options.mintTimeoutMs ?? MINT_TIMEOUT_MS)
      this.pending = { kind: "delete", seq, id, resolve, reject, timer }
      this.options.control.send({ type: FrameType.AdminDeleteKey, id })
    }))
  }

  private enqueue<T>(run: (seq: number) => Promise<T>): Promise<T> {
    const result = this.chain.then(() => {
      const seq = ++this.seq
      return run(seq)
    })
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private onControl(frame: ServerFrame): void {
    const pending = this.pending
    if (!pending) {
      if (isAdminKeys(frame) && frame.minted) this.adoptOrphanMint(frame)
      return
    }
    if (isAdminError(frame)) {
      this.clearPending()
      if (frame.code === "last_keeper") pending.reject(new LastKeeperError(frame.message || "last_keeper"))
      else pending.reject(new Error(frame.message || frame.code))
      return
    }
    if (!isAdminKeys(frame)) return
    if (pending.kind === "mint") {
      if (!frame.minted) return
      if (frame.minted.name !== pending.name || frame.minted.role !== pending.role) return
      if (this.isKeeperKey(frame.minted.key)) {
        this.clearPending()
        pending.reject(new Error("minted key collided with the bridge keeper key"))
        return
      }
      const entry = this.entryFromMinted(frame)
      if (!entry) return
      this.clearPending()
      pending.resolve(entry)
      return
    }
    if (frame.keys.some((row) => row.id === pending.id)) return
    this.clearPending()
    pending.resolve(frame)
  }

  private entryFromMinted(frame: AdminKeysFrame): KeyringEntry | undefined {
    if (!frame.minted) return undefined
    if (this.isKeeperKey(frame.minted.key)) return undefined
    // The server's key id IS sha256(key)[:16] (`net/admin.py _key_id`); a lookup by name
    // would pick another player's row when two players share a group card.
    return {
      key: frame.minted.key,
      key_id: keyIdFromSecret(frame.minted.key),
      role: frame.minted.role,
      name: frame.minted.name,
    }
  }

  private pruneLateMints(): void {
    const ttl = 2 * (this.options.mintTimeoutMs ?? MINT_TIMEOUT_MS)
    const cutoff = Date.now() - ttl
    for (let i = this.lateMints.length - 1; i >= 0; i -= 1) {
      if (this.lateMints[i]!.at < cutoff) this.lateMints.splice(i, 1)
    }
  }

  /**
   * A late mint with no pending request is adopted if that user has no entry yet. A late
   * mint for a user kicked meanwhile is a live key nobody owns: delete it instead.
   */
  private adoptOrphanMint(frame: AdminKeysFrame): void {
    if (!frame.minted) return
    this.pruneLateMints()
    const late = this.lateMints.findIndex((row) => row.name === frame.minted!.name && row.role === frame.minted!.role)
    let userId: string | undefined
    if (late >= 0) userId = this.lateMints.splice(late, 1)[0]!.userId
    else userId = this.userIdFromName(frame.minted.name)
    if (!userId) return
    if (this.kicked.has(userId)) {
      if (!this.isKeeperKey(frame.minted.key)) void this.enqueueDelete(keyIdFromSecret(frame.minted.key)).catch(() => {})
      return
    }
    if (this.entries.has(userId)) return
    const entry = this.entryFromMinted(frame)
    if (!entry) return
    this.entries.set(userId, entry)
    void this.flush()
  }

  private clearPending(): void {
    if (!this.pending) return
    ;(this.options.clearTimeoutFn ?? clearTimeout)(this.pending.timer)
    this.pending = undefined
  }

  private flush(): Promise<void> {
    const body = JSON.stringify(Object.fromEntries(this.entries))
    this.writeChain = this.writeChain.then(() => writePrivateAtomic(this.options.path, body)).catch(() => {})
    return this.writeChain
  }
}
