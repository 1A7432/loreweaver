import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { UiFrame } from "loreweaver-protocol"
import { themes } from "../themes"
import {
  badgeLine,
  clippingLines,
  imageLine,
  letterLines,
  mapPinLine,
  meterLine,
  statLine,
  titleCardLines,
  UiBlocksView,
} from "./UiBlocks"
import { UiPanel } from "./UiPanel"

const theme = themes.lamplight

describe("ui block line formatters", () => {
  test("meterLine rescales to the min..max span and clamps the fill", () => {
    expect(meterLine({ kind: "meter", label: "Fear", value: 3, min: 0, max: 10 }, 10)).toBe("Fear ▒▒▒░░░░░░░ 3/10")
    // A min offset shifts the span: 5..10 at value 5 is an empty bar, not half full.
    expect(meterLine({ kind: "meter", label: "HP", value: 5, min: 5, max: 10 })).toBe("HP ░░░░░░ 5/10")
    // Out-of-range values clamp for the fill but print as sent.
    expect(meterLine({ kind: "meter", label: "Heat", value: 15, min: 0, max: 10 })).toBe("Heat ██████ 15/10")
  })

  test("statLine renders bools as check/cross + localized yes/no, scalars as label: value", () => {
    expect(statLine({ kind: "stat", label: "Alarm", value: true })).toBe("Alarm ✓ yes")
    expect(statLine({ kind: "stat", label: "Alarm", value: false }, "zh")).toBe("Alarm ✗ 否")
    expect(statLine({ kind: "stat", label: "Doom", value: "rising" })).toBe("Doom: rising")
    expect(statLine({ kind: "stat", label: "Rations", value: 17 })).toBe("Rations: 17")
  })

  test("badgeLine brackets the label", () => {
    expect(badgeLine({ label: "Chapter 2" })).toBe("[Chapter 2]")
  })
})

describe("UiBlocksView", () => {
  test("renders every block kind; choices are a static list without interaction", async () => {
    const frame: UiFrame = {
      type: "ui",
      panel: "inline",
      blocks: [
        { kind: "badge", label: "Chapter 2", tone: "warn" },
        { kind: "divider" },
        { kind: "stat", label: "Doom", value: "rising" },
        { kind: "text", text: "The bells toll.", style: "quote" },
        { kind: "choices", prompt: "Pick", options: [{ id: "a", label: "Attack", input: ".ra fight" }] },
      ],
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <UiBlocksView frame={frame} theme={theme} locale="en" />,
      { width: 60, height: 16 },
    )
    await flush()
    const text = captureCharFrame()
    expect(text).toContain("[Chapter 2]")
    expect(text).toContain("Doom: rising")
    expect(text).toContain("The bells toll.")
    expect(text).toContain("Pick")
    expect(text).toContain("Attack")
    act(() => renderer.destroy())
  })

  test("an interactive choices select picks with Enter and hands over the option's input", async () => {
    const picked: string[] = []
    const choices: UiFrame = {
      type: "ui",
      panel: "inline",
      blocks: [
        {
          kind: "choices",
          options: [
            { id: "a", label: "Listen", input: ".ra listen" },
            { id: "b", label: "Open", input: "I open the door" },
          ],
        },
      ],
    }
    const { renderer, flush, mockInput, captureCharFrame } = await testRender(
      <UiBlocksView
        frame={choices}
        theme={theme}
        locale="en"
        interactive={{ focused: true, onPick: (input) => picked.push(input) }}
      />,
      { width: 60, height: 12 },
    )
    await flush()
    expect(captureCharFrame()).toContain("Listen")
    await act(async () => mockInput.pressArrow("down"))
    await act(async () => mockInput.pressEnter())
    expect(picked).toEqual(["I open the door"])
    act(() => renderer.destroy())
  })
})

// The shared rendering path for an imported card's hook-emitted UI: CJK labels, and
// authored option text far longer than the English fixtures above.
describe("UiBlocksView with imported-card CJK content", () => {
  const CHOICES: UiFrame = {
    type: "ui",
    panel: "inline",
    blocks: [
      { kind: "badge", label: "第二幕·雨夜", tone: "warn" },
      { kind: "meter", label: "月雅好感", value: 12, min: 0, max: 100 },
      { kind: "stat", label: "酒馆声望", value: "尚可" },
      { kind: "text", text: "檐角的雨声忽然停了。", style: "quote" },
      {
        kind: "choices",
        prompt: "你要如何应对",
        options: [
          { id: "a", label: "推门查看", input: "我推门查看" },
          { id: "b", label: "假装没听见", input: "我继续擦柜台" },
          { id: "c", label: "点亮门口的灯笼", input: "我点灯" },
          { id: "d", label: "退回后厨", input: "我退回后厨" },
        ],
      },
    ],
  }

  test("every authored option stays visible in the interactive select", async () => {
    // Regression: OpenTUI's select spends a second row per item while descriptions are
    // on, so a height of `options.length` showed only HALF an authored menu — a
    // four-way card choice rendered as two, with no hint the rest existed.
    const { renderer, flush, captureCharFrame } = await testRender(
      <UiBlocksView frame={CHOICES} theme={theme} locale="zh" interactive={{ focused: true, onPick: () => {} }} />,
      { width: 40, height: 16 },
    )
    await flush()

    const text = captureCharFrame()
    for (const label of ["推门查看", "假装没听见", "点亮门口的灯笼", "退回后厨"]) {
      expect(text).toContain(label)
    }
    expect(text).toContain("[第二幕·雨夜]")
    expect(text).toContain("月雅好感 ▒░░░░░ 12/100")
    expect(text).toContain("酒馆声望: 尚可")
    expect(text).toContain("❝ 檐角的雨声忽然停了。")

    act(() => renderer.destroy())
  })

  test("over-long CJK blocks truncate one-per-line through the real sidebar panel", async () => {
    // Mounted the way GameView mounts it (UiPanel's bordered, padded, flexShrink=0
    // box) — a bare UiBlocksView with no width owner squashes its rows together, so
    // asserting layout on one would only measure the harness.
    const width = 32
    const long: UiFrame = {
      type: "ui",
      panel: "sidebar",
      blocks: [
        { kind: "stat", label: "一个相当冗长的中文状态名", value: "同样冗长的中文取值内容" },
        { kind: "badge", label: "一个塞不进侧栏的中文徽标文本" },
        { kind: "meter", label: "同样很长的中文计量名", value: 3, min: 0, max: 10 },
        { kind: "choices", prompt: "你要如何应对", options: [{ id: "a", label: "一个长到必须截断的中文选项", input: "x" }] },
      ],
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <UiPanel regions={[long]} theme={theme} locale="zh" />,
      { width, height: 14 },
    )
    await flush()

    const lines = captureCharFrame().split("\n").filter((line) => line.trim())
    // 2 borders + title + stat + badge + meter + the choices block's prompt and its
    // one option: every block on its own line, nothing composited, nothing dropped.
    expect(lines.length).toBe(8)
    expect(lines.some((line) => line.includes("你要如何应对"))).toBe(true)
    // KNOWN LIMITATION, pinned so it cannot get worse: OpenTUI's `truncate` cuts on a
    // character boundary, so a line ending on a double-width CJK glyph can run ONE
    // column past the panel and push its right border out. Everything else fits.
    const widths = lines.map((line) => Bun.stringWidth(line))
    expect(Math.max(...widths)).toBeLessThanOrEqual(width + 1)
    expect(widths.filter((value) => value > width).length).toBeLessThanOrEqual(2)

    act(() => renderer.destroy())
  })
})

describe("image blocks (M19 item 6)", () => {
  test("imageLine falls back caption -> alt -> short hash", () => {
    const hash = "a".repeat(64)
    expect(imageLine({ kind: "image", hash, caption: "灯谱残页" }, "zh")).toBe("🖼 灯谱残页")
    expect(imageLine({ kind: "image", hash, alt: "A torn page" })).toBe("🖼 A torn page")
    expect(imageLine({ kind: "image", hash })).toBe("🖼 aaaaaaaaaaaa")
  })

  test("renders as a caption line with no fetch channel — the sidebar degradation", async () => {
    const frame: UiFrame = {
      type: "ui",
      panel: "sidebar",
      blocks: [{ kind: "image", hash: "b".repeat(64), mime: "image/png", caption: "温府画像组" }],
    }
    const { renderOnce, captureCharFrame } = await testRender(
      <UiBlocksView frame={frame} theme={theme} locale="zh" />,
    )
    await act(async () => {
      renderOnce()
    })
    expect(captureCharFrame()).toContain("温府画像组")
  })
})

describe("performance templates (M19)", () => {
  test("letter/clipping/title_card/map_pin degrade to their information as lines", () => {
    expect(letterLines({ kind: "letter", body: "戌时来。\n带灯。", from: "晚棠", date: "初二" })).toEqual([
      "│ 戌时来。",
      "│ 带灯。",
      "│ — 晚棠 · 初二",
    ])
    expect(
      clippingLines({ kind: "clipping", headline: "石埠溺毙", body: "昨夜潮退。", source: "汐浦日报" }),
    ).toEqual(["▬ 石埠溺毙", "昨夜潮退。", "— 汐浦日报"])
    expect(mapPinLine({ kind: "map_pin", hash: "a".repeat(64), label: "第七盏", x: 0.4, y: 0.625, note: "未点" }))
      .toBe("📍 第七盏 (40%, 63%) — 未点")
    expect(titleCardLines({ kind: "title_card", title: "曝灯", act: "第二幕", subtitle: "初二" })).toEqual([
      "─".repeat(24),
      "第二幕 · 曝灯",
      "初二",
      "─".repeat(24),
    ])
  })

  test("the real renderer draws a title card and a clipping", async () => {
    const frame: UiFrame = {
      type: "ui",
      panel: "inline",
      blocks: [
        { kind: "title_card", title: "曝灯", act: "第二幕" },
        { kind: "clipping", headline: "石埠溺毙", body: "昨夜潮退。", source: "汐浦日报" },
      ],
    }
    const { renderOnce, captureCharFrame } = await testRender(
      <UiBlocksView frame={frame} theme={theme} locale="zh" />,
    )
    await act(async () => {
      renderOnce()
    })
    const output = captureCharFrame()
    expect(output).toContain("第二幕 · 曝灯")
    expect(output).toContain("石埠溺毙")
    expect(output).toContain("汐浦日报")
  })
})
