import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type PlayerRole, type ServerFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import App, { type AppClient } from "../App"

// Same MockClient shape as the sibling keeper tests: `sent` records the input-channel
// commands and push() injects server frames like the wire. The admin_* methods are
// present only to satisfy AppClient; this screen never calls them.
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
  adminMintKey(_room: string, _name?: string, _role?: PlayerRole): void {}

  push(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame)
  }
}

const KEEPER_WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1.1",
  room: "shuxue",
  you: { id: "k1", name: "Keeper", role: "keeper" },
  locale: "zh",
  server: "mock",
}

const PLAYER_WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1",
  room: "shuxue",
  you: { id: "p1", name: "漱雪", role: "player" },
  locale: "zh",
  server: "mock",
}

function renderApp(client: MockClient) {
  return testRender(<App client={client} prefill={{}} />, { width: 110, height: 40 })
}

// x=6 hits any full-width row (same coordinate the sibling keeper tests use).
const CLICK_X = 6

// The command is echoed back as `narrative{speaker:"player"}` and the reply as
// `narrative{speaker:"system"}` — build both like the wire does (gateway/turn.py).
function systemLine(text: string): ServerFrame {
  return { type: FrameType.Narrative, id: `sys-${Math.random()}`, speaker: "system", text, format: "plain" }
}
function playerEcho(text: string): ServerFrame {
  return { type: FrameType.Narrative, id: `p-${Math.random()}`, speaker: "player", name: "Keeper", text, format: "plain" }
}

// From a keeper welcome, click the "导入模组" menu row to mount KeeperModule. The
// findIndex runs while still on the menu, so it hits the menu item (not the screen
// title/button that only exist after the click).
async function enterKeeperModule(harness: Awaited<ReturnType<typeof renderApp>>) {
  const menu = await harness.waitForFrame((t) => t.includes("导入模组"))
  const rowY = menu.split("\n").findIndex((line) => line.includes("导入模组"))
  expect(rowY).toBeGreaterThan(0)
  await act(async () => {
    await harness.mockMouse.click(CLICK_X, rowY)
  })
  await harness.flush()
}

describe("KeeperModule", () => {
  test("导入模组仅对守秘人可见(玩家菜单里没有)", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(PLAYER_WELCOME))

    const frame = await harness.waitForFrame((t) => t.includes("进入游戏"))
    expect(frame).not.toContain("导入模组")
    expect(frame).not.toContain("守秘人")

    act(() => harness.renderer.destroy())
  })

  test("守秘人点击进入导入模组屏:显示服务端路径提示 + 提交按钮", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)

    const frame = await harness.waitForFrame((t) => t.includes("⚄ 导入模组"))
    expect(frame).toContain("⚄ 导入模组")
    expect(frame).toContain("模组文件路径")
    // The UI makes clear the path is on the SERVER (self-host; no wire upload).
    expect(frame).toContain("服务端")

    act(() => harness.renderer.destroy())
  })

  test("键盘:输入路径 + Enter 提交,sendInput 收到 .module <path> 并进入分析中", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)
    await harness.waitForFrame((t) => t.includes("⚄ 导入模组"))

    // The path <input> is focused on mount: type it, Enter submits (its onSubmit).
    await act(async () => {
      await harness.mockInput.typeText("modules/shuxue.md")
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()

    expect(client.sent).toContain(".module modules/shuxue.md")
    // While awaiting the async broadcast reply, the screen shows the pending state.
    const frame = await harness.waitForFrame((t) => t.includes("分析中"))
    expect(frame).toContain("分析中")

    act(() => harness.renderer.destroy())
  })

  test("鼠标:点击 ⚄ 导入模组 按钮提交,sendInput 收到 .module <path>", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)
    await harness.waitForFrame((t) => t.includes("⚄ 导入模组"))

    await act(async () => {
      await harness.mockInput.typeText("modules/coc.md")
    })
    await harness.flush()

    // Click the submit button (mouse path).
    const form = await harness.waitForFrame((t) => t.includes("⚄ 导入模组"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 导入模组"))
    expect(buttonY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.sent).toContain(".module modules/coc.md")

    act(() => harness.renderer.destroy())
  })

  test("推送 system 叙事回复渲染为结果;player 回声被忽略,多条进度都保留", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)
    await harness.waitForFrame((t) => t.includes("⚄ 导入模组"))

    await act(async () => {
      await harness.mockInput.typeText("modules/shuxue.md")
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()

    // The input echo comes back as speaker:"player" — it must be ignored (not shown
    // as a result), and the pending state must remain.
    act(() => client.push(playerEcho(".module modules/shuxue.md 玩家回声")))
    await harness.flush()
    const pendingFrame = await harness.waitForFrame((t) => t.includes("分析中"))
    expect(pendingFrame).toContain("分析中")
    expect(pendingFrame).not.toContain("玩家回声")

    // Two system-authored lines arrive; both stay in the short progress log and the
    // pending state clears once a reply lands.
    act(() => client.push(systemLine("📄 正在分析模组…")))
    await harness.flush()
    act(() => client.push(systemLine("✅ 模组「shuxue」分析已完成")))
    await harness.flush()

    const done = await harness.waitForFrame((t) => t.includes("分析已完成"))
    expect(done).toContain("正在分析模组")
    expect(done).toContain("模组「shuxue」分析已完成")
    expect(done).not.toContain("分析中…")

    act(() => harness.renderer.destroy())
  })

  test("空路径不发送任何命令", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)

    const form = await harness.waitForFrame((t) => t.includes("⚄ 导入模组"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 导入模组"))
    expect(buttonY).toBeGreaterThan(0)

    // Submit with an empty input via both channels — neither may send a command.
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.sent.length).toBe(0)

    act(() => harness.renderer.destroy())
  })
})
