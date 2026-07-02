import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type ServerFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import App, { type AppClient } from "./App"

// A mock implementing the full AppClient surface: connect/join are recorded so
// the connect flow can be asserted; push() delivers server frames like the wire.
class MockClient implements AppClient {
  connectCalls: string[] = []
  joinCalls: Array<[string, string | undefined]> = []
  sent: string[] = []
  closed = 0
  private listeners = new Set<(frame: ServerFrame) => void>()

  connect(url: string): Promise<void> {
    this.connectCalls.push(url)
    return Promise.resolve()
  }
  join(key: string, name?: string): void {
    this.joinCalls.push([key, name])
  }
  sendInput(text: string): void {
    this.sent.push(text)
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  close(): void {
    this.closed += 1
  }
  adminGetConfig(): void {}
  adminSetModel(_provider: string, _chatModel?: string): void {}
  adminListKeys(): void {}
  adminMintKey(_room: string, _name?: string, _role?: string): void {}

  push(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame)
  }
}

const PLAYER_WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1",
  room: "shuxue",
  you: { id: "p1", name: "漱雪", role: "player" },
  locale: "zh",
  server: "mock",
}

const KEEPER_WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1.1",
  room: "shuxue",
  you: { id: "k1", name: "Keeper", role: "keeper" },
  locale: "zh",
  server: "mock",
}

function renderApp(client: MockClient) {
  return testRender(<App client={client} prefill={{}} />, { width: 110, height: 34 })
}

describe("App shell", () => {
  test("opens on the connect screen with no CLI args", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderApp(client)
    await flush()

    const frame = await waitForFrame((t) => t.includes("邀请码"))
    expect(frame).toContain("主机")
    expect(frame).toContain("邀请码")
    expect(frame).toContain("昵称")
    // The default host is prefilled; the menu has not appeared yet.
    expect(frame).toContain("ws://127.0.0.1:8787")
    expect(frame).not.toContain("进入游戏")

    act(() => renderer.destroy())
  })

  test("submitting the form connects then joins with the default name", async () => {
    const client = new MockClient()
    const { renderer, flush, waitFor, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    await waitForFrame((t) => t.includes("邀请码"))

    // Tab from host -> key, type an invite key, submit with Enter.
    await act(async () => {
      mockInput.pressTab()
    })
    await flush()
    await act(async () => {
      await mockInput.typeText("sekret")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    // connect(url) is awaited before join(key,name); the default url + name apply.
    await waitFor(() => client.connectCalls.length > 0)
    expect(client.connectCalls[0]).toBe("ws://127.0.0.1:8787")
    await waitFor(() => client.joinCalls.length > 0)
    expect(client.joinCalls[0]).toEqual(["sekret", "调查员"])

    act(() => renderer.destroy())
  })

  test("a welcome frame advances the connect screen to the menu", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderApp(client)
    await flush()
    await waitForFrame((t) => t.includes("邀请码"))

    act(() => client.push(PLAYER_WELCOME))

    const frame = await waitForFrame((t) => t.includes("进入游戏"))
    expect(frame).toContain("进入游戏")
    expect(frame).toContain("牌桌「shuxue」")
    // Back on a menu, the connect form is gone.
    expect(frame).not.toContain("邀请码")

    act(() => renderer.destroy())
  })

  test("a bad_key error keeps you on the connect screen and shows the message", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderApp(client)
    await flush()
    await waitForFrame((t) => t.includes("邀请码"))

    act(() => client.push({ type: FrameType.Error, code: "bad_key", message: "Unknown key" }))

    const frame = await waitForFrame((t) => t.includes("Unknown key"))
    // Still on the connect screen; never advanced to the menu.
    expect(frame).toContain("邀请码")
    expect(frame).not.toContain("进入游戏")
    // The auto-reconnect/re-join loop was stopped.
    expect(client.closed).toBeGreaterThan(0)

    act(() => renderer.destroy())
  })

  test("keeper-only items appear only for a keeper welcome", async () => {
    const keeperClient = new MockClient()
    const keeper = await renderApp(keeperClient)
    await keeper.flush()
    act(() => keeperClient.push(KEEPER_WELCOME))
    // "房间与邀请" is keeper-menu-only; the connect subtitle also says "守秘人",
    // so key the wait on an unambiguous keeper item.
    const keeperFrame = await keeper.waitForFrame((t) => t.includes("房间与邀请"))
    expect(keeperFrame).toContain("房间与邀请")
    expect(keeperFrame).toContain("导入模组")
    expect(keeperFrame).toContain("模型 / 配置")
    act(() => keeper.renderer.destroy())

    const playerClient = new MockClient()
    const player = await renderApp(playerClient)
    await player.flush()
    act(() => playerClient.push(PLAYER_WELCOME))
    const playerFrame = await player.waitForFrame((t) => t.includes("进入游戏"))
    // The keeper section is hidden for players.
    expect(playerFrame).not.toContain("守秘人")
    expect(playerFrame).not.toContain("房间与邀请")
    act(() => player.renderer.destroy())
  })

  test("keyboard ↑↓ moves the die cursor and Enter enters the game", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))

    // The die glyph starts on the first item.
    const initial = await waitForFrame((t) => t.includes("⚄ 进入游戏"))
    expect(initial).toContain("⚄ 进入游戏")

    // Down moves the shared cursor to the second item.
    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    const moved = await waitForFrame((t) => t.includes("⚄ 我的角色"))
    expect(moved).toContain("⚄ 我的角色")

    // Up returns to the first item, Enter activates it -> the game view mounts.
    await act(async () => {
      mockInput.pressArrow("up")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    const game = await waitForFrame((t) => t.includes("say or command"))
    expect(game).toContain("say or command")

    act(() => renderer.destroy())
  })

  test("mouse hover selects and click activates a menu item", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockMouse } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))

    // Locate the row for "设置" (its screen row = its line index in the frame).
    // ("我的角色" now navigates to the character screen as of Stage 2 — that flow
    // is covered by screens/CharacterScreen.test.tsx — so this generic
    // hover/click-mechanics test uses the still-stubbed "设置" item instead.)
    const menu = await waitForFrame((t) => t.includes("设置"))
    const rowY = menu.split("\n").findIndex((line) => line.includes("设置"))
    expect(rowY).toBeGreaterThan(0)

    // Hovering the row moves the shared cursor onto it (onMouseOver).
    await act(async () => {
      await mockMouse.moveTo(6, rowY)
    })
    await flush()
    const hovered = await waitForFrame((t) => t.includes("⚄ 设置"))
    expect(hovered).toContain("⚄ 设置")

    // Clicking the row activates it (onMouseDown) -> the stub note appears.
    await act(async () => {
      await mockMouse.click(6, rowY)
    })
    await flush()
    const clicked = await waitForFrame((t) => t.includes("昵称"))
    expect(clicked).toContain("昵称")

    act(() => renderer.destroy())
  })
})
