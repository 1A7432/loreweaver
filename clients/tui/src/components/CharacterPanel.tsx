import { stripControlChars, type CharacterState } from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { attributeLines } from "./characterAttributes"

export interface CharacterPanelProps {
  character?: CharacterState
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
      <box flexDirection="column" border borderColor={theme.border} paddingX={1} height={5}>
        <text fg={theme.accent}>CHARACTER</text>
        <text fg={theme.dim}>{tt(locale, "character.noCharacter")}</text>
      </box>
    )
  }

  const incapacitated = character.hp <= 0
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1}>
      <text fg={theme.accent}>
        CHARACTER {incapacitated ? "☠" : ""}
      </text>
      <text fg={theme.kp}>{stripControlChars(character.name)}</text>
      <text fg={statColor(character.hp, character.hpmax, theme.hpFull, theme.hpLow)}>
        HP {bar(character.hp, character.hpmax)} {character.hp}/{character.hpmax}
      </text>
      <text fg={theme.success}>
        MP {bar(character.mp, character.mpmax)} {character.mp}/{character.mpmax}
      </text>
      <text fg={statColor(character.san, character.sanmax, theme.sanFull, theme.sanLow)}>
        SAN {bar(character.san, character.sanmax)} {character.san}/{character.sanmax}
      </text>
      {attributeLines(character).slice(0, 6).map(({ key, line }) => (
        <text key={key} fg={theme.fg}>
          {line}
        </text>
      ))}
      {character.status_effects.length > 0 ? (
        <text fg={theme.fail}>✖ {stripControlChars(character.status_effects.join(", "))}</text>
      ) : (
        <text fg={theme.dim}>OK</text>
      )}
    </box>
  )
}
