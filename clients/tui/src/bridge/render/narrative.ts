import { stripControlChars } from "loreweaver-protocol"
import { BRIDGE_TEXT_LIMIT } from "./uiText"

/** Markdown → plain for group chat (raw asterisks otherwise). Strips emphasis and
 * code fences, turns headings into their text, keeps list markers and blank lines. */
export function markdownToPlain(source: string): string {
  let text = source.replace(/\r\n/g, "\n")
  text = text.replace(/^ {0,3}(```|~~~)[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm, "$2")
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
