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

// An imported card's MVU leaves reach a KEEPER connection flagged `hidden: true` until
// `.var expose`. The wire filter is the choke point for players, but a pack-authored
// panel template must not be able to render an un-exposed module internal as ordinary
// panel content on any screen: protocol says a variable "absent/hidden for this viewer
// omits the WHOLE block", and `repeat` expands over VISIBLE variables only.
describe("hidden imported-card leaves are fail-closed", () => {
  const KEEPER_VARS: ModuleVariable[] = [
    { id: "mvu.酒馆.声望", label: "酒馆.声望", kind: "number", value: 34 },
    { id: "mvu.内部.剧本阶段", label: "内部.剧本阶段", kind: "text", value: "第二幕", hidden: true },
    { id: "mvu.内部.真凶", label: "内部.真凶", kind: "text", value: "掌柜的兄长", hidden: true },
  ]

  test("a $var bound to a hidden leaf omits its whole block", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "stat", label: { zh: "阶段" }, value: { $var: "mvu.内部.剧本阶段" } },
      { kind: "stat", label: { zh: "声望" }, value: { $var: "mvu.酒馆.声望" } },
    ]
    // The visible leaf resolves; the hidden one drops entirely rather than rendering.
    expect(resolvePanelBlocks(blocks, KEEPER_VARS, "zh")).toEqual([{ kind: "stat", label: "声望", value: 34 }])
  })

  test("a hidden leaf cannot leak through a label, a meter bound, or a choice option", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "badge", label: { $var: "mvu.内部.真凶" } },
      { kind: "meter", label: { zh: "阶段" }, value: { $var: "mvu.内部.剧本阶段" }, min: 0, max: 10 },
      { kind: "choices", options: [{ id: "a", label: { $var: "mvu.内部.真凶" }, input: "x" }] },
      { kind: "text", text: { $var: "mvu.内部.剧本阶段" } },
    ]
    expect(resolvePanelBlocks(blocks, KEEPER_VARS, "zh")).toEqual([])
    expect(JSON.stringify(resolvePanelBlocks(blocks, KEEPER_VARS, "zh"))).not.toContain("兄长")
  })

  test("repeat expands over visible leaves only", () => {
    const blocks: PanelTemplateBlock[] = [
      { repeat: { prefix: "mvu.", block: { kind: "badge", label: { $leaf: "label" } } } },
    ]
    // Three leaves share the prefix; only the exposed one instantiates.
    expect(resolvePanelBlocks(blocks, KEEPER_VARS, "zh")).toEqual([{ kind: "badge", label: "酒馆.声望" }])
  })
})

describe("image blocks (M19 item 6)", () => {
  test("pass through content-addressed and localize caption/alt", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        kind: "image",
        hash: "c".repeat(64),
        mime: "image/png",
        size: 4096,
        caption: { en: "The Wen portraits", zh: "温府画像组" },
        alt: { en: "Three hanging scrolls" },
      },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "zh")).toEqual([
      {
        kind: "image",
        hash: "c".repeat(64),
        mime: "image/png",
        size: 4096,
        caption: "温府画像组",
        alt: "Three hanging scrolls",
      },
    ])
  })

  test("a hashless block resolves to nothing rather than a dead fetch", () => {
    expect(resolvePanelBlocks([{ kind: "image", hash: "" } as PanelTemplateBlock], VARS, "en")).toEqual([])
  })

  test("survives a repeat template without a caption", () => {
    const blocks: PanelTemplateBlock[] = [{ kind: "image", hash: "d".repeat(64), mime: "image/png", size: 1 }]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([
      { kind: "image", hash: "d".repeat(64), mime: "image/png", size: 1 },
    ])
  })
})
