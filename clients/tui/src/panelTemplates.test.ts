import { describe, expect, test } from "bun:test"
import type { ModuleVariable, PanelTemplateBlock } from "loreweaver-protocol"
import { pickPanelText, resolvePanelBlocks } from "./panelTemplates"

const VARS: ModuleVariable[] = [
  { id: "town_fear", label: "恐慌", kind: "number", value: 7 },
  { id: "mvu.clues.ash", label: "clues.ash", kind: "text", value: "cold ash" },
  { id: "mvu.clues.ring", label: "clues.ring", kind: "text", value: "a brass ring" },
]

describe("pickPanelText", () => {
  test("prefers the viewer locale, falls back to en, then any value", () => {
    expect(pickPanelText({ en: "Fear", zh: "恐慌" }, "zh")).toBe("恐慌")
    expect(pickPanelText({ en: "Fear", zh: "恐慌" }, "zh-CN")).toBe("恐慌")
    expect(pickPanelText({ en: "Fear" }, "zh")).toBe("Fear")
    expect(pickPanelText({ zh: "恐慌" }, "en")).toBe("恐慌")
    expect(pickPanelText("plain", "zh")).toBe("plain")
    expect(pickPanelText({}, "en")).toBeUndefined()
  })
})

describe("resolvePanelBlocks", () => {
  test("substitutes $var values and localizes labels", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "meter", label: { en: "Fear", zh: "恐慌" }, value: { $var: "town_fear" }, min: 0, max: 10 },
      { kind: "stat", label: { en: "Fear" }, value: { $var: "town_fear" } },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "zh")).toEqual([
      { kind: "meter", label: "恐慌", value: 7, min: 0, max: 10 },
      { kind: "stat", label: "Fear", value: 7 },
    ])
  })

  test("an unresolved $var omits the WHOLE block (fail-closed)", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "meter", label: { en: "Doom" }, value: { $var: "keeper_secret" }, min: 0, max: 10 },
      { kind: "badge", label: { $var: "keeper_secret" } },
      { kind: "text", text: { en: "still here" } },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([{ kind: "text", text: "still here" }])
    // No variables at all -> every bound block collapses.
    expect(resolvePanelBlocks(blocks, undefined, "en")).toEqual([{ kind: "text", text: "still here" }])
  })

  test("repeat expands one instance per matching variable with $leaf substitution", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        repeat: {
          prefix: "mvu.clues.",
          block: { kind: "stat", label: { $leaf: "label" }, value: { $leaf: "value" } },
        },
      },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([
      { kind: "stat", label: "clues.ash", value: "cold ash" },
      { kind: "stat", label: "clues.ring", value: "a brass ring" },
    ])
    // No matches -> no instances, no leftovers.
    expect(resolvePanelBlocks([{ repeat: { prefix: "ghost.", block: { kind: "divider" } } }], VARS)).toEqual([])
  })

  test("repeat expansion caps at 32 instances", () => {
    const many: ModuleVariable[] = Array.from({ length: 40 }, (_, index) => ({
      id: `clue.${index}`,
      label: `c${index}`,
      kind: "number",
      value: index,
    }))
    const blocks: PanelTemplateBlock[] = [
      { repeat: { prefix: "clue.", block: { kind: "badge", label: { $leaf: "label" } } } },
    ]
    expect(resolvePanelBlocks(blocks, many, "en")).toHaveLength(32)
  })

  test("invalid optional tone strips while required breakage drops the block", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "badge", label: { en: "Hot" }, tone: { $var: "town_fear" } }, // 7 is not a tone -> stripped
      { kind: "meter", label: { en: "Bad" }, value: 5, min: 10, max: 10 }, // empty span -> dropped
      { kind: "choices", options: [{ id: "a", label: { $var: "missing" }, input: "x" }] }, // no options left
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([{ kind: "badge", label: "Hot" }])
  })
})
