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
 * One dice line: 🎲, actor, expression, the roll (as `roll/target` when the frame has a
 * target — a bare "50" read as either), outcome label; `detail` extras are critical
 * flags, an opposed `right` side, `winner`, and a resource loss (with its cap and what
 * remains — the loss a check costs is the point of the roll). Built ONLY from public
 * dice fields — extra keys on the frame never appear.
 */
export function diceLine(frame: DiceFrame, locale?: string): string {
  const actor = stripControlChars(frame.actor)
  const expr = stripControlChars(frame.expr)
  const label = frame.outcome?.label ? stripControlChars(frame.outcome.label) : ""
  const target = asNumber(frame.effective_target) ?? asNumber(frame.target)
  const parts = ["🎲", actor, expr, target !== undefined ? `${frame.total}/${target}` : `= ${frame.total}`]
  if (label) parts.push(label)

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

  const loss = asNumber(frame.detail?.loss)
  if (loss !== undefined) {
    const ceiling = asNumber(frame.detail?.loss_ceiling)
    extras.push(
      ceiling !== undefined
        ? tt(locale, "bridge.dice.lossCapped", { loss: String(loss), ceiling: String(ceiling) })
        : tt(locale, "bridge.dice.loss", { loss: String(loss) }),
    )
    const remaining = asNumber(frame.detail?.remaining)
    if (remaining !== undefined) extras.push(tt(locale, "bridge.dice.remaining", { remaining: String(remaining) }))
  }

  const line = extras.length ? `${parts.join(" ")} ${extras.join(" ")}` : parts.join(" ")
  return stripControlChars(line)
}
