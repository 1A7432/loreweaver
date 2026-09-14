import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const DEFAULT_CAP = 2048
const FILE_MODE = 0o600

export function postedPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.posted.json`
}

async function writePrivate(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, { encoding: "utf8", mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

/**
 * Persisted set of observer-posted `narrative` / `dice` ids so a restart never
 * re-posts join-replay history. Capped FIFO; files are mode 0600.
 */
export class PostedIds {
  private readonly ids = new Set<string>()
  private readonly order: string[] = []
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly cap = DEFAULT_CAP,
  ) {}

  static async load(path: string, cap = DEFAULT_CAP): Promise<PostedIds> {
    const store = new PostedIds(path, cap)
    try {
      const raw = await readFile(path, "utf8")
      const parsed = JSON.parse(raw) as unknown
      const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { ids?: unknown }).ids) ? (parsed as { ids: unknown[] }).ids : []
      for (const item of list) {
        if (typeof item === "string" && item) store.remember(item)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
    }
    return store
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  /** In-memory add (used while hydrating). Does not persist. */
  remember(id: string): void {
    if (!id || this.ids.has(id)) return
    this.ids.add(id)
    this.order.push(id)
    while (this.order.length > this.cap) {
      const oldest = this.order.shift()
      if (oldest) this.ids.delete(oldest)
    }
  }

  add(id: string): Promise<void> {
    this.remember(id)
    return this.flush()
  }

  flush(): Promise<void> {
    const body = JSON.stringify(this.order)
    this.writeChain = this.writeChain.then(() => writePrivate(this.path, body)).catch(() => {})
    return this.writeChain
  }
}

/** Stable id for a dice frame: the wire type has no `id`, so fingerprint public fields. */
export function dicePostedId(frame: {
  id?: unknown
  actor: string
  kind: string
  expr: string
  total: number
  rolls?: number[]
}): string {
  if (typeof frame.id === "string" && frame.id) return frame.id
  const rolls = Array.isArray(frame.rolls) ? frame.rolls.join(",") : ""
  return `dice:${frame.actor}:${frame.kind}:${frame.expr}:${frame.total}:${rolls}`
}
