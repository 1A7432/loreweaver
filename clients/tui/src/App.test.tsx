import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import App, { type AppClient, type AppPrefill } from "./App"
import type { SavedServer } from "./connectMemory"

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
  adminUpdateKey(_id: string, _room?: string, _name?: string, _role?: string): void {}
  adminDeleteKey(_id: string): void {}
  adminDeleteRoom(_room: string): void {}
  adminExportRoom(_room: string, _path?: string): void {}
  adminImportRoom(_path: string, _room?: string): void {}
  adminDeleteRoomData(_room: string, _backup?: boolean, _path?: string): void {}
  adminListSkills(): void {}
  adminEnableSkill(_id: string, _on: boolean): void {}
  adminListRules(): void {}
  adminGenerate(_kind: string, _description: string): void {}

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

function renderApp(
  client: MockClient,
  options: {
    prefill?: AppPrefill
    onRememberConnect?: (memory: Required<AppPrefill>) => void
    onForgetConnect?: (entry: NonNullable<AppPrefill["servers"]>[number]) => void
    onQuit?: () => void
  } = {},
) {
  return testRender(
    <App
      client={client}
      prefill={options.prefill ?? {}}
      onRememberConnect={options.onRememberConnect}
      onForgetConnect={options.onForgetConnect}
      onQuit={options.onQuit}
    />,
    { width: 110, height: 34 },
  )
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
    // Fields start empty; the host example is a dim ticket-shaped PLACEHOLDER, not a
    // pre-filled value the user would have to clear. The menu has not appeared yet.
    expect(frame).toContain("endpoint…")
    expect(frame).not.toContain("ws://127.0.0.1:8787")
    expect(frame).not.toContain("进入游戏")

    act(() => renderer.destroy())
  })

  test("submitting the form connects then joins with the default name", async () => {
    const client = new MockClient()
    const { renderer, flush, waitFor, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    await waitForFrame((t) => t.includes("邀请码"))

    // Type a host (the field starts empty now), Tab to the key, type it, submit with Enter.
    await act(async () => {
      await mockInput.typeText("ws://127.0.0.1:8787")
    })
    await flush()
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

    // connect(url) is awaited before join(key,name); the default NAME still applies.
    await waitFor(() => client.connectCalls.length > 0)
    expect(client.connectCalls[0]).toBe("ws://127.0.0.1:8787")
    await waitFor(() => client.joinCalls.length > 0)
    expect(client.joinCalls[0]).toEqual(["sekret", "调查员"])

    act(() => renderer.destroy())
  })

  test("remembers the last successful host, key, and name after welcome", async () => {
    const client = new MockClient()
    const remembered: Array<Required<AppPrefill>> = []
    const { renderer, flush, waitFor, waitForFrame, mockInput } = await renderApp(client, {
      prefill: { host: "ws://table.example:8787", name: "" },
      onRememberConnect: (memory) => remembered.push(memory),
    })
    await flush()
    await waitForFrame((t) => t.includes("邀请码"))

    await act(async () => {
      mockInput.pressTab()
    })
    await flush()
    await act(async () => {
      await mockInput.typeText("keeper-key")
    })
    await flush()
    await act(async () => {
      mockInput.pressTab()
    })
    await flush()
    await act(async () => {
      await mockInput.typeText("漱雪")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await waitFor(() => client.joinCalls.length > 0)

    expect(remembered).toEqual([])
    act(() => client.push(PLAYER_WELCOME))
    await waitFor(() => remembered.length > 0)
    expect(remembered[0]).toEqual({ host: "ws://table.example:8787", key: "keeper-key", name: "漱雪", locale: "zh" })

    act(() => renderer.destroy())
  })

  test("does not remember a rejected key", async () => {
    const client = new MockClient()
    const remembered: Array<Required<AppPrefill>> = []
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client, {
      onRememberConnect: (memory) => remembered.push(memory),
    })
    await flush()
    await waitForFrame((t) => t.includes("邀请码"))

    await act(async () => {
      mockInput.pressTab()
      await mockInput.typeText("bad-key")
      mockInput.pressEnter()
    })
    await flush()

    act(() => client.push({ type: FrameType.Error, code: "bad_key", message: "Unknown key" }))
    await waitForFrame((t) => t.includes("Unknown key"))
    expect(remembered).toEqual([])

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

  test("join-time history replayed while on the menu is shown once the game view opens", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("进入游戏"))

    // The server replays prior room history right after `welcome` — while the
    // player is still on the menu, before GameView has mounted. Without shell-level
    // accumulation these frames would be dropped (the original bug).
    act(() =>
      client.push({ type: FrameType.Narrative, speaker: "kp", text: "雪原上风声呼啸。", fmt: "markdown" } as ServerFrame),
    )
    await flush()

    // Enter the game (Enter activates the first menu item, "进入游戏").
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    // The replayed narrative is present in the game log, not lost in the transition.
    const game = await waitForFrame((t) => t.includes("雪原上风声呼啸"))
    expect(game).toContain("雪原上风声呼啸")

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

    const game = await waitForFrame((t) => t.includes("输入行动或命令"))
    expect(game).toContain("输入行动或命令")

    act(() => renderer.destroy())
  })

  test("mouse hover selects and click activates a menu item", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockMouse } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))

    // Locate the row for "设置" (its screen row = its line index in the frame).
    // ("我的角色" navigates to the character screen — covered by
    // screens/CharacterScreen.test.tsx — so this generic hover/click-mechanics test
    // uses the "设置" item, which now opens the settings screen.)
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

    // Clicking the row activates it (onMouseDown) -> navigates to the settings screen.
    await act(async () => {
      await mockMouse.click(6, rowY)
    })
    await flush()
    const clicked = await waitForFrame((t) => t.includes("主题"))
    expect(clicked).toContain("主题")

    act(() => renderer.destroy())
  })

  test("deleting a saved server updates the connect screen live and persists via onForgetConnect", async () => {
    const client = new MockClient()
    const servers: SavedServer[] = [
      { host: "endpoint-aaa", key: "key-a", name: "Home" },
      { host: "endpoint-bbb", key: "key-b", name: "Away" },
    ]
    const forgotten: SavedServer[] = []
    const { renderer, flush, waitForFrame, mockMouse } = await renderApp(client, {
      prefill: { servers },
      onForgetConnect: (entry) => forgotten.push(entry),
    })
    await flush()

    let frame = await waitForFrame((t) => t.includes("Home") && t.includes("Away"))
    const rowY = frame.split("\n").findIndex((line) => line.includes("Home"))
    const rowX = frame.split("\n")[rowY].indexOf("✕")
    expect(rowX).toBeGreaterThan(0)

    await act(async () => {
      await mockMouse.click(rowX, rowY)
    })
    await flush()

    // The row disappears from the live UI, "Away" stays, and the delete did NOT also
    // trigger the row's click-to-fill (the key input would show "key-a" if pickServer
    // had also fired) or a connect attempt.
    frame = await waitForFrame((t) => t.includes("Away"))
    expect(frame).not.toContain("Home")
    expect(frame).not.toContain("key-a")
    expect(frame).toContain("Away")
    expect(client.connectCalls).toEqual([])
    expect(forgotten).toEqual([servers[0]])

    act(() => renderer.destroy())
  })

  test("Quit from the main menu tears down the client (and any onQuit callback fires)", async () => {
    const client = new MockClient()
    let quitCalls = 0
    const { renderer, flush, waitForFrame, mockMouse } = await renderApp(client, { onQuit: () => (quitCalls += 1) })
    await flush()
    act(() => client.push(PLAYER_WELCOME))

    // The connect screen ALSO has its own "退出"/Quit button (Part D.4), so wait for the
    // menu specifically first (via its unique "进入游戏" entry) before scanning for the row.
    const frame = await waitForFrame((t) => t.includes("进入游戏"))
    const rowY = frame.split("\n").findIndex((line) => line.includes("退出"))
    expect(rowY).toBeGreaterThan(0)

    await act(async () => {
      await mockMouse.click(6, rowY)
    })
    await flush()

    expect(client.closed).toBeGreaterThan(0)
    expect(quitCalls).toBe(1)

    act(() => renderer.destroy())
  })
})
