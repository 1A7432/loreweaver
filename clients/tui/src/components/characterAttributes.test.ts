import { describe, expect, test } from "bun:test"
import { attributeLabel, attributeLines, attributeRows, MAX_PANEL_ATTRIBUTES } from "./characterAttributes"

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

  test("a panel lists the whole sheet, two to a row when both fit, and never only the first six", () => {
    const coc = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "Luck"].map((key, index) => ({ key, label: key, value: 40 + index }))
    expect(attributeRows(coc)).toEqual(["STR  40  CON  41", "SIZ  42  DEX  43", "APP  44  INT  45", "POW  46  EDU  47", "Luck 48"])
    // CJK labels are measured in cells.
    const zh = ["力量", "体质", "意志"].map((label, index) => ({ key: `K${index}`, label, value: 50 + index }))
    expect(attributeRows(zh)).toEqual(["力量 50  体质 51", "意志 52"])
    // Labels too wide to share a row: one each, all of them.
    const wide = ["Strength", "Dexterity", "Constitution"].map((label, index) => ({ key: label, label, value: 10 + index }))
    expect(attributeRows(wide)).toEqual(["Strength     10", "Dexterity    11", "Constitution 12"])
    expect(attributeRows(wide, 40)).toEqual(["Strength     10  Dexterity    11", "Constitution 12"])
    // A sheet with more than a panel lists is cut at the named cap, not silently at six.
    const many = Array.from({ length: 20 }, (_, index) => ({ key: `A${index}`, label: `A${index}`, value: index }))
    expect(attributeRows(many).join(" ").split(/\s+/).filter((word) => word.startsWith("A"))).toHaveLength(MAX_PANEL_ATTRIBUTES)
    expect(attributeRows(undefined)).toEqual([])
  })
})
