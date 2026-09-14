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

export function keyringPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.keyring.json`
}

export interface KeyringEntry {
  key: string
  key_id: string
  role: PlayerRole
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
 * QQ id → `{key, key_id, role}`. Mints on first message via the control link's
 * `admin_mint_key` (`purpose:"join"`; `role:"keeper"` for configured admins).
 * Key names are ALWAYS `qq:<userId>` / `qq:observer:<groupId>` — display names
 * are a join-time property, never stored here. Mint and delete share one
 * request chain (at most one control request outstanding).
 */
export class Keyring {
  private readonly entries = new Map<string, KeyringEntry>()
  private readonly inflight = new Map<string, Promise<KeyringEntry>>()
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
      ring.entries.set(userId, { key, key_id, role })
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

  async ensure(userId: string): Promise<KeyringEntry> {
    const existing = this.entries.get(userId)
    const want = this.roleFor(userId)
    if (existing && existing.role === want && !this.isKeeperKey(existing.key)) return existing
    const inflight = this.inflight.get(userId)
    if (inflight) return inflight
    const pending = this.ensureFresh(userId, want, existing)
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

  private keyName(userId: string): string {
    return this.isObserver(userId) ? observerName(this.options.groupId) : memberName(userId)
  }

  private async ensureFresh(userId: string, role: PlayerRole, existing: KeyringEntry | undefined): Promise<KeyringEntry> {
    const minted = await this.enqueueMint(this.keyName(userId), role)
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

  private enqueueMint(name: string, role: PlayerRole): Promise<KeyringEntry> {
    return this.enqueue((seq) => new Promise<KeyringEntry>((resolve, reject) => {
      const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
      const timer = setTimeoutFn(() => {
        if (this.pending?.seq === seq) {
          this.pending = undefined
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
    const listed = frame.keys.find((row) => row.name === frame.minted!.name && row.role === frame.minted!.role)
    return {
      key: frame.minted.key,
      key_id: listed?.id || keyIdFromSecret(frame.minted.key),
      role: frame.minted.role,
    }
  }

  /** A late mint with no pending request is adopted if that user has no entry yet. */
  private adoptOrphanMint(frame: AdminKeysFrame): void {
    if (!frame.minted) return
    const userId = this.userIdFromName(frame.minted.name)
    if (!userId || this.entries.has(userId)) return
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
