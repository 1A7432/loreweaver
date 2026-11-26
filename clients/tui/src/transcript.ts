/** Exporting the whole session log to a plain-text file.
 *
 * The companion to `copy.ts`: a selection copy is for one line or paragraph,
 * this is for "give me the whole session". It also covers the terminals that
 * refuse OSC 52 — a file always works — and it is the only way to get at log
 * lines that have already scrolled out of the `<scrollbox>` viewport.
 *
 * Rendering shares `logText.ts` with `components/NarrativeLog.tsx` (same speaker
 * labels, same dice line, same block lines) so the file reads like what the player
 * saw — the room's events and this player's own local lines, in order. Drafts still
 * streaming are left out. Markdown is written through UNRENDERED: the raw `**bold**`
 * source is the faithful, re-pasteable thing to keep.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stripControlChars } from "loreweaver-protocol/v3"
import { itemBlocks, type LogItem } from "./log"
import { blockLines, diceText, localText, markerText, speakerLabel } from "./logText"
import { defaultLoreweaverHome, type EnvLike } from "./localPaths"

/** Directory transcripts land in: `~/.loreweaver/transcripts` (honours `TRPG_HOME`). */
export function resolveTranscriptDir(env: EnvLike = process.env): string {
  return join(defaultLoreweaverHome(env), "transcripts")
}

function two(value: number): string {
  return String(value).padStart(2, "0")
}

/** `YYYYMMDD-HHMMSS` in local time — sorts chronologically and reads as a wall clock. */
export function transcriptStamp(at: Date): string {
  return (
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  )
}

/** Reduce a room name to a safe filename fragment.
 *
 * The room name is server-supplied and free-form (spaces, CJK, and `/` or `..`
 * are all possible), so only an explicit safe set survives; anything else — a
 * fully-CJK name included — collapses away and falls back to `room`. That keeps
 * the write confined to `resolveTranscriptDir()` by construction.
 */
export function slugifyRoom(room: string | undefined): string {
  const slug = (room ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40)
  return slug || "room"
}

export function transcriptFileName(at: Date, room?: string): string {
  return `${slugifyRoom(room)}-${transcriptStamp(at)}.txt`
}

/** One log item as plain text, or `undefined` for what carries no transcript value (a
 * draft still being written, a live spinner). */
export function transcriptLine(item: LogItem, locale?: string): string | undefined {
  if (item.kind === "draft") return undefined
  if (item.kind === "local") return item.line.spinner ? undefined : localText(item.line, locale)
  const event = item.event
  if (event.kind === "narrative") return stripControlChars(`${speakerLabel(event.data, locale)}: ${event.data.text}`)
  if (event.kind === "dice") return diceText(event.data)
  if (event.kind === "blocks") return blockLines(itemBlocks(item)?.blocks ?? [], locale).join("\n")
  return markerText(event, locale) ?? undefined
}

export interface TranscriptOptions {
  room?: string
  at: Date
  locale?: string
}

/** The full file body: a short provenance header, then one block per log item. */
export function itemsToTranscript(items: readonly LogItem[], options: TranscriptOptions): string {
  const header = [
    "# Loreweaver transcript",
    `# room: ${stripControlChars(options.room ?? "")}`,
    `# saved: ${options.at.toISOString()}`,
    "",
  ]
  const body = items.map((item) => transcriptLine(item, options.locale)).filter((line): line is string => line !== undefined)
  return `${[...header, ...body].join("\n")}\n`
}

/** Write the transcript and return the absolute path written. */
export async function writeTranscript(
  items: readonly LogItem[],
  options: TranscriptOptions & { env?: EnvLike; dir?: string },
): Promise<string> {
  const dir = options.dir ?? resolveTranscriptDir(options.env ?? process.env)
  await mkdir(dir, { recursive: true })
  const path = join(dir, transcriptFileName(options.at, options.room))
  await writeFile(path, itemsToTranscript(items, options), "utf8")
  return path
}
