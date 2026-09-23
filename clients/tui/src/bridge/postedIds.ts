import { createHash } from "node:crypto"
import type { DiceFrame, ServerFrame, UiFrame } from "loreweaver-protocol"
import { readPrivateJson, writePrivateAtomic } from "./persist"

const DEFAULT_CAP = 2048

export function postedPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.posted.json`
}

/**
 * Persisted set of observer-posted *narrative* ids so a restart never re-posts
 * join-replay history. Dice is NOT stored here: the observer receives each live
 * dice frame once, and the replay gate covers join replay. Capped FIFO; 0600.
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
    const parsed = await readPrivateJson(path)
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { ids?: unknown }).ids)
        ? (parsed as { ids: unknown[] }).ids
        : []
    for (const item of list) {
      if (typeof item === "string" && item) store.remember(item)
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
    this.writeChain = this.writeChain.then(() => writePrivateAtomic(this.path, body)).catch(() => {})
    return this.writeChain
  }
}

/**
 * What a posted narrative line SAID, for the observer's redial window. The engine's join
 * replay rebuilds each transcript line with a fresh `id` on every join, so after a redial
 * the id never matches the one posted live and would re-post the whole transcript into the
 * group (seen live 2026-09-23 on an engine restart). Stored in postedIds beside the id.
 */
export function narrativeContentKey(frame: { speaker: string; name?: string; text: string }): string {
  // Trimmed: the replay rebuilds a line from the stored transcript entry, stripped.
  const digest = createHash("sha256").update(`${frame.speaker}\n${frame.name ?? ""}\n${frame.text.trim()}`, "utf8").digest("hex")
  return `narrative-content:${digest.slice(0, 24)}`
}

/** Fingerprint for a dice frame (no wire `id`). Used by the admin-hold seen set, not postedIds. */
export function dicePostedId(frame: {
  actor: string
  kind: string
  expr: string
  total: number
  rolls?: number[]
}): string {
  const rolls = Array.isArray(frame.rolls) ? frame.rolls.join(",") : ""
  return `dice:${frame.actor}:${frame.kind}:${frame.expr}:${frame.total}:${rolls}`
}

export function uiContentKey(lines: string[], mediaHashes: string[] = []): string {
  const payload = `${lines.join("\n")}\n${mediaHashes.join(",")}`
  return `ui:${createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16)}`
}

/** Observer-seen / admin-hold key for a broadcast frame. */
export function observerSeenKey(frame: ServerFrame, ui?: { lines: string[]; mediaHashes: string[] }): string | undefined {
  switch (frame.type) {
    case "narrative":
      return frame.id ? `narrative:${frame.id}` : undefined
    case "dice":
      return dicePostedId(frame as DiceFrame)
    case "ui":
      if (ui) return uiContentKey(ui.lines, ui.mediaHashes)
      return uiContentKey((frame as UiFrame).blocks.map((block) => block.kind))
    case "media":
      return frame.hash ? `media:${frame.hash}` : undefined
    case "audio_library_item":
      return `audio:${frame.hash || frame.title || frame.name || ""}`
    default:
      return undefined
  }
}
