import { useState } from "react"
import type { SelectOption } from "@opentui/core"
import { stripControlChars, type Block } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { bar } from "./CharacterPanel"

type BlockOf<K extends Block["kind"]> = Extract<Block, { kind: K }>
type UiMeterBlock = BlockOf<"meter">
type UiStatBlock = BlockOf<"stat">
type UiImageBlock = BlockOf<"image">
type UiMapPinBlock = BlockOf<"map_pin">
type UiTitleCardBlock = BlockOf<"title_card">
type UiChoicesBlock = BlockOf<"choices">
type UiBadgeTone = BlockOf<"badge">["tone"]
export type UiChoice = UiChoicesBlock["options"][number]

/** The performance templates as terminal text. A rich client draws stationery and full-bleed
 * act cards; here each template becomes the same information in lines, which is the honest
 * degradation — never a blank where a letter should be. */
export function letterLines(block: BlockOf<"letter">): string[] {
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

export function clippingLines(block: BlockOf<"clipping">): string[] {
  const credit = [block.source, block.date].filter(Boolean).map((part) => stripControlChars(String(part)))
  return [
    `▬ ${stripControlChars(block.headline)}`,
    ...stripControlChars(block.body).split("\n"),
    ...(credit.length ? [`— ${credit.join(" · ")}`] : []),
  ]
}

// Sidebar meters match VariablesPanel's compact tracker width; the inline log has
// room for CharacterPanel's full-width bars (NarrativeLog passes 10).
const METER_BAR_WIDTH = 6
const DIVIDER_GLYPHS = "─".repeat(24)

/** One meter line, exported so tests can pin the formatting without a renderer:
 * label + CharacterPanel's exact `bar` glyphs rescaled to the min..max span
 * (value clamped into range for the fill; the raw value still prints). */
export function meterLine(block: UiMeterBlock, width = METER_BAR_WIDTH): string {
  const clamped = Math.max(block.min, Math.min(block.max, block.value))
  return `${stripControlChars(block.label)} ${bar(clamped - block.min, block.max - block.min, width)} ${block.value}/${block.max}`
}

/** One stat line: bool gets VariablesPanel's check/cross + localized yes/no,
 * everything else a `label: value` one-liner. Server text is control-stripped. */
export function statLine(block: UiStatBlock, locale?: string): string {
  const label = stripControlChars(block.label)
  if (typeof block.value === "boolean") {
    return block.value ? `${label} ✓ ${tt(locale, "vars.yes")}` : `${label} ✗ ${tt(locale, "vars.no")}`
  }
  return `${label}: ${stripControlChars(String(block.value))}`
}

export function badgeLine(block: { label: string }): string {
  return `[${stripControlChars(block.label)}]`
}

/** One image block's text line: its caption, else its alt text, else the short hash, so the line
 * is never empty. Selecting it in the game view fetches the picture over the byte channel. */
export function imageLine(block: UiImageBlock, locale?: string): string {
  const text = stripControlChars(block.caption || block.alt || "").trim()
  return tt(locale, "ui.image", { text: text || block.hash.slice(0, 12) })
}

export function mapPinLine(block: UiMapPinBlock): string {
  const at = `${Math.round(block.x * 100)}%, ${Math.round(block.y * 100)}%`
  const note = block.note ? ` — ${stripControlChars(block.note)}` : ""
  return `📍 ${stripControlChars(block.label)} (${at})${note}`
}

export function titleCardLines(block: UiTitleCardBlock): string[] {
  const heading = [block.act, block.title].filter(Boolean).map((part) => stripControlChars(String(part))).join(" · ")
  return [DIVIDER_GLYPHS, heading, ...(block.subtitle ? [stripControlChars(block.subtitle)] : []), DIVIDER_GLYPHS]
}

export function badgeColor(tone: UiBadgeTone | undefined, theme: Palette): string {
  if (tone === "danger") return theme.fumble
  if (tone === "warn") return theme.fail
  return theme.accent
}

export interface UiChoicesInteraction {
  focused: boolean
  onPick: (option: UiChoice) => void
}

export interface UiBlocksViewProps {
  blocks: readonly Block[]
  theme: Palette
  locale?: string
  // When set, the LAST choices block renders as a live <select> (Enter runs the picked
  // option's command with `command.run`). Without it, choices render as a static option list.
  interactive?: UiChoicesInteraction
  meterWidth?: number
  /** Image blocks as pictures: each one's key (by block index), the selected key, and a click. */
  images?: { key: (index: number) => string; selected?: string; onOpen?: (key: string) => void }
}

/** Renders one `blocks` event's list. The protocol library validated every block's shape
 * (and dropped kinds it does not know), so rendering trusts the shapes but still strips
 * control bytes off every string like the other panels do. */
export function UiBlocksView({
  blocks,
  theme,
  locale,
  interactive,
  meterWidth = METER_BAR_WIDTH,
  images,
}: UiBlocksViewProps) {
  const lastChoicesIndex = blocks.reduce(
    (last, block, index) => (block.kind === "choices" ? index : last),
    -1,
  )
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`
        if (block.kind === "divider") {
          return (
            <text key={key} fg={theme.dim} wrapMode="none" truncate>
              {DIVIDER_GLYPHS}
            </text>
          )
        }
        if (block.kind === "meter") {
          return (
            <text key={key} fg={theme.accent} wrapMode="none" truncate>
              {meterLine(block, meterWidth)}
            </text>
          )
        }
        if (block.kind === "stat") {
          return (
            <text key={key} fg={theme.fg} wrapMode="none" truncate>
              {statLine(block, locale)}
            </text>
          )
        }
        if (block.kind === "badge") {
          return (
            <text key={key} fg={badgeColor(block.tone, theme)} wrapMode="none" truncate>
              {badgeLine(block)}
            </text>
          )
        }
        if (block.kind === "image") {
          const pictureKey = images?.key(index)
          const selected = pictureKey !== undefined && pictureKey === images?.selected
          const onOpen = images?.onOpen
          return (
            <box key={key} width="100%" flexShrink={0} backgroundColor={selected ? theme.accent : undefined} onMouseDown={pictureKey !== undefined && onOpen ? () => onOpen(pictureKey) : undefined}>
              <text fg={selected ? theme.bg : theme.system}>
                {imageLine(block, locale)}
                {selected ? `  ${tt(locale, "log.pictureOpen")}` : ""}
              </text>
            </box>
          )
        }
        if (block.kind === "letter" || block.kind === "clipping" || block.kind === "title_card") {
          const lines = block.kind === "letter" ? letterLines(block)
            : block.kind === "clipping" ? clippingLines(block)
            : titleCardLines(block)
          // A title card is the loudest thing the Director can do; letters and
          // clippings read as authored documents, so they take the quieter tones.
          const color = block.kind === "title_card" ? theme.accent : theme.fg
          return (
            <box key={key} flexDirection="column" width="100%" flexShrink={0}>
              {lines.map((line, row) => (
                <text key={`${key}-${row}`} fg={row === 0 && block.kind !== "letter" ? theme.accent : color}>
                  {line}
                </text>
              ))}
            </box>
          )
        }
        if (block.kind === "map_pin") {
          return (
            <text key={key} fg={theme.accent}>
              {mapPinLine(block)}
            </text>
          )
        }
        if (block.kind === "text") {
          const color = block.style === "warning" ? theme.fail : block.style === "quote" ? theme.dim : theme.fg
          const prefix = block.style === "warning" ? "⚠ " : block.style === "quote" ? "❝ " : ""
          return (
            <text key={key} fg={color}>
              {prefix + stripControlChars(block.text)}
            </text>
          )
        }
        return (
          <UiChoices
            key={key}
            block={block}
            theme={theme}
            locale={locale}
            interactive={index === lastChoicesIndex ? interactive : undefined}
          />
        )
      })}
    </box>
  )
}

function UiChoices({
  block,
  theme,
  locale,
  interactive,
}: {
  block: UiChoicesBlock
  theme: Palette
  locale?: string
  interactive?: UiChoicesInteraction
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const prompt = block.prompt ? stripControlChars(block.prompt) : ""
  if (!interactive) {
    return (
      <box flexDirection="column" width="100%" flexShrink={0}>
        {prompt ? <text fg={theme.accent}>{prompt}</text> : null}
        {block.options.map((option, index) => (
          <text key={`${option.id}-${index}`} fg={theme.dim} wrapMode="none" truncate>
            {`▫ ${stripControlChars(option.label)}`}
          </text>
        ))}
      </box>
    )
  }
  const options: SelectOption[] = block.options.map((option) => ({
    name: stripControlChars(option.label),
    description: "",
    value: option.id,
  }))
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      {prompt ? <text fg={theme.accent}>{prompt}</text> : null}
      <select
        height={Math.min(block.options.length, 8)}
        // Every option carries an empty `description`, and OpenTUI's select spends a
        // SECOND row per item whenever descriptions are on — which silently halved the
        // visible menu (4 authored choices showed 2). Off, one row per option, so the
        // height above is the real option count.
        showDescription={false}
        focused={interactive.focused}
        options={options}
        selectedIndex={selectedIndex}
        backgroundColor={theme.bg}
        textColor={theme.fg}
        focusedBackgroundColor={theme.bg}
        focusedTextColor={theme.accent}
        selectedBackgroundColor={theme.accent}
        selectedTextColor={theme.bg}
        descriptionColor={theme.dim}
        selectedDescriptionColor={theme.bg}
        onChange={(index: number) => setSelectedIndex(index)}
        onSelect={() => {
          const option = block.options[Math.max(0, Math.min(selectedIndex, block.options.length - 1))]
          if (option) interactive.onPick(option)
        }}
      />
      <text fg={theme.dim} wrapMode="none" truncate>
        {tt(locale, "ui.choicesHint")}
      </text>
    </box>
  )
}
