import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type ConnectionStatus, type UsageState, type WelcomeFrame } from "@loreweaver/protocol"
import { HeaderBar } from "./HeaderBar"
import { themes } from "../themes"

const WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1.1",
  room: "arkham",
  you: { id: "p1", name: "Ada", role: "player" },
  locale: "en",
  server: "mock",
}

interface RenderOverrides {
  usage?: UsageState
  scene?: { name: string; focus?: string }
  clock?: { time: string; round?: number }
  online?: number
  connectionStatus?: ConnectionStatus
}

function renderHeader(overrides: RenderOverrides = {}) {
  return testRender(
    <HeaderBar
      welcome={WELCOME}
      online={overrides.online ?? 1}
      theme={themes.lamplight}
      locale="en"
      scene={overrides.scene}
      clock={overrides.clock}
      usage={overrides.usage}
      connectionStatus={overrides.connectionStatus}
    />,
    { width: 100, height: 8 },
  )
}

describe("HeaderBar", () => {
  test("(a) with a usage prop: the ctx%/cache% + fmtTokens chunks render", async () => {
    const { renderer, flush, captureCharFrame } = await renderHeader({
      usage: {
        context_tokens: 40000,
        context_window: 128000,
        input_tokens: 12000,
        output_tokens: 3400,
        cache_hit_tokens: 8000,
        cache_miss_tokens: 2000,
      },
    })
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("ctx")
    expect(frame).toContain("31%") // round(40000 / 128000 * 100)
    expect(frame).toContain("↑12.0k") // fmtTokens(12000)
    expect(frame).toContain("↓3.4k") // fmtTokens(3400)
    expect(frame).toContain("cache")
    expect(frame).toContain("80%") // round(8000 / (8000+2000) * 100)

    act(() => renderer.destroy())
  })

  test("(b) without a usage prop: no ctx/cache row renders", async () => {
    const { renderer, flush, captureCharFrame } = await renderHeader()
    await flush()

    const frame = captureCharFrame()
    expect(frame).not.toContain("ctx")
    expect(frame).not.toContain("cache")

    act(() => renderer.destroy())
  })

  test("(c) cache_hit=0 & cache_miss=0: renders an em dash, never NaN", async () => {
    const { renderer, flush, captureCharFrame } = await renderHeader({
      usage: {
        context_tokens: 0,
        context_window: 0,
        input_tokens: 500,
        output_tokens: 100,
        cache_hit_tokens: 0,
        cache_miss_tokens: 0,
      },
    })
    await flush()

    const frame = captureCharFrame()
    expect(frame).not.toContain("NaN")
    expect(frame).toContain("—")
    // context_window<=0 -> pct is null -> the whole "ctx NN%" chunk is omitted.
    expect(frame).not.toContain("ctx ")
    expect(frame).toContain("cache")

    act(() => renderer.destroy())
  })

  test("(d) scene name + in-game clock render", async () => {
    const { renderer, flush, captureCharFrame } = await renderHeader({
      scene: { name: "The Library", focus: "search the shelves" },
      clock: { time: "23:10", round: 2 },
    })
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("The Library")
    expect(frame).toContain("23:10")

    act(() => renderer.destroy())
  })

  test("falls back to the unframed-scene hint and placeholder clock when unset", async () => {
    const { renderer, flush, captureCharFrame } = await renderHeader()
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("Unframed")
    expect(frame).toContain("--:--")

    act(() => renderer.destroy())
  })

  test("(f) connectionStatus renders a single-width dot; the label shows when no count claims the line", async () => {
    // The dot is the SAME glyph for every state (color carries the state — captureCharFrame
    // can't see color), so assert the state via the LABEL, which renders when online === 0
    // (with a count, the count text takes the shared liveness line instead).
    const online = await renderHeader({ connectionStatus: "online", online: 0 })
    await online.flush()
    const onlineFrame = online.captureCharFrame()
    expect(onlineFrame).toContain("●")
    expect(onlineFrame).toContain("online")
    act(() => online.renderer.destroy())

    const reconnecting = await renderHeader({ connectionStatus: "reconnecting", online: 0 })
    await reconnecting.flush()
    expect(reconnecting.captureCharFrame()).toContain("reconnecting")
    act(() => reconnecting.renderer.destroy())

    const offline = await renderHeader({ connectionStatus: "offline", online: 0 })
    await offline.flush()
    expect(offline.captureCharFrame()).toContain("offline")
    act(() => offline.renderer.destroy())

    // With BOTH a status and a live count, the dot and the count SHARE one line (the old
    // stacked layout was a third row that collided with the row below at narrow widths).
    const both = await renderHeader({ connectionStatus: "online", online: 2 })
    await both.flush()
    const bothFrame = both.captureCharFrame()
    expect(bothFrame).toContain("● 2 online")
    act(() => both.renderer.destroy())

    const none = await renderHeader({ online: 0 })
    await none.flush()
    expect(none.captureCharFrame()).not.toContain("●")
    act(() => none.renderer.destroy())
  })
})
