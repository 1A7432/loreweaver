import { stripControlChars, type MeView, type ViewResource } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { attributeRows } from "./characterAttributes"
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

/** One resource on one line: its label, a bar and value/max — or only the value when it has no maximum (a module may give none). */
export function resourceText(res: ViewResource, width = 10): string {
  const label = stripControlChars(res.label || res.id)
  return res.max === undefined ? `${label} ${res.value}` : `${label} ${bar(res.value, res.max, width)} ${res.value}/${res.max}`
}

/** The colour of a resource's line: low or full against its maximum; full when it has none. */
export function resourceColor(res: ViewResource, full: string, low: string): string {
  return res.max === undefined ? full : statColor(res.value, res.max, full, low)
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
      {/* A module's character: the module keeps it, in place of a rule system's sheet. */}
      {character.module !== undefined ? (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.keptBy", { module: stripControlChars(character.module) })}</text>
      ) : null}
      {resources.map((res) => (
        <text key={res.id} fg={resourceColor(res, theme.hpFull, theme.hpLow)} wrapMode="none" truncate>
          {resourceText(res)}
        </text>
      ))}
      {attributeRows(character.attributes).map((row, index) => (
        <FitText key={index} fg={theme.fg} cut="middle">
          {row}
        </FitText>
      ))}
      {character.status.length > 0 ? (
        <text fg={theme.fail} wrapMode="none" truncate>✖ {stripControlChars(character.status.join(", "))}</text>
      ) : character.module !== undefined ? null : (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.ok")}</text>
      )}
    </box>
  )
}
