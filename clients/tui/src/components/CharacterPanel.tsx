import type { CharacterState } from "@trpg-kp/protocol"
import type { Palette } from "../themes"

export interface CharacterPanelProps {
  character?: CharacterState
  theme: Palette
}

function ratio(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, value / max))
}

function bar(value: number, max: number, width = 10): string {
  const filled = Math.round(ratio(value, max) * width)
  const empty = Math.max(0, width - filled)
  const glyph = ratio(value, max) > 0.6 ? "█" : ratio(value, max) > 0.3 ? "▓" : "▒"
  return `${glyph.repeat(filled)}${"░".repeat(empty)}`
}

function statColor(value: number, max: number, full: string, low: string): string {
  return ratio(value, max) <= 0.35 ? low : full
}

function renderAttributes(attributes: Record<string, unknown>): string[] {
  return Object.entries(attributes)
    .slice(0, 6)
    .map(([key, value]) => `${key.toUpperCase().slice(0, 4)} ${String(value)}`)
}

export function CharacterPanel({ character, theme }: CharacterPanelProps) {
  if (!character) {
    return (
      <box flexDirection="column" border borderColor={theme.border} paddingX={1} height={5}>
        <text fg={theme.accent}>CHARACTER</text>
        <text fg={theme.dim}>No character</text>
      </box>
    )
  }

  const incapacitated = character.hp <= 0
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1}>
      <text fg={theme.accent}>
        CHARACTER {incapacitated ? "☠" : ""}
      </text>
      <text fg={theme.kp}>{character.name}</text>
      <text fg={statColor(character.hp, character.hpmax, theme.hpFull, theme.hpLow)}>
        HP {bar(character.hp, character.hpmax)} {character.hp}/{character.hpmax}
      </text>
      <text fg={theme.success}>
        MP {bar(character.mp, character.mpmax)} {character.mp}/{character.mpmax}
      </text>
      <text fg={statColor(character.san, character.sanmax, theme.sanFull, theme.sanLow)}>
        SAN {bar(character.san, character.sanmax)} {character.san}/{character.sanmax}
      </text>
      {renderAttributes(character.attributes).map((line) => (
        <text key={line} fg={theme.fg}>
          {line}
        </text>
      ))}
      {character.status_effects.length > 0 ? (
        <text fg={theme.fail}>✖ {character.status_effects.join(", ")}</text>
      ) : (
        <text fg={theme.dim}>OK</text>
      )}
    </box>
  )
}

