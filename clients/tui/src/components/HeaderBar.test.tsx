import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { themes } from "../themes"
import { cacheRate, fmtTokens, HeaderBar } from "./HeaderBar"

const destroy: Array<() => void> = []
afterEach(() => {
  for (const done of destroy.splice(0)) act(done)
})

const USAGE = { last: { turn: 2, inputTokens: 2000, outputTokens: 120, cachedInputTokens: 1500, cacheWriteTokens: 0, reasoningTokens: 0, estimated: false } }

describe("HeaderBar", () => {
  test("token figures", () => {
    expect(fmtTokens(999)).toBe("999")
    expect(fmtTokens(12_345)).toBe("12.3k")
    expect(fmtTokens(4_200_000)).toBe("4.2M")
    expect(cacheRate(USAGE.last)).toBe(75)
    expect(cacheRate({ ...USAGE.last, inputTokens: 0 })).toBeNull()
  })

  test("room, scene, clock and the last turn's usage; the link state replaces the online count while it is not up", async () => {
    const scene = { name: "Harbour", focus: "", established: [], time: "dusk", clockModule: null, round: null }
    const online = await testRender(<HeaderBar room="main" scene={scene} usage={USAGE} online={3} theme={themes.lamplight} locale="en" link="online" />, { width: 130, height: 4 })
    destroy.push(() => online.renderer.destroy())
    await online.flush()
    const frame = online.captureCharFrame()
    expect(frame).toContain("joined main")
    expect(frame).toContain("Harbour ◷dusk")
    expect(frame).toContain("3 online")
    expect(frame).toContain("last turn ↑2.0k ↓120")
    expect(frame).toContain("cache 75%")

    const down = await testRender(<HeaderBar room="main" online={3} theme={themes.lamplight} locale="zh" link="reconnecting" />, { width: 130, height: 4 })
    destroy.push(() => down.renderer.destroy())
    await down.flush()
    const zh = down.captureCharFrame()
    expect(zh).toContain("重连中…")
    expect(zh).not.toContain("3 在线")
    expect(zh).toContain("未定场景")
  })
})
