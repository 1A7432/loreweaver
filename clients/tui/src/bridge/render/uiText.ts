import { stripControlChars, type UiBlock, type UiClippingBlock, type UiLetterBlock } from "loreweaver-protocol"

/** Practical group-chat text cap — splitters take this as the default limit. */
export const BRIDGE_TEXT_LIMIT = 4000

/** The M19 performance templates as terminal text. A rich client draws stationery
 * and full-bleed act cards; here each template becomes the same information in lines,
 * which is the honest degradation — never a blank where a letter should be. Exported
 * so tests pin the shape without a renderer. Shared with the TUI `UiBlocks` view. */
export function letterLines(block: UiLetterBlock): string[] {
  const attribution = [
    block.to ? `→ ${stripControlChars(block.to)}` : "",
    block.from ? `— ${stripControlChars(block.from)}` : "",
    block.date ? stripControlChars(block.date) : "",
  ].filter(Boolean)
  return [
    ...stripControlChars(block.body).split("\n").map((line) => `│ ${line}`),
    ...(attribution.length ? [`│ ${attribution.join(" · ")}`] : []),
  ]
}

export function clippingLines(block: UiClippingBlock): string[] {
  const credit = [block.source, block.date].filter(Boolean).map((part) => stripControlChars(String(part)))
  return [
    `▬ ${stripControlChars(block.headline)}`,
    ...stripControlChars(block.body).split("\n"),
    ...(credit.length ? [`— ${credit.join(" · ")}`] : []),
  ]
}

export interface BridgeMediaRef {
  hash: string
  mime?: string
  name?: string
}

export interface RenderedUi {
  lines: string[]
  media: BridgeMediaRef[]
  /** The last `choices` block in this frame, if any — opens the group's choices window. */
  choices?: Extract<UiBlock, { kind: "choices" }>
}

function meterText(block: Extract<UiBlock, { kind: "meter" }>): string {
  return `${stripControlChars(block.label)} ${block.value}/${block.max}`
}

function statText(block: Extract<UiBlock, { kind: "stat" }>): string {
  return `${stripControlChars(block.label)}: ${stripControlChars(String(block.value))}`
}

function badgeText(block: Extract<UiBlock, { kind: "badge" }>): string {
  const mark = block.tone === "danger" ? "!!" : block.tone === "warn" ? "!" : ""
  return `${mark}[${stripControlChars(block.label)}]`
}

function textBlockLines(block: Extract<UiBlock, { kind: "text" }>): string[] {
  const body = stripControlChars(block.text)
  if (block.style === "quote") return body.split("\n").map((line) => `> ${line}`)
  return body.split("\n")
}

function choicesLines(block: Extract<UiBlock, { kind: "choices" }>): string[] {
  const lines: string[] = []
  if (block.prompt) lines.push(stripControlChars(block.prompt))
  block.options.forEach((option, index) => {
    lines.push(`${index + 1}. ${stripControlChars(option.label)}`)
  })
  return lines
}

function imageCaption(block: Extract<UiBlock, { kind: "image" }>): string {
  const text = stripControlChars(block.caption || block.alt || "").trim()
  return text || block.hash.slice(0, 12)
}

function mapPinText(block: Extract<UiBlock, { kind: "map_pin" }>): string {
  const at = `${Math.round(block.x * 100)}%, ${Math.round(block.y * 100)}%`
  const note = block.note ? ` ${stripControlChars(block.note)}` : ""
  return `${stripControlChars(block.label)} (${at})${note}`
}

function titleCardLines(block: Extract<UiBlock, { kind: "title_card" }>): string[] {
  return [block.act, block.title, block.subtitle]
    .filter((part): part is string => Boolean(part && part.length))
    .map((part) => stripControlChars(part))
}

/** Spec degradation table for all 11 `ui` block kinds. Platform-neutral lines
 * (and media hashes) — WS3/WS4 map `media` to image segments. */
export function renderUiBlock(block: UiBlock): RenderedUi {
  switch (block.kind) {
    case "meter":
      return { lines: [meterText(block)], media: [] }
    case "stat":
      return { lines: [statText(block)], media: [] }
    case "badge":
      return { lines: [badgeText(block)], media: [] }
    case "text":
      return { lines: textBlockLines(block), media: [] }
    case "divider":
      return { lines: ["——"], media: [] }
    case "choices":
      return { lines: choicesLines(block), media: [], choices: block }
    case "image":
      return {
        lines: [imageCaption(block)],
        media: [{ hash: block.hash, mime: block.mime, name: block.caption || block.alt || block.hash.slice(0, 12) }],
      }
    case "letter":
      return { lines: letterLines(block), media: [] }
    case "clipping":
      return { lines: clippingLines(block), media: [] }
    case "map_pin":
      return {
        lines: [mapPinText(block)],
        media: [{ hash: block.hash, mime: block.mime, name: block.label }],
      }
    case "title_card":
      return { lines: titleCardLines(block), media: [] }
  }
}

export function renderUiBlocks(blocks: UiBlock[]): RenderedUi {
  const lines: string[] = []
  const media: BridgeMediaRef[] = []
  let choices: Extract<UiBlock, { kind: "choices" }> | undefined
  for (const block of blocks) {
    const rendered = renderUiBlock(block)
    lines.push(...rendered.lines)
    media.push(...rendered.media)
    if (rendered.choices) choices = rendered.choices
  }
  return { lines, media, choices }
}
