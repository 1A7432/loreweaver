import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { UiFrame } from "loreweaver-protocol"
import { themes } from "../themes"
import { badgeLine, meterLine, statLine, UiBlocksView } from "./UiBlocks"

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
