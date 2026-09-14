import { MAX_ATTACHMENT_BYTES, MAX_TEXT_CHARS } from "./constants"
import type { OneBotSegment } from "./events"
import { OneBotError } from "./shared"

export function textSegment(text: string): OneBotSegment {
  return { type: "text", data: { text } }
}

export function replySegment(id: string): OneBotSegment {
  return { type: "reply", data: { id } }
}

export function atSegment(qq: string | number): OneBotSegment {
  return { type: "at", data: { qq: String(qq) } }
}

export function imageSegment(input: { data: Uint8Array } | { url: string }): OneBotSegment {
  return mediaSegment("image", input)
}

export function mediaSegment(
  segmentType: "image" | "record" | "video",
  input: { data: Uint8Array } | { url: string },
): OneBotSegment {
  let file: string
  if ("data" in input) {
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new OneBotError("onebot.attachment.too_large")
    }
    file = `base64://${Buffer.from(input.data).toString("base64")}`
  } else {
    file = input.url
  }
  return { type: segmentType, data: { file } }
}

export interface OutboundContent {
  text?: string
  replyTo?: string
  at?: Array<string | number>
  image?: { data: Uint8Array; mime?: string } | { url: string; mime?: string }
}

/**
 * Reply first, then @, then text, then image. A group-to-private redirect must
 * pass `replyTo` as undefined — a group message id is not valid there.
 */
export function buildOutboundSegments(content: OutboundContent): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  if (content.replyTo) segments.push(replySegment(content.replyTo))
  for (const qq of content.at ?? []) segments.push(atSegment(qq))

  let text = content.text ?? ""
  const image = content.image
  if (image && "url" in image && !("data" in image) && !httpUrl(image.url)) {
    text = [text, image.url].filter(Boolean).join("\n")
  }
  if (text) segments.push(textSegment(text))
  if (image) {
    const mime = (image.mime ?? "image/jpeg").toLowerCase()
    const segmentType = mime.startsWith("audio/") ? "record" : mime.startsWith("video/") ? "video" : "image"
    if ("data" in image) {
      segments.push(mediaSegment(segmentType, { data: image.data }))
    } else if (httpUrl(image.url)) {
      segments.push(mediaSegment(segmentType, { url: image.url }))
    }
  }
  return segments
}

/** Paragraph-first splitter: never drops text, never cuts below half the window unless forced. */
export function splitText(text: string, limit = MAX_TEXT_CHARS): string[] {
  if (!text) return [""]
  if (limit < 1) throw new Error("max_text_chars must be positive")
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1)
    const boundaryFloor = Math.max(1, Math.floor(limit / 2))
    // rfind(sep, floor, limit): the whole separator must lie in [floor, limit), matching
    // Python's str.rfind(sep, start, end). lastIndexOf(sep, limit-1) can start at limit-1
    // and swallow the extra window char, producing a chunk of limit+1.
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

function rfind(haystack: string, needle: string, start: number, end: number): number {
  const idx = haystack.slice(start, end).lastIndexOf(needle)
  return idx === -1 ? -1 : start + idx
}

function httpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase()
    return scheme === "http" || scheme === "https"
  } catch {
    return false
  }
}
