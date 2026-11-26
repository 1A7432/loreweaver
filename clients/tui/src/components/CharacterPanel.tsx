import { stripControlChars, type MeView } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { attributeLines } from "./characterAttributes"
import { FitText } from "./FitText"

/** The viewer's own character, as the `me` view carries it. */
export type SheetCharacter = NonNullable<MeView["character"]>

export interface CharacterPanelProps {
  character?: SheetCharacter | null
  theme: Palette
  locale?: string
}

function ratio(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, value / max))
}

// Exported so other panels (e.g. the merged party/character roster) can render
// stat bars with the exact same glyphs/thresholds instead of re-implementing them.
export function bar(value: number, max: number, width = 10): string {
  const filled = Math.round(ratio(value, max) * width)
  const empty = Math.max(0, width - filled)
  const glyph = ratio(value, max) > 0.6 ? "█" : ratio(value, max) > 0.3 ? "▓" : "▒"
  return `${glyph.repeat(filled)}${"░".repeat(empty)}`
}

export function statColor(value: number, max: number, full: string, low: string): string {
  return ratio(value, max) <= 0.35 ? low : full
}

export function CharacterPanel({ character, theme, locale }: CharacterPanelProps) {
  if (!character) {
    return (
      // No fixed height here: the reconciler does not clear a removed `height` prop, so a
      // box first rendered empty (menu mount, pre-state) would stay 5 rows tall forever and
      // composite the full panel's 11 rows on top of each other once the state frame lands.
      <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
        <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "character.panelTitle")}</text>
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.noCharacter")}</text>
      </box>
    )
  }

  const resources = character.resources
  // The first resource is the system's primary vital (HP-like); at 0 the
  // character is down. Generic: no rule-system field names anywhere.
  const primary = resources[0]
  const incapacitated = primary != null && primary.value <= 0
  return (
    // flexShrink=0: in a tight sidebar column yoga would otherwise squash this panel and
    // composite its rows on top of each other (HP over SIZ, OK over INT, ...).
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>
        {tt(locale, "character.panelTitle")} {incapacitated ? "☠" : ""}
      </text>
      <text fg={theme.kp} wrapMode="none" truncate>{stripControlChars(character.name)}</text>
      {resources.map((res) => (
        <text
          key={res.id}
          fg={statColor(res.value, res.max, theme.hpFull, theme.hpLow)}
          wrapMode="none"
          truncate
        >
          {stripControlChars(res.label || res.id)} {bar(res.value, res.max)} {res.value}/{res.max}
        </text>
      ))}
      {attributeLines(character.attributes).slice(0, 6).map(({ key, line }) => (
        <FitText key={key} fg={theme.fg} cut="middle">
          {line}
        </FitText>
      ))}
      {character.status.length > 0 ? (
        <text fg={theme.fail} wrapMode="none" truncate>✖ {stripControlChars(character.status.join(", "))}</text>
      ) : (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.ok")}</text>
      )}
    </box>
  )
}
