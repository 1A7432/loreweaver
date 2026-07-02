import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { Spinner, SPINNER_FRAMES } from "./Spinner"

describe("Spinner", () => {
  test("advances its glyph over time while active", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(<Spinner active label="working" />, {
      width: 40,
      height: 4,
    })
    await flush()

    // Before any interval tick fires, the spinner sits on its first frame.
    const initial = captureCharFrame()
    expect(initial).toContain(SPINNER_FRAMES[0]) // ⠋
    expect(initial).toContain("working")

    // Advance past exactly one ~110ms tick (real timers, like the sibling tests):
    // the glyph must step to the next frame.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    await flush()
    const advanced = captureCharFrame()
    expect(advanced).toContain(SPINNER_FRAMES[1]) // ⠙

    act(() => renderer.destroy())
  })

  test("renders nothing while inactive (no glyph, no label)", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(<Spinner active={false} label="idle" />, {
      width: 40,
      height: 4,
    })
    await flush()

    const frame = captureCharFrame()
    expect(frame).not.toContain("idle")
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(false)

    act(() => renderer.destroy())
  })
})
