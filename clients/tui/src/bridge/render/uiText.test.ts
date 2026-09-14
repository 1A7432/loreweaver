import { describe, expect, test } from "bun:test"
import type { UiBlock } from "loreweaver-protocol"
import { clippingLines, letterLines, renderUiBlock, renderUiBlocks } from "./uiText"

describe("uiText letter/clipping (shared with UiBlocks)", () => {
  test("letter/clipping stay the TUI line shape", () => {
    expect(letterLines({ kind: "letter", body: "戌时来。\n带灯。", from: "晚棠", date: "初二" })).toEqual([
      "│ 戌时来。",
      "│ 带灯。",
      "│ — 晚棠 · 初二",
    ])
    expect(
      clippingLines({ kind: "clipping", headline: "石埠溺毙", body: "昨夜潮退。", source: "汐浦日报" }),
    ).toEqual(["▬ 石埠溺毙", "昨夜潮退。", "— 汐浦日报"])
  })
})

describe("bridge ui degradation — all 11 block kinds", () => {
  const vectors: Array<{ name: string; block: UiBlock; lines: string[] }> = [
    { name: "meter", block: { kind: "meter", label: "Fear", value: 3, min: 0, max: 10 }, lines: ["Fear 3/10"] },
    { name: "stat", block: { kind: "stat", label: "STR", value: 60 }, lines: ["STR: 60"] },
    { name: "badge info", block: { kind: "badge", label: "ok", tone: "info" }, lines: ["[ok]"] },
    { name: "badge warn", block: { kind: "badge", label: "careful", tone: "warn" }, lines: ["![careful]"] },
    { name: "badge danger", block: { kind: "badge", label: "run", tone: "danger" }, lines: ["!![run]"] },
    { name: "text", block: { kind: "text", text: "a line" }, lines: ["a line"] },
    { name: "text quote", block: { kind: "text", text: "said the sea", style: "quote" }, lines: ["> said the sea"] },
    { name: "divider", block: { kind: "divider" }, lines: ["——"] },
    {
      name: "choices",
      block: {
        kind: "choices",
        prompt: "Do you?",
        options: [
          { id: "a", label: "Open the door", input: "I open the door" },
          { id: "b", label: "Wait", input: "I wait" },
        ],
      },
      lines: ["Do you?", "1. Open the door", "2. Wait"],
    },
    {
      name: "image",
      block: { kind: "image", hash: "abc123def456", caption: "harbor map", alt: "map" },
      lines: [],
    },
    {
      name: "letter",
      block: { kind: "letter", body: "Come at dusk.", from: "Ada", to: "Bao", date: "May 1" },
      lines: ["│ Come at dusk.", "│ → Bao · — Ada · May 1"],
    },
    {
      name: "clipping",
      block: { kind: "clipping", headline: "Fog", body: "Ships late.", source: "Port Gazette", date: "Tue" },
      lines: ["▬ Fog", "Ships late.", "— Port Gazette · Tue"],
    },
    {
      name: "map_pin",
      block: { kind: "map_pin", hash: "m".repeat(16), label: "pier", x: 0.4, y: 0.625, note: "unlit" },
      lines: [],
    },
    {
      name: "title_card",
      block: { kind: "title_card", title: "The Lamp", subtitle: "dusk", act: "Act II" },
      lines: ["Act II", "The Lamp", "dusk"],
    },
  ]

  for (const vector of vectors) {
    test(vector.name, () => {
      expect(renderUiBlock(vector.block).lines).toEqual(vector.lines)
    })
  }

  test("image and map_pin carry a media hash; caption lives on the media, not a duplicate line", () => {
    const image = renderUiBlock({ kind: "image", hash: "deadbeef", caption: "handout" })
    expect(image.lines).toEqual([])
    expect(image.media).toEqual([{ hash: "deadbeef", mime: undefined, name: "handout" }])
    const bare = renderUiBlock({ kind: "image", hash: "deadbeef" })
    expect(bare.lines).toEqual([])
    expect(bare.media[0]?.name).toBeUndefined()
    const pin = renderUiBlock({ kind: "map_pin", hash: "map1", label: "X", x: 0, y: 0 })
    expect(pin.lines).toEqual([])
    expect(pin.media[0]?.hash).toBe("map1")
    expect(pin.media[0]?.name).toContain("X")
  })

  test("a mixed frame numbers choices continuously and opens one concatenated window", () => {
    const rendered = renderUiBlocks([
      { kind: "divider" },
      { kind: "choices", options: [{ id: "a", label: "Go", input: "go" }] },
      { kind: "choices", prompt: "Next", options: [{ id: "b", label: "Stay", input: "stay" }] },
    ])
    expect(rendered.lines).toEqual(["——", "1. Go", "Next", "2. Stay"])
    expect(rendered.choices?.options.map((option) => option.input)).toEqual(["go", "stay"])
  })
})
