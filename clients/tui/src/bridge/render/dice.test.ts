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
    expect(diceLine(base, "en")).toBe("Ada 3d6+2 11")
  })

  test("includes the outcome label when present", () => {
    expect(
      diceLine(
        {
          ...base,
          kind: "check",
          expr: "SpotHidden",
          outcome: { id: "regular", label: "Regular", success: true, critical: false, fumble: false, tier: 1 },
        },
        "en",
      ),
    ).toBe("Ada SpotHidden Regular 11")
  })

  test("detail extras: critical flags, opposed right, and winner — localized", () => {
    const frame = {
      ...base,
      kind: "opposed" as const,
      outcome: { id: "regular", label: "Regular", success: true, critical: true, fumble: false, tier: 2 },
      detail: { right: { name: "Cultist", total: 40 }, critical_success: true, winner: "left" },
    }
    const en = diceLine(frame, "en")
    expect(en).toContain("critical")
    expect(en).toContain("vs Cultist 40")
    expect(en).toContain("winner left")
    const zh = diceLine(frame, "zh")
    expect(zh).toContain("大成功")
    expect(zh).toContain("对 Cultist 40")
    expect(zh).toContain("胜 左")
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
