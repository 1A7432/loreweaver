import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { themes } from "../themes"
import { isBounded, leafLine, variableLine, VariablesPanel } from "./VariablesPanel"

const destroy: Array<() => void> = []
afterEach(() => {
  for (const done of destroy.splice(0)) act(done)
})

describe("variable lines", () => {
  test("a bounded number is a bar, a bool a check, an enum its label, anything else label: value", () => {
    expect(isBounded({ id: "a", kind: "number", label: "A", value: 1 })).toBe(false)
    expect(variableLine({ id: "d", kind: "number", label: "Dread", value: 5, min: 0, max: 10 })).toBe("Dread ▓▓▓░░░ 5/10")
    expect(variableLine({ id: "l", kind: "bool", label: "Lamp", value: false }, "en")).toBe("Lamp ✗ no")
    expect(variableLine({ id: "m", kind: "enum", label: "Mood", value: "calm", valueLabel: "平静" })).toBe("Mood: 平静")
    expect(variableLine({ id: "h", kind: "text", label: "Secret", value: "x", hidden: true })).toBe("⊘Secret: x")
  })

  test("a tree leaf is path: value, lists joined", () => {
    expect(leafLine({ path: "party.gold", value: 12 })).toBe("party.gold: 12")
    expect(leafLine({ path: "flags", value: ["a", true, null] })).toBe("flags: a, true, null")
    expect(leafLine({ path: "plot", value: "x", hidden: true })).toBe("⊘plot: x")
  })
})

describe("VariablesPanel", () => {
  test("renders both kinds in order, and nothing at all when there are none", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(
      <VariablesPanel variables={{ module: [{ id: "d", kind: "number", label: "Dread", value: 3, min: 0, max: 10 }], tree: [{ path: "weather", value: "fog" }] }} theme={themes.lamplight} locale="en" />,
      { width: 40, height: 8 },
    )
    destroy.push(() => renderer.destroy())
    await flush()
    const frame = captureCharFrame()
    expect(frame).toContain("TRACKERS")
    expect(frame.indexOf("Dread")).toBeLessThan(frame.indexOf("weather: fog"))

    const empty = await testRender(<VariablesPanel variables={{ module: [], tree: [] }} theme={themes.lamplight} />, { width: 40, height: 4 })
    destroy.push(() => empty.renderer.destroy())
    await empty.flush()
    expect(empty.captureCharFrame().trim()).toBe("")
  })
})
