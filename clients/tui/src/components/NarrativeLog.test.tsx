import { describe, expect, test } from "bun:test"
import { FrameType, type DiceFrame } from "@loreweaver/protocol"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { themes } from "../themes"
import { NarrativeLog } from "./NarrativeLog"

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
