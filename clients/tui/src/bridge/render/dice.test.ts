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
    expect(diceLine(base, "en")).toBe("🎲 Ada 3d6+2 = 11")
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
    ).toBe("🎲 Ada SpotHidden = 11 Regular")
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

  test("a check reads roll/target; a subsystem shows its loss, the cap, and what remains", () => {
    const check = { ...base, kind: "check" as const, expr: "侦查", rolls: [50], total: 50, target: 50, effective_target: 50,
      outcome: { id: "regular", label: "成功", success: true, critical: false, fumble: false, tier: 1 } }
    expect(diceLine(check, "zh")).toBe("🎲 Ada 侦查 50/50 成功")
    const hard = { ...check, effective_target: 25, outcome: { ...check.outcome, label: "失败", success: false } }
    expect(diceLine(hard, "zh")).toBe("🎲 Ada 侦查 50/25 失败")
    const capped = { ...check, kind: "subsystem" as const, expr: "理智", total: 88, target: 45, effective_target: 45,
      outcome: { ...check.outcome, label: "失败", success: false }, detail: { loss: 0, loss_ceiling: 0, remaining: 45, loss_expr: "1d6" } }
    expect(diceLine(capped, "zh")).toBe("🎲 Ada 理智 88/45 失败 损失 0（封顶 0） → 余 45")
    const plain = { ...capped, detail: { loss: 3, remaining: 42 } }
    expect(diceLine(plain, "zh")).toBe("🎲 Ada 理智 88/45 失败 损失 3 → 余 42")
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
