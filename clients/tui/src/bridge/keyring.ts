import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  FrameType,
  type AdminErrorFrame,
  type AdminKeysFrame,
  type ClientFrame,
  type PlayerRole,
  type ServerFrame,
} from "loreweaver-protocol"

const FILE_MODE = 0o600
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
  readonly code = "last_keeper"
  constructor(message = "last_keeper") {
    super(message)
    this.name = "LastKeeperError"
  }
}

interface PendingMint {
  name: string
  resolve: (entry: KeyringEntry) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

async function writePrivate(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, { encoding: "utf8", mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

export function keyIdFromSecret(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16)
}

export function observerName(groupId: string): string {
  return `qq:observer:${groupId}`
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
 * The bridge's own keeper key is never stored here and never sent as Join —
 * the control link is the only place that key is used, for mint/list/delete.
 */
export class Keyring {
  private readonly entries = new Map<string, KeyringEntry>()
  private readonly inflight = new Map<string, Promise<KeyringEntry>>()
  private pending: PendingMint | undefined
  private mintChain: Promise<void> = Promise.resolve()
  private writeChain: Promise<void> = Promise.resolve()
  private readonly unsubscribe: () => void

  constructor(
    private readonly options: {
      path: string
      groupId: string
      control: ControlLink
      /** Live admin QQ ids — re-read so `.bridge admin add|remove` takes effect. */
      admins: () => readonly string[]
      /** Must NEVER be used as a playing-link join key. Compared in tests. */
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
    try {
      const raw = await readFile(options.path, "utf8")
      const parsed = JSON.parse(raw) as unknown
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
    }
    return ring
  }

  get(userId: string): KeyringEntry | undefined {
    return this.entries.get(userId)
  }

  list(): Array<{ userId: string } & KeyringEntry> {
    return [...this.entries.entries()].map(([userId, entry]) => ({ userId, ...entry }))
  }

  isAdmin(userId: string): boolean {
    return this.options.admins().map(String).includes(String(userId))
  }

  roleFor(userId: string): PlayerRole {
    return this.isAdmin(userId) ? "keeper" : "player"
  }

  /** True if this secret is the bridge's own keeper key (never a playing join). */
  isKeeperKey(key: string): boolean {
    return Boolean(this.options.keeperKey && key === this.options.keeperKey)
  }

  async ensure(userId: string, displayName?: string): Promise<KeyringEntry> {
    const existing = this.entries.get(userId)
    const want = this.roleFor(userId)
    if (existing && existing.role === want && !this.isKeeperKey(existing.key)) return existing
    const inflight = this.inflight.get(userId)
    if (inflight) return inflight
    const pending = this.mint(userId, displayName, want)
    this.inflight.set(userId, pending)
    try {
      return await pending
    } finally {
      if (this.inflight.get(userId) === pending) this.inflight.delete(userId)
    }
  }

  async ensureObserver(): Promise<KeyringEntry> {
    return this.ensure(`observer:${this.options.groupId}`, observerName(this.options.groupId))
  }

  /**
   * Delete the user's minted key via `admin_delete_key`. A `last_keeper` refusal
   * is surfaced (never worked around): the entry stays, the caller must NOT
   * close the link as if the kick succeeded.
   */
  async kick(userId: string): Promise<KeyringEntry> {
    const entry = this.entries.get(userId)
    if (!entry) throw new Error(`no keyring entry for ${userId}`)
    const reply = await this.requestDelete(entry.key_id)
    if (isAdminError(reply)) {
      const code = String(reply.code)
      if (code === "last_keeper") throw new LastKeeperError(reply.message || "last_keeper")
      throw new Error(reply.message || code)
    }
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

  private mint(userId: string, displayName: string | undefined, role: PlayerRole): Promise<KeyringEntry> {
    const name = displayName?.trim() || (userId.startsWith("observer:") ? observerName(this.options.groupId) : memberName(userId))
    const job = () =>
      new Promise<KeyringEntry>((resolve, reject) => {
        const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
        const timer = setTimeoutFn(() => {
          if (this.pending?.name === name) {
            this.pending = undefined
            reject(new Error("admin_mint_key timed out"))
          }
        }, this.options.mintTimeoutMs ?? MINT_TIMEOUT_MS)
        this.pending = {
          name,
          resolve: (entry) => {
            this.entries.set(userId, entry)
            void this.flush()
            resolve(entry)
          },
          reject,
          timer,
        }
        this.options.control.send({
          type: FrameType.AdminMintKey,
          name,
          role,
          purpose: "join",
        })
      })
    const result = this.mintChain.then(job, job)
    this.mintChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private requestDelete(id: string): Promise<AdminKeysFrame | AdminErrorFrame> {
    return new Promise((resolve, reject) => {
      const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
      const clearTimeoutFn = this.options.clearTimeoutFn ?? clearTimeout
      const timer = setTimeoutFn(() => {
        off()
        reject(new Error("admin_delete_key timed out"))
      }, this.options.mintTimeoutMs ?? MINT_TIMEOUT_MS)
      const off = this.options.control.onMessage((frame) => {
        if (isAdminKeys(frame) || isAdminError(frame)) {
          clearTimeoutFn(timer)
          off()
          resolve(frame)
        }
      })
      this.options.control.send({ type: FrameType.AdminDeleteKey, id })
    })
  }

  private onControl(frame: ServerFrame): void {
    if (isAdminError(frame) && this.pending) {
      const code = String(frame.code)
      const pending = this.pending
      this.pending = undefined
      ;(this.options.clearTimeoutFn ?? clearTimeout)(pending.timer)
      if (code === "last_keeper") pending.reject(new LastKeeperError(frame.message || "last_keeper"))
      else pending.reject(new Error(frame.message || code))
      return
    }
    if (!isAdminKeys(frame) || !frame.minted || !this.pending) return
    if (frame.minted.name !== this.pending.name) return
    if (this.isKeeperKey(frame.minted.key)) {
      const pending = this.pending
      this.pending = undefined
      ;(this.options.clearTimeoutFn ?? clearTimeout)(pending.timer)
      pending.reject(new Error("minted key collided with the bridge keeper key"))
      return
    }
    const listed = frame.keys.find((row) => row.name === frame.minted!.name && row.role === frame.minted!.role)
    const entry: KeyringEntry = {
      key: frame.minted.key,
      key_id: listed?.id || keyIdFromSecret(frame.minted.key),
      role: frame.minted.role,
    }
    const pending = this.pending
    this.pending = undefined
    ;(this.options.clearTimeoutFn ?? clearTimeout)(pending.timer)
    pending.resolve(entry)
  }

  private flush(): Promise<void> {
    const body = JSON.stringify(Object.fromEntries(this.entries))
    this.writeChain = this.writeChain.then(() => writePrivate(this.options.path, body)).catch(() => {})
    return this.writeChain
  }
}
