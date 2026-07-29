import { stripControlChars, type ModuleVariable } from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { bar } from "./CharacterPanel"

export interface VariablesPanelProps {
  variables?: ModuleVariable[]
  theme: Palette
  locale?: string
}

// Matches PartyRoster's compact vitals width: variable labels are arbitrary-length
// module data (unlike the fixed "HP"/"MP"/"SAN"), so the narrower bar leaves the
// label + value room inside the 24–32-col sidebar before `truncate` kicks in.
const VARIABLE_BAR_WIDTH = 6

/** A "number" variable renders a bar only when the server bounded it (both ends). */
export function isBounded(variable: ModuleVariable): boolean {
  return variable.kind === "number" && typeof variable.min === "number" && typeof variable.max === "number"
}

/** One sidebar line of text per variable, exported so tests can pin the formatting
 * without a renderer. Bounded numbers reuse CharacterPanel's exact `bar` glyphs
 * (rescaled to the min..max span); bool gets a check/cross + localized yes/no;
 * everything else is a `label: value` one-liner. Label and value are untrusted
 * server text — control characters are stripped like every other panel does. */
export function variableLine(variable: ModuleVariable, locale?: string): string {
  const label = stripControlChars(variable.label)
  if (variable.kind === "bool") {
    return variable.value
      ? `${label} ✓ ${tt(locale, "vars.yes")}`
      : `${label} ✗ ${tt(locale, "vars.no")}`
  }
  if (isBounded(variable)) {
    const min = variable.min as number
    const max = variable.max as number
    const value = Number(variable.value)
    return `${label} ${bar(value - min, max - min, VARIABLE_BAR_WIDTH)} ${value}/${max}`
  }
  return `${label}: ${stripControlChars(String(variable.value))}`
}

/** The module-variables ("trackers") sidebar panel: one truncating line per
 * player-visible variable from `state.variables`, in received (definition) order —
 * never sorted. Renders nothing at all when the room has none. */
export function VariablesPanel({ variables, theme, locale }: VariablesPanelProps) {
  if (!variables || variables.length === 0) return null
  return (
    // flexShrink=0 like CharacterPanel: in a tight sidebar column yoga would
    // otherwise squash this panel and composite its rows on top of each other.
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "vars.title")}</text>
      {variables.map((variable) => (
        <text key={variable.id} fg={theme.fg} wrapMode="none" truncate>
          {variableLine(variable, locale)}
        </text>
      ))}
    </box>
  )
}
