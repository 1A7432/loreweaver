import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { Spinner, SPINNER_FRAMES, type SpinnerTimers } from "./Spinner"

/** A manual interval: the glyph steps only when the test calls `tick()`. */
function manualInterval(): SpinnerTimers & { tick(): void; ms: number[] } {
  const live = new Map<number, () => void>()
  const ms: number[] = []
  let seq = 0
  return {
    ms,
    setInterval: (fn, every) => {
      ms.push(every)
      live.set(++seq, fn)
      return seq
    },
    clearInterval: (id) => {
      live.delete(id as number)
    },
    tick: () => {
      for (const fn of live.values()) fn()
    },
  }
}

describe("Spinner", () => {
  test("advances its glyph over time while active", async () => {
    const timers = manualInterval()
    const { renderer, flush, captureCharFrame } = await testRender(<Spinner active label="working" timers={timers} />, {
      width: 40,
      height: 4,
    })
    await flush()

    // Before any interval tick fires, the spinner sits on its first frame.
    const initial = captureCharFrame()
    expect(initial).toContain(SPINNER_FRAMES[0]) // ⠋
    expect(initial).toContain("working")

    // Exactly one ~110ms tick of the spinner's own interval (fired by hand, so a starved
    // runner can neither skip it nor squeeze a second one in): the glyph must step once.
    expect(timers.ms).toEqual([110])
    act(() => timers.tick())
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
