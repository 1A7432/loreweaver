import { stripControlChars, type DiceFrame } from "loreweaver-protocol"
import { tt } from "../../i18n"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asFlag(value: unknown): boolean {
  return value === true
}

/**
 * One dice line: actor, expression, outcome label, total; `detail` extras are
 * critical flags, an opposed `right` side, and `winner`. Built ONLY from public
 * dice fields — extra keys on the frame never appear.
 */
export function diceLine(frame: DiceFrame, locale?: string): string {
  const actor = stripControlChars(frame.actor)
  const expr = stripControlChars(frame.expr)
  const label = frame.outcome?.label ? stripControlChars(frame.outcome.label) : ""
  const parts = [actor, expr]
  if (label) parts.push(label)
  parts.push(String(frame.total))

  const extras: string[] = []
  const critical = Boolean(frame.outcome?.critical) || asFlag(frame.detail?.critical_success)
  const fumble = Boolean(frame.outcome?.fumble) || asFlag(frame.detail?.critical_failure)
  if (critical) extras.push(tt(locale, "bridge.dice.critical"))
  if (fumble) extras.push(tt(locale, "bridge.dice.fumble"))

  const right = asRecord(frame.detail?.right)
  if (right) {
    const name = asString(right.name)
    const total = asNumber(right.total)
    const side = [name, total !== undefined ? String(total) : undefined].filter(Boolean).join(" ")
    if (side) extras.push(tt(locale, "bridge.dice.vs", { side }))
  }

  const winner = asString(frame.detail?.winner)
  if (winner === "left" || winner === "right" || winner === "tie") {
    const side = tt(locale, winner === "left" ? "bridge.dice.left" : winner === "right" ? "bridge.dice.right" : "bridge.dice.tie")
    extras.push(tt(locale, "bridge.dice.winner", { side }))
  }

  const line = extras.length ? `${parts.join(" ")} ${extras.join(" ")}` : parts.join(" ")
  return stripControlChars(line)
}
