import { describe, expect, test } from "bun:test"
import { FrameType, type DiceFrame, type NarrativeFrame } from "loreweaver-protocol"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { themes } from "../themes"
import { imagePlaceholders, NarrativeLog } from "./NarrativeLog"

describe("NarrativeLog dice lines", () => {
  test("a targetless plain roll has no synthetic failure suffix", async () => {
    const roll: DiceFrame = {
      type: FrameType.Dice,
      actor: "Goblin",
      kind: "roll",
      expr: "1d6",
      rolls: [4],
      total: 4,
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <NarrativeLog frames={[roll]} theme={themes.lamplight} />,
      { width: 80, height: 5 },
    )

    await flush()
    const frame = captureCharFrame()
    expect(frame).toContain("Goblin 1d6 4")
    expect(frame).not.toContain("->")
    expect(frame).not.toContain("FAIL")

    act(() => renderer.destroy())
  })

  test("an explicit boolean check outcome still renders its suffix", async () => {
    const check: DiceFrame = {
      type: FrameType.Dice,
      actor: "Investigator",
      kind: "check",
      expr: "1d100",
      rolls: [82],
      total: 82,
      success: false,
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <NarrativeLog frames={[check]} theme={themes.lamplight} />,
      { width: 80, height: 5 },
    )

    await flush()
    expect(captureCharFrame()).toContain("-> FAIL")

    act(() => renderer.destroy())
  })
})

// An imported SillyTavern module card's "GUI layer" reaches a terminal client as
// plain markdown: the Keeper emits CG illustrations as `![alt](https://…/图.png)`
// inside `narrative` frames. A terminal cannot fetch a remote URL, so the question
// is only how the line degrades.
describe("NarrativeLog imported-card CG images", () => {
  // A CJK filename percent-encodes to ~60 columns on its own — the exact shape that
  // spills across half a screen if a renderer ever prints the target.
  const CG_URL = `https://raw.githubusercontent.com/example-owner/example-repo/main/${encodeURIComponent("第一幕·雨夜访客")}.png`

  test("imagePlaceholders marks an image instead of leaving bare alt text", () => {
    expect(imagePlaceholders(`![月下的访客](${CG_URL})`, "zh")).toBe("[图] 月下的访客")
    expect(imagePlaceholders(`![The Visitor](${CG_URL})`, "en")).toBe("[image] The Visitor")
    // No alt at all: OpenTUI's markdown would otherwise print the hardcoded English
    // word "image" as if it were narration — i18n rule 4 says that string is ours.
    expect(imagePlaceholders(`![](${CG_URL})`, "zh")).toBe("[图]")
    expect(imagePlaceholders(`![   ](${CG_URL})`, "en")).toBe("[image]")
  })

  test("the image target never survives into the rendered line", () => {
    const marked = imagePlaceholders(`雨停了。\n\n![访客立绘](${CG_URL})\n\n她推门而入。`, "zh")
    expect(marked).not.toContain("http")
    expect(marked).not.toContain("%E7")
    expect(marked).toBe("雨停了。\n\n[图] 访客立绘\n\n她推门而入。")
  })

  test("several images on one line, and prose without images, are handled intact", () => {
    expect(imagePlaceholders(`![甲](${CG_URL}) 与 ![乙](${CG_URL})`, "zh")).toBe("[图] 甲 与 [图] 乙")
    const plain = "她推门而入，雨水顺着斗笠淌下。"
    expect(imagePlaceholders(plain, "zh")).toBe(plain)
    // A link is NOT an image — left alone (the renderer prints `label (url)`).
    expect(imagePlaceholders(`见 [地图](${CG_URL})`, "zh")).toBe(`见 [地图](${CG_URL})`)
  })

  test("fenced code keeps its literal image syntax", () => {
    const fenced = ["前言", "```md", `![原样](${CG_URL})`, "```", `![替换](${CG_URL})`].join("\n")
    const out = imagePlaceholders(fenced, "zh")
    expect(out).toContain(`![原样](${CG_URL})`)
    expect(out).toContain("[图] 替换")
  })

  test("a CG line renders as a marked placeholder, never as a spilled URL", async () => {
    const width = 60
    const cg: NarrativeFrame = {
      type: FrameType.Narrative,
      id: "n1",
      speaker: "kp",
      text: `灯下的影子拉长。\n\n![月下的第一位访客](${CG_URL})\n\n她推门而入。`,
      format: "markdown",
      // `done` false keeps MarkdownRenderable on its synchronous unstyled path; the
      // async tree-sitter pass a finished frame takes never settles in one flush.
      done: false,
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <NarrativeLog frames={[cg]} theme={themes.lamplight} locale="zh" />,
      { width, height: 14 },
    )
    await flush()

    const text = captureCharFrame()
    expect(text).toContain("[图] 月下的第一位访客")
    // The whole point: no raw URL, no percent-encoded CJK, nothing that wraps for
    // six lines. Before the placeholder the renderer dropped the URL but printed the
    // alt bare, so a CG line was indistinguishable from a sentence of narration.
    expect(text).not.toContain("http")
    expect(text).not.toContain("%E7")
    expect(text).not.toContain("githubusercontent")
    expect(text.split("\n").every((line) => Bun.stringWidth(line) <= width)).toBe(true)

    act(() => renderer.destroy())
  })
})
