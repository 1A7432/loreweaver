import type { UiChoicesBlock } from "loreweaver-protocol"
import { readPrivateJson, writePrivateAtomic } from "../persist"
import type { FrameScope } from "../router"
import type { BridgeMediaRef } from "../render/uiText"

export const DEFERRED_CAP = 50
export const DEFERRED_TTL_MS = 24 * 60 * 60 * 1000
export const PLAYER_HOLD_TTL_MS = 24 * 60 * 60 * 1000
export const LATE_FLUSH_MAX = 2
export const DROPPED_NOTICE_EVERY_MS = 60 * 60 * 1000
export const PRIVATE_HELD_EVERY_MS = 10 * 60 * 1000

export interface DeferredMedia {
  hash: string
  mime?: string
  name?: string
}

export interface DeferredItem {
  id: string
  scope: FrameScope
  target: string
  seat?: string
  text: string
  media: DeferredMedia[]
  createdAt: number
  choices?: UiChoicesBlock
  /** Prefix `lateDelivery` when flushing onto a later group anchor. */
  late: boolean
  pendingReview?: boolean
  /** `narrativeGeneration` at queue time; later KP narration expires choices. */
  queuedGeneration?: number
}

export interface DeferredState {
  items: DeferredItem[]
  playerHolds: Record<string, DeferredItem[]>
  privateOutboxes: Record<string, DeferredItem[]>
  lastPrivateHeldAt?: number
  lastDeferredDroppedAt?: number
}

export function deferredPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.deferred.json`
}

export function mediaFromRef(ref: BridgeMediaRef): DeferredMedia {
  return { hash: ref.hash, ...(ref.mime ? { mime: ref.mime } : {}), ...(ref.name ? { name: ref.name } : {}) }
}

let seq = 0
export function nextDeferredId(now: number): string {
  seq += 1
  return `d-${now}-${seq}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseMedia(raw: unknown): DeferredMedia[] {
  if (!Array.isArray(raw)) return []
  const out: DeferredMedia[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const hash = rec ? asString(rec.hash) : undefined
    if (!hash) continue
    // Never persist or restore a platform file_info — re-upload at flush.
    if (rec && "file_info" in rec) {
      const { hash: h, mime, name } = rec
      out.push({
        hash: String(h),
        ...(typeof mime === "string" ? { mime } : {}),
        ...(typeof name === "string" ? { name } : {}),
      })
      continue
    }
    out.push({
      hash,
      ...(typeof rec?.mime === "string" ? { mime: rec.mime } : {}),
      ...(typeof rec?.name === "string" ? { name: rec.name } : {}),
    })
  }
  return out
}

function parseChoices(raw: unknown): UiChoicesBlock | undefined {
  const rec = asRecord(raw)
  if (!rec || rec.kind !== "choices" || !Array.isArray(rec.options)) return undefined
  const options = rec.options
    .map((item) => {
      const opt = asRecord(item)
      if (!opt) return undefined
      const id = asString(opt.id)
      const label = asString(opt.label)
      const input = asString(opt.input)
      if (!id || !label || !input) return undefined
      return { id, label, input }
    })
    .filter((item): item is { id: string; label: string; input: string } => Boolean(item))
  if (!options.length) return undefined
  const prompt = asString(rec.prompt)
  return { kind: "choices", ...(prompt ? { prompt } : {}), options }
}

function parseItem(raw: unknown): DeferredItem | undefined {
  const rec = asRecord(raw)
  if (!rec) return undefined
  const id = asString(rec.id)
  const scope = rec.scope === "group" || rec.scope === "player" || rec.scope === "admin" ? rec.scope : undefined
  const target = asString(rec.target)
  const createdAt = asNumber(rec.createdAt)
  if (!id || !scope || target === undefined || createdAt === undefined) return undefined
  const text = asString(rec.text) ?? ""
  const seat = asString(rec.seat)
  return {
    id,
    scope,
    target,
    ...(seat ? { seat } : {}),
    text,
    media: parseMedia(rec.media),
    createdAt,
    choices: parseChoices(rec.choices),
    late: rec.late !== false,
    pendingReview: rec.pendingReview === true,
    queuedGeneration: asNumber(rec.queuedGeneration),
  }
}

function parseList(raw: unknown): DeferredItem[] {
  if (!Array.isArray(raw)) return []
  const out: DeferredItem[] = []
  for (const item of raw) {
    const parsed = parseItem(item)
    if (parsed) out.push(parsed)
  }
  return out
}

function parseHolds(raw: unknown): Record<string, DeferredItem[]> {
  const rec = asRecord(raw)
  const out: Record<string, DeferredItem[]> = {}
  if (!rec) return out
  for (const [key, value] of Object.entries(rec)) out[key] = parseList(value)
  return out
}

export type DropResult = { dropped: DeferredItem; notice: boolean } | undefined

export class DeferredStore {
  items: DeferredItem[] = []
  playerHolds: Record<string, DeferredItem[]> = {}
  privateOutboxes: Record<string, DeferredItem[]> = {}
  lastPrivateHeldAt: number | undefined
  lastDeferredDroppedAt: number | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(
    private readonly path: string,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now
  }

  static async load(path: string, opts: { now?: () => number } = {}): Promise<DeferredStore> {
    const store = new DeferredStore(path, opts)
    const rec = asRecord(await readPrivateJson(path))
    if (rec) {
      store.items = parseList(rec.items)
      store.playerHolds = parseHolds(rec.playerHolds)
      store.privateOutboxes = parseHolds(rec.privateOutboxes)
      store.lastPrivateHeldAt = asNumber(rec.lastPrivateHeldAt)
      store.lastDeferredDroppedAt = asNumber(rec.lastDeferredDroppedAt)
    }
    store.expire(store.now())
    return store
  }

  get length(): number {
    return this.items.length
  }

  expire(now = this.now()): { group: number; player: number } {
    const keep = (item: DeferredItem, ttl: number) => now - item.createdAt < ttl
    const before = this.items.length
    this.items = this.items.filter((item) => keep(item, DEFERRED_TTL_MS))
    let playerDropped = 0
    for (const [seat, list] of Object.entries(this.playerHolds)) {
      const next = list.filter((item) => keep(item, PLAYER_HOLD_TTL_MS))
      playerDropped += list.length - next.length
      if (next.length) this.playerHolds[seat] = next
      else delete this.playerHolds[seat]
    }
    return { group: before - this.items.length, player: playerDropped }
  }

  /**
   * Push a group-scope item. Cap 50 / 24 h: drop the oldest and optionally
   * emit `deferredDropped` at most once per hour.
   */
  pushGroup(item: DeferredItem, now = this.now()): DropResult {
    this.expire(now)
    this.items.push(item)
    if (this.items.length <= DEFERRED_CAP) return undefined
    const dropped = this.items.shift()
    if (!dropped) return undefined
    const notice = this.lastDeferredDroppedAt === undefined || now - this.lastDeferredDroppedAt >= DROPPED_NOTICE_EVERY_MS
    if (notice) this.lastDeferredDroppedAt = now
    return { dropped, notice }
  }

  takeLate(max = LATE_FLUSH_MAX, now = this.now()): DeferredItem[] {
    this.expire(now)
    const taken: DeferredItem[] = []
    while (taken.length < max && this.items.length) {
      const next = this.items.shift()
      if (next) taken.push(next)
    }
    return taken
  }

  pushPlayerHold(seat: string, item: DeferredItem): void {
    const list = this.playerHolds[seat] ?? []
    list.push({ ...item, late: false, seat })
    this.playerHolds[seat] = list
  }

  takePlayerHolds(seat: string, now = this.now()): DeferredItem[] {
    this.expire(now)
    const list = this.playerHolds[seat] ?? []
    delete this.playerHolds[seat]
    return list
  }

  pushPrivate(userOpenid: string, item: DeferredItem): void {
    const list = this.privateOutboxes[userOpenid] ?? []
    list.push({ ...item, late: false, target: userOpenid })
    this.privateOutboxes[userOpenid] = list
  }

  takePrivate(userOpenid: string, max: number): DeferredItem[] {
    const list = this.privateOutboxes[userOpenid] ?? []
    const taken = list.splice(0, Math.max(0, max))
    if (list.length) this.privateOutboxes[userOpenid] = list
    else delete this.privateOutboxes[userOpenid]
    return taken
  }

  privateCount(userOpenid: string): number {
    return this.privateOutboxes[userOpenid]?.length ?? 0
  }

  shouldPrivateHeld(now = this.now()): boolean {
    if (this.lastPrivateHeldAt === undefined) return true
    return now - this.lastPrivateHeldAt >= PRIVATE_HELD_EVERY_MS
  }

  markPrivateHeld(now = this.now()): void {
    this.lastPrivateHeldAt = now
  }

  snapshot(): DeferredState {
    return {
      items: this.items.map((item) => ({ ...item, media: item.media.map((m) => ({ ...m })) })),
      playerHolds: Object.fromEntries(
        Object.entries(this.playerHolds).map(([k, v]) => [k, v.map((item) => ({ ...item, media: item.media.map((m) => ({ ...m })) }))]),
      ),
      privateOutboxes: Object.fromEntries(
        Object.entries(this.privateOutboxes).map(([k, v]) => [k, v.map((item) => ({ ...item, media: item.media.map((m) => ({ ...m })) }))]),
      ),
      lastPrivateHeldAt: this.lastPrivateHeldAt,
      lastDeferredDroppedAt: this.lastDeferredDroppedAt,
    }
  }

  flush(): Promise<void> {
    const body = JSON.stringify(this.snapshot())
    this.writeChain = this.writeChain.then(() => writePrivateAtomic(this.path, body)).catch(() => {})
    return this.writeChain
  }
}
