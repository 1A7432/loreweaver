/** Exporting the whole session log to a plain-text file.
 *
 * The companion to `copy.ts`: a selection copy is for one line or paragraph,
 * this is for "give me the whole session". It also covers the terminals that
 * refuse OSC 52 — a file always works — and it is the only way to get at log
 * lines that have already scrolled out of the `<scrollbox>` viewport.
 *
 * Rendering deliberately mirrors `components/NarrativeLog.tsx` (same speaker
 * labels, same dice line, same media placeholders) so the file reads like what
 * the player saw. Markdown is written through UNRENDERED: the raw `**bold**`
 * source is the faithful, re-pasteable thing to keep.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stripControlChars } from "loreweaver-protocol"
import type { LogFrame } from "./components/NarrativeLog"
import { badgeLine, meterLine, statLine } from "./components/UiBlocks"
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

function speakerLabel(frame: Extract<LogFrame, { type: "narrative" }>): string {
  if (frame.speaker === "kp") return "KP"
  if (frame.speaker === "npc") return frame.name ? `[${stripControlChars(frame.name)}]` : "[NPC]"
  if (frame.name) return stripControlChars(frame.name)
  return stripControlChars(frame.speaker.toUpperCase())
}

/** One frame as plain text, or `undefined` for frames that carry no transcript
 * value (a live spinner is UI state, not something that happened in the story). */
export function transcriptLine(frame: LogFrame): string | undefined {
  if (frame.type === "dice") {
    const target = typeof frame.target === "number" ? ` vs ${frame.target}` : ""
    const hasOutcome = typeof frame.level === "string" || typeof frame.success === "boolean"
    const level = frame.level ?? (frame.success ? "SUCCESS" : "FAIL")
    const outcome = hasOutcome ? ` -> ${level}` : ""
    return stripControlChars(`⚄ ${frame.actor} ${frame.expr} ${frame.total}${target}${outcome}`)
  }
  if (frame.type === "system") {
    if (frame.spinner) return undefined
    return stripControlChars(`[${frame.level.toUpperCase()}] ${frame.text}`)
  }
  if (frame.type === "media") {
    return stripControlChars(`[image] ${frame.from}: ${frame.name}`)
  }
  if (frame.type === "audio_library_item") {
    return stripControlChars(`[AUDIO] ${frame.from}: ${frame.title || frame.name}`)
  }
  if (frame.type === "audio_control") {
    const label = frame.title || frame.name || frame.hash || frame.layer
    return stripControlChars(`[${frame.layer.toUpperCase()}] ${frame.action}${label ? ` · ${label}` : ""}`)
  }
  if (frame.type === "ui") {
    // Inline v1.7 hook UI, one plain-text line per block via the same formatters
    // NarrativeLog renders with; a choices block keeps prompt + option labels
    // (the machine `input` payloads are UI plumbing, not story).
    const lines = frame.blocks.map((block) => {
      if (block.kind === "divider") return "─".repeat(24)
      if (block.kind === "meter") return meterLine(block, 10)
      if (block.kind === "stat") return statLine(block)
      if (block.kind === "badge") return badgeLine(block)
      if (block.kind === "text") return stripControlChars(block.text)
      return [
        block.prompt ? stripControlChars(block.prompt) : undefined,
        ...block.options.map((option) => `▫ ${stripControlChars(option.label)}`),
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    })
    return lines.join("\n")
  }
  return stripControlChars(`${speakerLabel(frame)}: ${frame.text}`)
}

export interface TranscriptOptions {
  room?: string
  at: Date
}

/** The full file body: a short provenance header, then one block per frame. */
export function framesToTranscript(frames: LogFrame[], options: TranscriptOptions): string {
  const header = [
    "# Loreweaver transcript",
    `# room: ${stripControlChars(options.room ?? "")}`,
    `# saved: ${options.at.toISOString()}`,
    "",
  ]
  const body = frames.map(transcriptLine).filter((line): line is string => line !== undefined)
  return `${[...header, ...body].join("\n")}\n`
}

/** Write the transcript and return the absolute path written. */
export async function writeTranscript(
  frames: LogFrame[],
  options: TranscriptOptions & { env?: EnvLike; dir?: string },
): Promise<string> {
  const dir = options.dir ?? resolveTranscriptDir(options.env ?? process.env)
  await mkdir(dir, { recursive: true })
  const path = join(dir, transcriptFileName(options.at, options.room))
  await writeFile(path, framesToTranscript(frames, options), "utf8")
  return path
}
