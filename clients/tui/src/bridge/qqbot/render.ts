import { FrameType, stripControlChars, type ServerFrame, type UiChoicesBlock } from "loreweaver-protocol"
import { diceLine } from "../render/dice"
import { markdownToPlain, splitText } from "../render/narrative"
import { renderUiBlocks, type BridgeMediaRef } from "../render/uiText"

export const QQBOT_CHUNK_CHARS = 2800
export const URL_PLACEHOLDER = "[链接]"

const URL_RE = /https?:\/\/[^\s<>"'\]）)>\u3001\u3002]+/gi

export function isQueuedInputNotice(text: string): boolean {
  return text.includes("Your input is queued") || text.includes("你的输入已入队")
}

export function hostAllowed(url: string, whitelist: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return whitelist.some((entry) => {
      const allowed = entry.toLowerCase().replace(/^\./, "")
      return host === allowed || host.endsWith(`.${allowed}`)
    })
  } catch {
    return false
  }
}

export function replaceUrls(text: string, whitelist: readonly string[] = []): string {
  return text.replace(URL_RE, (url) => (hostAllowed(url, whitelist) ? url : URL_PLACEHOLDER))
}

export function atUserTag(memberOpenid: string): string {
  return `<qqbot-at-user id="${memberOpenid}" />`
}

export function renderNpcMarkdown(name: string | undefined, text: string): string {
  const who = stripControlChars(name || "").trim()
  const body = stripControlChars(text)
  return who ? `**${who}**：${body}` : body
}

export function recutHalf(text: string): string {
  const half = Math.max(1, Math.floor(text.length / 2))
  const parts = splitText(text, half)
  return parts[0] ?? text.slice(0, half)
}

export function cutMarkdown(text: string, limit = QQBOT_CHUNK_CHARS): string[] {
  return splitText(text, limit)
}

export interface RenderedQqFrame {
  text: string
  media: BridgeMediaRef[]
  choices?: UiChoicesBlock
  isKpNarrative: boolean
  isQueuedNotice: boolean
  skip: boolean
}

export function renderFrame(frame: ServerFrame, locale?: string): RenderedQqFrame {
  switch (frame.type) {
    case FrameType.Narrative: {
      if (frame.speaker === "player" || !frame.text) return empty()
      const text =
        frame.speaker === "npc" ? renderNpcMarkdown(frame.name, frame.text) : stripControlChars(frame.text)
      return {
        text,
        media: [],
        isKpNarrative: frame.speaker === "kp",
        isQueuedNotice: false,
        skip: false,
      }
    }
    case FrameType.Dice:
      return { text: diceLine(frame, locale), media: [], isKpNarrative: false, isQueuedNotice: false, skip: false }
    case FrameType.Ui: {
      const view = renderUiBlocks(frame.blocks)
      return {
        text: view.lines.join("\n"),
        media: view.media,
        choices: view.choices,
        isKpNarrative: false,
        isQueuedNotice: false,
        skip: false,
      }
    }
    case FrameType.Media:
      return {
        text: "",
        media: [{ hash: frame.hash, mime: frame.mime, name: frame.name }],
        isKpNarrative: false,
        isQueuedNotice: false,
        skip: false,
      }
    case FrameType.AudioLibraryItem:
      return {
        text: frame.title || frame.name || "",
        media: [],
        isKpNarrative: false,
        isQueuedNotice: false,
        skip: false,
      }
    case FrameType.System: {
      const text = frame.text || ""
      return {
        text,
        media: [],
        isKpNarrative: false,
        isQueuedNotice: isQueuedInputNotice(text),
        skip: isQueuedInputNotice(text) || !text,
      }
    }
    case FrameType.Error: {
      const text = frame.message || ""
      return { text, media: [], isKpNarrative: false, isQueuedNotice: false, skip: !text }
    }
    case FrameType.TurnStatus:
      return empty()
    default:
      return empty()
  }
}

export function toPlain(markdown: string): string {
  return markdownToPlain(markdown)
}

function empty(): RenderedQqFrame {
  return { text: "", media: [], isKpNarrative: false, isQueuedNotice: false, skip: true }
}
