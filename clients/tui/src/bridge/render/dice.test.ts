import { describe, expect, test } from "bun:test"
import type { DiceFrame } from "loreweaver-protocol"
import { diceLine } from "./dice"

const base: DiceFrame = {
  type: "dice",
  actor: "Ada",
  kind: "roll",
  expr: "3d6+2",
  rolls: [4, 4, 1],
  total: 11,
}

describe("dice line", () => {
  test("actor, expr, total without an outcome", () => {
    expect(diceLine(base)).toBe("Ada 3d6+2 11")
  })

  test("includes the outcome label when present", () => {
    expect(
      diceLine({
        ...base,
        kind: "check",
        expr: "SpotHidden",
        outcome: { id: "regular", label: "Regular", success: true, critical: false, fumble: false, tier: 1 },
      }),
    ).toBe("Ada SpotHidden Regular 11")
  })

  test("detail extras: critical flags and opposed right", () => {
    const line = diceLine({
      ...base,
      kind: "opposed",
      outcome: { id: "regular", label: "Regular", success: true, critical: true, fumble: false, tier: 2 },
      detail: { right: { name: "Cultist", total: 40 }, critical_success: true },
    })
    expect(line).toContain("Ada")
    expect(line).toContain("Regular")
    expect(line).toContain("11")
    expect(line).toContain("critical")
    expect(line).toContain("vs Cultist 40")
  })

  test("built ONLY from public dice fields — extra keys never appear", () => {
    const sneaky = {
      ...base,
      keeper_note: "the mayor is the cultist",
      secret: "do not leak",
      detail: { secret: "mayor", right: { name: "Cultist", total: 40 } },
    } as DiceFrame
    const line = diceLine(sneaky)
    expect(line).not.toContain("mayor")
    expect(line).not.toContain("cultist")
    expect(line).not.toContain("leak")
    expect(line).toContain("vs Cultist 40")
  })
})
