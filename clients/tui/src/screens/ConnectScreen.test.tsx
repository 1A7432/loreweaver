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

function renderConnect(overrides: Partial<ConnectScreenProps> = {}, width = 110, height = 34) {
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
    { width, height },
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

  test("clicking the row body fills the form but never paints the saved invite key", async () => {
    const forgotten: SavedServer[] = []
    const submitted: Array<{ host: string; key: string }> = []
    const { renderer, flush, waitForFrame, mockMouse, mockInput } = await renderConnect({
      onForgetServer: (entry) => forgotten.push(entry),
      onSubmit: (host, key) => submitted.push({ host, key }),
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
    const filled = await waitForFrame((t) => t.includes("saved invite key (masked)"))
    expect(filled).not.toContain("key-a")
    expect(filled).toContain("••••••••••••")

    await act(async () => mockInput.pressEnter())
    await flush()
    expect(submitted).toEqual([{ host: SERVERS[0].host, key: SERVERS[0].key }])

    act(() => renderer.destroy())
  })

  test("a remembered default key is masked on first paint and still submits intact", async () => {
    const secret = "remembered-bearer-secret"
    const submitted: string[] = []
    const { renderer, flush, captureCharFrame, mockInput } = await renderConnect({
      defaults: { host: "ws://example.test", key: secret },
      savedServers: [],
      onSubmit: (_host, key) => submitted.push(key),
    })
    await flush()

    expect(captureCharFrame()).not.toContain(secret)
    expect(captureCharFrame()).toContain("saved invite key (masked)")

    await act(async () => mockInput.pressEnter())
    await flush()
    expect(submitted).toEqual([secret])

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

describe("ConnectScreen local server folder", () => {
  test("renders the current one-click server folder and persists edits", async () => {
    const changed: string[] = []
    const { renderer, flush, waitForFrame, mockInput, mockMouse } = await renderConnect({
      defaults: { localServerHome: "/tmp/loreweaver-local" },
      onHostLocal: () => {},
      onLocalServerHomeChange: (path) => changed.push(path),
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("Local server folder"))
    expect(frame).toContain("/tmp/loreweaver-local")
    const lines = frame.split("\n")
    const rowY = lines.findIndex((line) => line.includes("/tmp/loreweaver-local"))
    const rowX = lines[rowY].indexOf("/tmp/loreweaver-local")
    expect(rowY).toBeGreaterThan(0)
    expect(rowX).toBeGreaterThan(0)

    await act(async () => {
      await mockMouse.click(rowX + "/tmp/loreweaver-local".length, rowY)
      await mockInput.typeText("-2")
    })
    await flush()

    expect(changed.at(-1)).toBe("/tmp/loreweaver-local-2")
    act(() => renderer.destroy())
  })

  test("80 columns keeps the form and saved-row controls within the viewport", async () => {
    const { renderer, flush, captureCharFrame } = await renderConnect({ onForgetServer: () => {} }, 80, 24)
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("Ticket / host")
    expect(frame).toContain("Invite key")
    expect(frame).toContain("Nickname")
    expect(frame).toContain("Home")
    expect(frame).toContain("✕")
    expect(frame.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    act(() => renderer.destroy())
  })
})
