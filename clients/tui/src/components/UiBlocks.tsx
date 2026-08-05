import { useState } from "react"
import type { SelectOption } from "@opentui/core"
import {
  stripControlChars,
  type UiBadgeTone,
  type UiChoicesBlock,
  type UiFrame,
  type UiMeterBlock,
  type UiStatBlock,
} from "loreweaver-protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { bar } from "./CharacterPanel"

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
}

/** Renders one v1.7 `ui` frame's block list. Blocks arrive server-validated
 * (kind whitelist, caps — core.hooks), so rendering trusts the shapes but still
 * strips control bytes off every string like the other panels do. */
export function UiBlocksView({ frame, theme, locale, interactive, meterWidth = METER_BAR_WIDTH }: UiBlocksViewProps) {
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
