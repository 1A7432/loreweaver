import { stripControlChars, type CharacterState } from "loreweaver-protocol"

export interface AttributeLine {
  key: string
  /** What the line shows for the key: `attribute_labels[key]` (protocol 2.5), else the key. */
  label: string
  value: unknown
  line: string
}

/** The sheet's attributes exactly as the wire sent them, in wire order.
 *
 * Protocol 2.3: `state.character.attributes` is the rule system's own declared
 * characteristics, in the pack's order — the vitals ride `resources` and derived
 * values are never sent. So there is nothing here to hide or reorder, and no per-system
 * table to do it with: this client used to keep a CoC list and a D&D list for exactly
 * that, which is per-system knowledge M16 took out of the engine and which locked a
 * community pack's own system out of the view. */
export function trueRuleAttributes(character?: CharacterState): Array<[string, unknown]> {
  if (!character) return []
  return Object.entries(character.attributes)
}

/** The name a line shows for `key`: the server's display label when it sent one
 * (protocol 2.5 `attribute_labels`, e.g. APP → 外貌), else the key itself — exactly
 * what an older server's frames always showed. Untrusted server text: control
 * characters are stripped. */
export function attributeLabel(character: CharacterState | undefined, key: string): string {
  const label = character?.attribute_labels?.[key]
  const cleaned = typeof label === "string" ? stripControlChars(label).trim() : ""
  return cleaned || stripControlChars(key)
}

/** `text` padded with spaces to `width` terminal CELLS. A CJK character is two cells
 * wide, so `String.padEnd` (which counts UTF-16 units) would misalign 外貌 against STR. */
function padCells(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)))
}

export function attributeLines(character?: CharacterState): AttributeLine[] {
  const entries = trueRuleAttributes(character).map(
    ([key, value]) => [key, attributeLabel(character, key), value] as const,
  )
  const width = Math.max(3, ...entries.map(([, label]) => Bun.stringWidth(label)))
  return entries.map(([key, label, value]) => ({
    key,
    label,
    value,
    line: `${padCells(label, width)} ${stripControlChars(String(value))}`,
  }))
}
