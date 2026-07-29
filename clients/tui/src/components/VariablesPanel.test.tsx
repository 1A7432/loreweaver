import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { ModuleVariable } from "@loreweaver/protocol"
import { themes } from "../themes"
import { isBounded, VariablesPanel, variableLine } from "./VariablesPanel"

describe("variableLine formatting", () => {
  test("a bounded number renders label + CharacterPanel-style bar + value/max", () => {
    const suspicion: ModuleVariable = { id: "suspicion", label: "Suspicion", kind: "number", value: 3, min: 0, max: 10 }
    expect(isBounded(suspicion)).toBe(true)
    // Same glyph family + thresholds as the HP/MP/SAN bars (bar() is reused, not copied).
    expect(variableLine(suspicion, "en")).toBe("Suspicion ▒▒░░░░ 3/10")

    const full: ModuleVariable = { id: "doom", label: "Doom", kind: "number", value: 10, min: 0, max: 10 }
    expect(variableLine(full, "en")).toBe("Doom ██████ 10/10")
  })

  test("a bounded number with a nonzero min rescales the bar to the min..max span", () => {
    const heat: ModuleVariable = { id: "heat", label: "Heat", kind: "number", value: 15, min: 10, max: 20 }
    // Halfway through 10..20 must fill half the bar, not 15/20ths of it.
    expect(variableLine(heat, "en")).toBe("Heat ▓▓▓░░░ 15/20")
  })

  test("a number missing either bound is a plain one-liner, no bar", () => {
    const rations: ModuleVariable = { id: "rations", label: "Rations", kind: "number", value: 17 }
    expect(isBounded(rations)).toBe(false)
    expect(variableLine(rations, "en")).toBe("Rations: 17")
    const minOnly: ModuleVariable = { id: "depth", label: "Depth", kind: "number", value: 3, min: 0 }
    expect(isBounded(minOnly)).toBe(false)
    expect(variableLine(minOnly, "en")).toBe("Depth: 3")
  })

  test("text and enum render as label: value one-liners", () => {
    expect(variableLine({ id: "phase", label: "Phase", kind: "enum", value: "night" }, "en")).toBe("Phase: night")
    expect(variableLine({ id: "pw", label: "Password", kind: "text", value: "swordfish" }, "en")).toBe(
      "Password: swordfish",
    )
  })

  test("bool renders a check/cross + localized yes/no in both locales", () => {
    const alarm: ModuleVariable = { id: "alarm", label: "Alarm", kind: "bool", value: false }
    const armed: ModuleVariable = { id: "armed", label: "Armed", kind: "bool", value: true }
    expect(variableLine(alarm, "en")).toBe("Alarm ✗ no")
    expect(variableLine(armed, "en")).toBe("Armed ✓ yes")
    expect(variableLine(alarm, "zh")).toBe("Alarm ✗ 否")
    expect(variableLine(armed, "zh")).toBe("Armed ✓ 是")
  })

  test("strips terminal control characters from untrusted labels and values", () => {
    const hostile: ModuleVariable = {
      id: "trap",
      label: "Tr\x1b]0;PWNED\x07ap",
      kind: "text",
      value: "he\x1b[2Jre",
    }
    // Same contract as every other panel (see sanitize.ts): the ESC/BEL
    // introducers are dropped so the sequences are inert visible text at the
    // terminal — the printable remnant is kept, never an active escape.
    const line = variableLine(hostile, "en")
    expect(line).not.toContain("\x1b")
    expect(line).not.toContain("\x07")
    expect(line).toBe("Tr]0;PWNEDap: he[2Jre")
  })
})

describe("VariablesPanel rendering", () => {
  const VARIABLES: ModuleVariable[] = [
    { id: "suspicion", label: "Suspicion", kind: "number", value: 3, min: 0, max: 10 },
    { id: "alarm", label: "Alarm", kind: "bool", value: false },
    { id: "phase", label: "Phase", kind: "enum", value: "night" },
  ]

  test("renders the localized title and one line per variable, in received order", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(
      <VariablesPanel variables={VARIABLES} theme={themes.lamplight} locale="en" />,
      { width: 32, height: 8 },
    )
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("TRACKERS")
    expect(frame).toContain("Suspicion ▒▒░░░░ 3/10")
    expect(frame).toContain("Alarm ✗ no")
    expect(frame).toContain("Phase: night")
    // Received (definition) order is meaningful — never sorted.
    expect(frame.indexOf("Suspicion")).toBeLessThan(frame.indexOf("Alarm"))
    expect(frame.indexOf("Alarm")).toBeLessThan(frame.indexOf("Phase"))

    act(() => renderer.destroy())
  })

  test("renders the zh title", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(
      <VariablesPanel variables={VARIABLES} theme={themes.lamplight} locale="zh" />,
      { width: 32, height: 8 },
    )
    await flush()
    expect(captureCharFrame()).toContain("状态量")
    act(() => renderer.destroy())
  })

  test("renders nothing at all when variables are absent or empty", async () => {
    const absent = await testRender(<VariablesPanel theme={themes.lamplight} locale="en" />, {
      width: 32,
      height: 8,
    })
    await absent.flush()
    expect(absent.captureCharFrame().trim()).toBe("")
    act(() => absent.renderer.destroy())

    const empty = await testRender(<VariablesPanel variables={[]} theme={themes.lamplight} locale="en" />, {
      width: 32,
      height: 8,
    })
    await empty.flush()
    expect(empty.captureCharFrame().trim()).toBe("")
    act(() => empty.renderer.destroy())
  })

  test("long labels and values truncate to the panel width like other sidebar panels", async () => {
    const longs: ModuleVariable[] = [
      {
        id: "long-label",
        label: "An Exceedingly Verbose Tracker Label That Cannot Fit",
        kind: "number",
        value: 5,
        min: 0,
        max: 10,
      },
      {
        id: "long-value",
        label: "Note",
        kind: "text",
        value: "a value long enough to spill past the sidebar's right edge",
      },
    ]
    const { renderer, flush, captureCharFrame } = await testRender(
      <VariablesPanel variables={longs} theme={themes.lamplight} locale="en" />,
      { width: 24, height: 8 },
    )
    await flush()

    const frame = captureCharFrame()
    // Every rendered line stays inside the 24-col budget — truncated, never wrapped.
    expect(frame.split("\n").every((line) => Bun.stringWidth(line) <= 24)).toBe(true)
    // OpenTUI's `truncate` ellipsizes mid-string, keeping both the label head and
    // the line tail — so the bounded value stays readable even on a huge label.
    expect(frame).toContain("An Excee")
    expect(frame).toContain("5/10")
    expect(frame).not.toContain("Cannot Fit")
    expect(frame).not.toContain("right edge")

    act(() => renderer.destroy())
  })
})
