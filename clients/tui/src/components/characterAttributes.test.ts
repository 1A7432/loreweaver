import { describe, expect, test } from "bun:test"
import type { CharacterState } from "loreweaver-protocol"
import { attributeLabel, attributeLines } from "./characterAttributes"

function character(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    name: "Nora",
    system: "coc7",
    resources: [],
    attributes: { STR: 50, APP: 65, LUC: 40 },
    status_effects: [],
    ...overrides,
  }
}

describe("attribute lines (v2.5 attribute_labels)", () => {
  test("without labels the keys show as-is, padded to the widest key — the pre-2.5 view", () => {
    expect(attributeLines(character()).map((line) => line.line)).toEqual(["STR 50", "APP 65", "LUC 40"])
  })

  test("labels replace the keys, and padding counts terminal cells so CJK columns line up", () => {
    const lines = attributeLines(
      character({ attributes: { STR: 50, APP: 65, LUC: 40 }, attribute_labels: { STR: "力量", APP: "外貌", LUC: "幸运" } }),
    )
    expect(lines.map((line) => line.line)).toEqual(["力量 50", "外貌 65", "幸运 40"])
    // The React key is still the wire key, so the row identity never depends on locale.
    expect(lines.map((line) => line.key)).toEqual(["STR", "APP", "LUC"])
  })

  test("mixed widths align on the value column, measured in cells not string length", () => {
    const lines = attributeLines(
      character({ attributes: { STR: 50, APP: 65 }, attribute_labels: { APP: "外貌" } }),
    )
    // 外貌 is 2 characters but 4 cells: "STR" pads to 4 cells, not to 2 characters.
    expect(lines.map((line) => line.line)).toEqual(["STR  50", "外貌 65"])
    const valueColumns = lines.map((line) => Bun.stringWidth(line.line.slice(0, line.line.lastIndexOf(" ") + 1)))
    expect(new Set(valueColumns).size).toBe(1)
  })

  test("a key the map does not name falls back to the key; hostile labels are stripped", () => {
    const state = character({ attribute_labels: { APP: "外\x1b[2J貌", STR: "  " } })
    expect(attributeLabel(state, "APP")).toBe("外[2J貌")
    expect(attributeLabel(state, "STR")).toBe("STR")
    expect(attributeLabel(state, "LUC")).toBe("LUC")
    expect(attributeLabel(undefined, "LUC")).toBe("LUC")
  })
})
