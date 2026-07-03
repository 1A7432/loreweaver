import { stripControlChars, type CharacterState } from "@loreweaver/protocol"

const VITAL_KEYS = new Set(["HP", "HPMAX", "MP", "MPMAX", "SAN", "SANMAX"])
const COC_CHARACTERISTICS = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"]
const DND_ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
const DERIVED_NOISE_KEYS = new Set(["IDEA", "KNOW"])

export interface AttributeLine {
  key: string
  value: unknown
  line: string
}

function normalizedSystem(system: string): "coc" | "dnd" | "other" {
  const value = system.toLowerCase()
  if (value === "coc" || value === "coc7") return "coc"
  if (value === "dnd" || value === "dnd5e") return "dnd"
  return "other"
}

function isInternalAttribute(key: string): boolean {
  const normalized = key.toUpperCase()
  return VITAL_KEYS.has(normalized) || normalized.endsWith("MAXADD") || DERIVED_NOISE_KEYS.has(normalized)
}

function orderedCoreAttributes(
  attributes: Record<string, unknown>,
  order: string[],
): Array<[string, unknown]> {
  const byUpper = new Map(Object.entries(attributes).map(([key, value]) => [key.toUpperCase(), value] as const))
  return order.flatMap((key) => (byUpper.has(key) ? ([[key, byUpper.get(key)] as [string, unknown]] as const) : []))
}

export function trueRuleAttributes(character?: CharacterState): Array<[string, unknown]> {
  if (!character) return []
  const system = normalizedSystem(character.system)
  if (system === "coc") return orderedCoreAttributes(character.attributes, COC_CHARACTERISTICS)
  if (system === "dnd") return orderedCoreAttributes(character.attributes, DND_ABILITIES)
  return Object.entries(character.attributes)
    .filter(([key]) => !isInternalAttribute(key))
    .map(([key, value]) => [key.toUpperCase(), value])
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
