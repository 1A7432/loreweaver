import { stripControlChars, type CharacterState } from "loreweaver-protocol"

export interface AttributeLine {
  key: string
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

export function attributeLines(character?: CharacterState): AttributeLine[] {
  const entries = trueRuleAttributes(character)
  const width = Math.max(3, ...entries.map(([key]) => key.length))
  return entries.map(([key, value]) => ({
    key,
    value,
    line: stripControlChars(`${key.padEnd(width)} ${String(value)}`),
  }))
}
