import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { ConnectScreen, type ConnectScreenProps } from "./ConnectScreen"
import type { SavedServer } from "../connectMemory"
import { themes } from "../themes"

const SERVERS: SavedServer[] = [
  { host: "ws://a.example:8787", key: "key-a", name: "Home" },
  { host: "ws://b.example:8787", key: "key-b", name: "Away" },
]

function renderConnect(overrides: Partial<ConnectScreenProps> = {}) {
  return testRender(
    <ConnectScreen
      theme={themes.lamplight}
      defaults={{}}
      connecting={false}
      locale="en"
      savedServers={SERVERS}
      onSubmit={() => {}}
      {...overrides}
    />,
    { width: 110, height: 34 },
  )
}

describe("ConnectScreen saved-server delete", () => {
  test("a saved server row shows a delete affordance when onForgetServer is supplied", async () => {
    const { renderer, flush, waitForFrame } = await renderConnect({ onForgetServer: () => {} })
    await flush()

    const frame = await waitForFrame((t) => t.includes("Home"))
    expect(frame).toContain("Home")
    expect(frame).toContain("✕")

    act(() => renderer.destroy())
  })

  test("no onForgetServer -> no delete affordance rendered", async () => {
    const { renderer, flush, waitForFrame } = await renderConnect()
    await flush()

    const frame = await waitForFrame((t) => t.includes("Home"))
    expect(frame).not.toContain("✕")

    act(() => renderer.destroy())
  })

  test("clicking the delete affordance calls onForgetServer with that entry, and never onSubmit", async () => {
    const forgotten: SavedServer[] = []
    const submitted: string[] = []
    const { renderer, flush, waitForFrame, mockMouse } = await renderConnect({
      onForgetServer: (entry) => forgotten.push(entry),
      onSubmit: (url) => submitted.push(url),
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("Home"))
    const lines = frame.split("\n")
    const rowY = lines.findIndex((line) => line.includes("Home"))
    expect(rowY).toBeGreaterThan(0)
    const rowX = lines[rowY].indexOf("✕")
    expect(rowX).toBeGreaterThan(0)

    await act(async () => {
      await mockMouse.click(rowX, rowY)
    })
    await flush()

    expect(forgotten).toEqual([SERVERS[0]])
    // The row's own click-to-fill (pickServer) must NOT also fire, and onSubmit is
    // never invoked merely by clicking on the row.
    expect(submitted).toEqual([])

    act(() => renderer.destroy())
  })

  test("clicking the row body (not the ✕) still fills the form, unaffected by the delete control", async () => {
    const forgotten: SavedServer[] = []
    const { renderer, flush, waitForFrame, mockMouse } = await renderConnect({
      onForgetServer: (entry) => forgotten.push(entry),
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("Home"))
    const lines = frame.split("\n")
    const rowY = lines.findIndex((line) => line.includes("Home"))
    const dotX = lines[rowY].indexOf("·")
    expect(dotX).toBeGreaterThanOrEqual(0)

    await act(async () => {
      await mockMouse.click(dotX, rowY)
    })
    await flush()

    expect(forgotten).toEqual([])
    const filled = await waitForFrame((t) => t.includes("key-a"))
    expect(filled).toContain("key-a")

    act(() => renderer.destroy())
  })
})

describe("ConnectScreen quit", () => {
  test("renders a Quit button when onQuit is supplied, and clicking it calls onQuit", async () => {
    let quitCalls = 0
    const { renderer, flush, waitForFrame, mockMouse } = await renderConnect({ onQuit: () => (quitCalls += 1) })
    await flush()

    const frame = await waitForFrame((t) => t.includes("Quit"))
    const lines = frame.split("\n")
    const rowY = lines.findIndex((line) => line.includes("Quit"))
    const rowX = lines[rowY].indexOf("Quit")
    expect(rowY).toBeGreaterThan(0)

    await act(async () => {
      await mockMouse.click(rowX, rowY)
    })
    await flush()

    expect(quitCalls).toBe(1)
    act(() => renderer.destroy())
  })

  test("no onQuit prop -> no Quit button rendered", async () => {
    const { renderer, flush, waitForFrame } = await renderConnect()
    await flush()

    const frame = await waitForFrame((t) => t.includes("Connect") || t.includes("连接"))
    expect(frame).not.toContain("Quit")
    act(() => renderer.destroy())
  })
})
