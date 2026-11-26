import { describe, expect, test } from "bun:test"
import { attributeLabel, attributeLines } from "./characterAttributes"

describe("attribute lines", () => {
  test("the view's labels in its order, aligned by terminal cells (CJK is two wide)", () => {
    const lines = attributeLines([
      { key: "STR", label: "STR", value: 50 },
      { key: "APP", label: "外貌", value: 65 },
      { key: "LUCK", label: "", value: "—" },
    ])
    expect(lines.map((line) => line.line)).toEqual(["STR  50", "外貌 65", "LUCK —"])
    expect(attributeLabel({ key: "X", label: " \u0007 ", value: 1 })).toBe("X")
    expect(attributeLines(undefined)).toEqual([])
  })
})
