import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { themes } from "../themes"
import { clippingLines, imageLine, letterLines, mapPinLine, meterLine, statLine, titleCardLines, UiBlocksView } from "./UiBlocks"

const destroy: Array<() => void> = []
afterEach(() => {
  for (const done of destroy.splice(0)) act(done)
})

describe("block lines", () => {
  test("meters, stats, images and pins as text", () => {
    expect(meterLine({ kind: "meter", label: "Fear", value: 12, min: 0, max: 10 }, 5)).toBe("Fear █████ 12/10")
    expect(statLine({ kind: "stat", label: "Lit", value: true }, "zh")).toBe("Lit ✓ 是")
    expect(statLine({ kind: "stat", label: "Age", value: 42 })).toBe("Age: 42")
    expect(imageLine({ kind: "image", hash: "abcdef0123456789" }, "en")).toBe("🖼 abcdef012345")
    expect(imageLine({ kind: "image", hash: "x", caption: "The map" })).toBe("🖼 The map")
    expect(mapPinLine({ kind: "map_pin", hash: "x", label: "Crypt", x: 0.25, y: 0.5, note: "sealed" })).toBe("📍 Crypt (25%, 50%) — sealed")
  })

  test("letters, clippings and title cards keep every part, control characters stripped", () => {
    expect(letterLines({ kind: "letter", body: "Come\nalone.\u0007", from: "M.", date: "1923" })).toEqual(["│ Come", "│ alone.", "│ — M. · 1923"])
    expect(clippingLines({ kind: "clipping", headline: "FIRE", body: "Mill burns.", source: "Gazette" })).toEqual(["▬ FIRE", "Mill burns.", "— Gazette"])
    expect(titleCardLines({ kind: "title_card", title: "The Stacks", act: "II" })[1]).toBe("II · The Stacks")
  })
})

describe("UiBlocksView", () => {
  test("draws every block; choices are a static list unless interactive", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(
      <UiBlocksView
        blocks={[
          { kind: "badge", label: "Chapter 2", tone: "warn" },
          { kind: "text", text: "It is late.", style: "quote" },
          { kind: "divider" },
          { kind: "choices", prompt: "Which door?", options: [{ id: "l", label: "Left", command: "x" }] },
        ]}
        theme={themes.lamplight}
        locale="en"
      />,
      { width: 60, height: 12 },
    )
    destroy.push(() => renderer.destroy())
    await flush()
    const frame = captureCharFrame()
    expect(frame).toContain("[Chapter 2]")
    expect(frame).toContain("❝ It is late.")
    expect(frame).toContain("Which door?")
    expect(frame).toContain("▫ Left")
    expect(frame).not.toContain("Tab: focus")
  })
})
