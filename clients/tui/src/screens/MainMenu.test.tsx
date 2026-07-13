import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type StateFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { MainMenu, type MainMenuProps } from "./MainMenu"
import { themes } from "../themes"

const WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1.1",
  room: "arkham",
  you: { id: "p1", name: "Ada", role: "player" },
  locale: "en",
  server: "mock",
}

const EMPTY_STATE: StateFrame = { type: FrameType.State, party: [], initiative: [], online: 0 }

function renderMenu(overrides: Partial<MainMenuProps> = {}) {
  return testRender(
    <MainMenu
      welcome={WELCOME}
      theme={themes.lamplight}
      themeName="lamplight"
      stateFrame={EMPTY_STATE}
      onEnterGame={() => {}}
      onCharacter={() => {}}
      onSettings={() => {}}
      onKeeperKeys={() => {}}
      onKeeperModule={() => {}}
      onKeeperModel={() => {}}
      onKeeperRules={() => {}}
      onKeeperSkills={() => {}}
      {...overrides}
    />,
    { width: 110, height: 34 },
  )
}

describe("MainMenu quit", () => {
  test("renders a Quit row when onQuit is supplied, and clicking it calls onQuit", async () => {
    let quitCalls = 0
    const { renderer, flush, waitForFrame, mockMouse } = await renderMenu({ onQuit: () => (quitCalls += 1) })
    await flush()

    const frame = await waitForFrame((t) => t.includes("Quit"))
    const rowY = frame.split("\n").findIndex((line) => line.includes("Quit"))
    expect(rowY).toBeGreaterThan(0)

    await act(async () => {
      await mockMouse.click(6, rowY)
    })
    await flush()

    expect(quitCalls).toBe(1)
    act(() => renderer.destroy())
  })

  test("keyboard: arrowing down to the last item and Enter activates Quit", async () => {
    let quitCalls = 0
    const { renderer, flush, waitForFrame, mockInput } = await renderMenu({ onQuit: () => (quitCalls += 1) })
    await flush()
    await waitForFrame((t) => t.includes("Quit"))

    // Player-only items: enterGame, character, settings, quit (4 rows) — three downs lands on Quit.
    await act(async () => {
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
    })
    await flush()
    const selected = await waitForFrame((t) => t.includes("⚄ Quit"))
    expect(selected).toContain("⚄ Quit")

    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    expect(quitCalls).toBe(1)
    act(() => renderer.destroy())
  })

  test("no onQuit prop -> no Quit row rendered", async () => {
    const { renderer, flush, waitForFrame } = await renderMenu()
    await flush()

    const frame = await waitForFrame((t) => t.includes("Enter game"))
    expect(frame).not.toContain("Quit")
    act(() => renderer.destroy())
  })
})

describe("MainMenu guided demo", () => {
  test("demo Keeper gets a first-row one-key sample action", async () => {
    let starts = 0
    const welcome: WelcomeFrame = {
      ...WELCOME,
      you: { ...WELCOME.you, role: "keeper" },
      features: ["media", "demo"],
    }
    const { renderer, flush, waitForFrame, mockInput } = await renderMenu({
      welcome,
      onStartDemo: () => (starts += 1),
    })
    await flush()

    const menu = await waitForFrame((text) => text.includes("⚄ Play sample adventure"))
    expect(menu).toContain("⚄ Play sample adventure")

    await act(async () => mockInput.pressEnter())
    await flush()
    expect(starts).toBe(1)
    act(() => renderer.destroy())
  })

  test("sample action stays hidden without the server capability", async () => {
    const welcome: WelcomeFrame = { ...WELCOME, you: { ...WELCOME.you, role: "keeper" } }
    const { renderer, flush, waitForFrame } = await renderMenu({ welcome, onStartDemo: () => {} })
    await flush()

    const menu = await waitForFrame((text) => text.includes("Enter game"))
    expect(menu).not.toContain("Play sample adventure")
    act(() => renderer.destroy())
  })
})
