import { stripControlChars } from "loreweaver-protocol"
import { BRIDGE_TEXT_LIMIT } from "./uiText"

/** A GFM table row (`| a | b |`) → `a · b`; the `|---|---|` rule row → nothing. */
function tableRowsToLines(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const row = line.trim()
      if (!/^\|.*\|$/.test(row)) return [line]
      const cells = row.slice(1, -1).split("|").map((cell) => cell.trim())
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return []
      return [cells.join(" · ")]
    })
    .join("\n")
}

/** Markdown → plain for group chat (raw asterisks otherwise). Strips emphasis and
 * code fences, turns headings into their text and table rows into `a · b` lines,
 * keeps list markers and blank lines. */
export function markdownToPlain(source: string): string {
  let text = source.replace(/\r\n/g, "\n")
  text = text.replace(/^ {0,3}(```|~~~)[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm, "$2")
  text = tableRowsToLines(text)
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  text = text.replace(/`([^`]+)`/g, "$1")
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1")
  text = text.replace(/__([^_]+)__/g, "$1")
  text = text.replace(/\*([^*]+)\*/g, "$1")
  text = text.replace(/(^|[^A-Za-z0-9_])_([^_]+)_/g, "$1$2")
  text = text.replace(/~~([^~]+)~~/g, "$1")
  return stripControlChars(text)
}

export function renderNarrativeText(text: string, format: "markdown" | "plain"): string {
  return format === "markdown" ? markdownToPlain(text) : stripControlChars(text)
}

/**
 * Split on paragraph boundaries at `limit` without loss. Prefer `\n\n`, then `\n`,
 * then a space, then a hard cut — never mid-grapheme drop, never omit a suffix.
 * Port of `gateway.chat.split_text`.
 */
function rfind(haystack: string, needle: string, start: number, end: number): number {
  const idx = haystack.slice(start, end).lastIndexOf(needle)
  return idx < 0 ? -1 : start + idx
}

/** Never split a UTF-16 surrogate pair. Prefer backing up one unit; if that would
 * yield an empty chunk, include the full pair (one unit over the limit). */
function avoidSurrogateSplit(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  const prev = text.charCodeAt(cut - 1)
  const next = text.charCodeAt(cut)
  const pair = prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  if (!pair) return cut
  if (cut > 1) return cut - 1
  return Math.min(text.length, cut + 1)
}

export function splitText(text: string, limit = BRIDGE_TEXT_LIMIT): string[] {
  if (!text) return [""]
  if (limit < 1) throw new Error("text limit must be positive")
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1)
    const boundaryFloor = Math.max(1, Math.floor(limit / 2))
    let cut = rfind(window, "\n\n", boundaryFloor, limit)
    let separator = 2
    if (cut < 1) {
      cut = rfind(window, "\n", boundaryFloor, limit)
      separator = 1
    }
    if (cut < 1) {
      cut = rfind(window, " ", boundaryFloor, limit)
      separator = 1
    }
    if (cut < 1) {
      cut = limit
      separator = 0
    } else {
      cut += separator
    }
    cut = avoidSurrogateSplit(remaining, cut)
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function renderNarrativeNpc(name: string | undefined, text: string, format: "markdown" | "plain"): string {
  const who = stripControlChars(name || "").trim()
  const body = renderNarrativeText(text, format)
  return who ? `${who}: ${body}` : body
}
