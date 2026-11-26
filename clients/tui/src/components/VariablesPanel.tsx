import { stripControlChars, type VariablesView, type ViewModuleVariable, type ViewTreeLeaf } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { bar } from "./CharacterPanel"
import { FitText } from "./FitText"

export interface VariablesPanelProps {
  variables?: VariablesView | null
  theme: Palette
  locale?: string
}

// Matches PartyRoster's compact vitals width: variable labels are arbitrary-length
// module data, so the narrower bar leaves the label + value room inside the 24–32-col
// sidebar before the row is cut.
const VARIABLE_BAR_WIDTH = 6

// A variable players do not see (`hidden`, sent to an admin only) is prefixed with this mark
// and drawn dim: on the admin's own screen something the table cannot see must never look
// like table data. A single-width BMP glyph like the panel's other markers (✓/✗).
const HIDDEN_GLYPH = "⊘"

/** A "number" variable renders a bar only when the server bounded it (both ends). */
export function isBounded(variable: ViewModuleVariable): boolean {
  return variable.kind === "number" && typeof variable.min === "number" && typeof variable.max === "number"
}

/** The text a non-bar, non-bool variable shows for its value: an enum's server-named option
 * (`valueLabel`) when present, else the raw value. */
export function variableValueText(variable: ViewModuleVariable): string {
  if (variable.kind === "enum" && typeof variable.valueLabel === "string" && variable.valueLabel) return variable.valueLabel
  return String(variable.value)
}

/** One sidebar line per module variable. Bounded numbers reuse CharacterPanel's `bar` glyphs
 * (rescaled to the min..max span); bool gets a check/cross + localized yes/no; everything else
 * is a `label: value` one-liner. Server text is control-stripped. */
export function variableLine(variable: ViewModuleVariable, locale?: string): string {
  const label = `${variable.hidden ? HIDDEN_GLYPH : ""}${stripControlChars(variable.label)}`
  if (variable.kind === "bool") {
    return variable.value ? `${label} ✓ ${tt(locale, "vars.yes")}` : `${label} ✗ ${tt(locale, "vars.no")}`
  }
  if (isBounded(variable)) {
    const min = variable.min as number
    const max = variable.max as number
    const value = Number(variable.value)
    return `${label} ${bar(value - min, max - min, VARIABLE_BAR_WIDTH)} ${value}/${max}`
  }
  return `${label}: ${stripControlChars(variableValueText(variable))}`
}

/** One sidebar line per variable-tree leaf: `path: value` (a list joins with commas). */
export function leafLine(leaf: ViewTreeLeaf): string {
  const value = Array.isArray(leaf.value) ? leaf.value.map((item) => String(item)).join(", ") : String(leaf.value)
  return `${leaf.hidden ? HIDDEN_GLYPH : ""}${stripControlChars(leaf.path)}: ${stripControlChars(value)}`
}

/** The room-variables sidebar panel: module variables then the variable tree, in the order the
 * `variables` view sent them — never sorted. Renders nothing at all when there are none. */
export function VariablesPanel({ variables, theme, locale }: VariablesPanelProps) {
  const module = variables?.module ?? []
  const tree = variables?.tree ?? []
  if (module.length === 0 && tree.length === 0) return null
  return (
    // flexShrink=0 like CharacterPanel: in a tight sidebar column yoga would
    // otherwise squash this panel and composite its rows on top of each other.
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "vars.title")}</text>
      {module.map((variable) => (
        <FitText key={`m-${variable.id}`} fg={variable.hidden ? theme.dim : theme.fg} cut="middle">
          {variableLine(variable, locale)}
        </FitText>
      ))}
      {tree.map((leaf) => (
        <FitText key={`t-${leaf.path}`} fg={leaf.hidden ? theme.dim : theme.fg} cut="middle">
          {leafLine(leaf)}
        </FitText>
      ))}
    </box>
  )
}
