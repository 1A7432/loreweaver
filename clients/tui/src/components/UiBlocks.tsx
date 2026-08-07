import { useState } from "react"
import type { SelectOption } from "@opentui/core"
import {
  stripControlChars,
  type UiBadgeTone,
  type UiChoicesBlock,
  type UiClippingBlock,
  type UiFrame,
  type UiImageBlock,
  type UiLetterBlock,
  type UiMapPinBlock,
  type UiMeterBlock,
  type UiStatBlock,
  type UiTitleCardBlock,
} from "loreweaver-protocol"
import type { AppClient } from "../client"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { bar } from "./CharacterPanel"
import { MediaPreviewRows, useMediaPreview } from "./MediaPreview"

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

/** One image block's text line — the whole block on a text-first client without a
 * fetch channel, and the caption above the preview when there is one. Falls back
 * through caption -> alt -> the short hash so the line is never empty. */
export function imageLine(block: UiImageBlock, locale?: string): string {
  const text = stripControlChars(block.caption || block.alt || "").trim()
  return tt(locale, "ui.image", { text: text || block.hash.slice(0, 12) })
}

/** The M19 performance templates as terminal text. A rich client draws stationery
 * and full-bleed act cards; here each template becomes the same information in lines,
 * which is the honest degradation — never a blank where a letter should be. Exported
 * so tests pin the shape without a renderer. */
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
  onPick: (input: string) => void
}

export interface UiBlocksViewProps {
  frame: UiFrame
  theme: Palette
  locale?: string
  // When set, the LAST choices block of this frame renders as a live <select>
  // (Enter sends the picked option's `input` as a normal player input). Without
  // it, choices render as a static option list — the sidebar baseline.
  interactive?: UiChoicesInteraction
  meterWidth?: number
  // When set, `image` blocks fetch their bytes and draw a terminal preview. The
  // inline narrative log passes it; the narrow sidebars deliberately do not — a
  // half-block picture in a 24-column column is worse than its caption line.
  client?: AppClient
}

/** Renders one `ui` frame's block list. Blocks arrive server-validated
 * (kind whitelist, caps — core.hooks), so rendering trusts the shapes but still
 * strips control bytes off every string like the other panels do. */
export function UiBlocksView({
  frame,
  theme,
  locale,
  interactive,
  meterWidth = METER_BAR_WIDTH,
  client,
}: UiBlocksViewProps) {
  const lastChoicesIndex = frame.blocks.reduce(
    (last, block, index) => (block.kind === "choices" ? index : last),
    -1,
  )
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      {frame.blocks.map((block, index) => {
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
          return <UiImage key={key} block={block} theme={theme} locale={locale} client={client} />
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

/** An `image` block: the caption line always, plus the same half-block preview the
 * media log draws when this view was given a fetch channel. A failed fetch keeps the
 * caption — the picture is an enhancement, never the only content. */
function UiImage({
  block,
  theme,
  locale,
  client,
}: {
  block: UiImageBlock
  theme: Palette
  locale?: string
  client?: AppClient
}) {
  const { lines } = useMediaPreview(block.mime ? { hash: block.hash, mime: block.mime } : undefined, client)
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <text fg={theme.system}>{imageLine(block, locale)}</text>
      {lines ? <MediaPreviewRows lines={lines} keyPrefix={block.hash} /> : null}
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
    value: option.input,
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
          if (option) interactive.onPick(option.input)
        }}
      />
      <text fg={theme.dim} wrapMode="none" truncate>
        {tt(locale, "ui.choicesHint")}
      </text>
    </box>
  )
}
