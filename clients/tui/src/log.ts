// What the narrative log shows, derived — never stored — from the session snapshot and the
// connection's local lines: the room's events in order, this person's local lines placed after
// the event they followed, and the drafts being streamed after everything else.
import type { BlocksData, Draft, EventFrame } from "loreweaver-protocol/v3"
import type { LocalLine } from "./connection"

export type LogItem =
  | { readonly kind: "event"; readonly key: string; readonly event: EventFrame; readonly blocks?: BlocksData }
  | { readonly kind: "local"; readonly key: string; readonly line: LocalLine }
  | { readonly kind: "draft"; readonly key: string; readonly draft: Draft }

/** What Ctrl+L hid: events up to `seq` and local lines up to `lineId`. */
export interface Cleared {
  readonly seq: number
  readonly lineId: number
}

/**
 * A `blocks` event with `replace` updates the earlier `blocks` event with the same id in place:
 * the earlier one is drawn with the newest content, the replacement itself is not drawn again.
 */
function blockReplacements(events: readonly EventFrame[]): { shown: Map<number, BlocksData>; skipped: Set<number> } {
  const first = new Map<string, number>()
  const shown = new Map<number, BlocksData>()
  const skipped = new Set<number>()
  for (const event of events) {
    if (event.kind !== "blocks") continue
    const earlier = first.get(event.id)
    if (earlier !== undefined && event.data.replace === true) {
      shown.set(earlier, event.data)
      skipped.add(event.seq)
    } else if (earlier === undefined) {
      first.set(event.id, event.seq)
    }
  }
  return { shown, skipped }
}

export function logItems(
  events: readonly EventFrame[],
  drafts: readonly Draft[],
  lines: readonly LocalLine[],
  cleared: Cleared | null = null,
): LogItem[] {
  const { shown, skipped } = blockReplacements(events)
  const visibleEvents = events.filter((event) => !skipped.has(event.seq) && (cleared === null || event.seq > cleared.seq))
  const visibleLines = lines.filter((line) => cleared === null || line.id > cleared.lineId)
  const items: LogItem[] = []
  let next = 0
  for (const event of visibleEvents) {
    while (next < visibleLines.length && (visibleLines[next] as LocalLine).after < event.seq) {
      const line = visibleLines[next] as LocalLine
      items.push({ kind: "local", key: `l${line.id}`, line })
      next += 1
    }
    const replaced = event.kind === "blocks" ? shown.get(event.seq) : undefined
    items.push(replaced ? { kind: "event", key: `e${event.seq}`, event, blocks: replaced } : { kind: "event", key: `e${event.seq}`, event })
  }
  for (; next < visibleLines.length; next += 1) {
    const line = visibleLines[next] as LocalLine
    items.push({ kind: "local", key: `l${line.id}`, line })
  }
  for (const draft of drafts) items.push({ kind: "draft", key: `d${draft.id}`, draft })
  return items
}

/** The blocks an item draws: the replacement's when one updated it in place. */
export function itemBlocks(item: Extract<LogItem, { kind: "event" }>): BlocksData | null {
  if (item.blocks) return item.blocks
  return item.event.kind === "blocks" ? item.event.data : null
}

/** The index of the last item that carries a `choices` block: the one live select. */
export function lastChoicesIndex(items: readonly LogItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as LogItem
    if (item.kind !== "event") continue
    const blocks = itemBlocks(item)
    if (blocks?.blocks.some((block) => block.kind === "choices")) return index
  }
  return -1
}
