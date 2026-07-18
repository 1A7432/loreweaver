import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type PlayerRole, type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import App, { type AppClient } from "../App"
import { SPINNER_FRAMES } from "../components/Spinner"

// Same MockClient shape as the sibling keeper tests: `sent` records the input-channel
// commands and push() injects server frames like the wire. Most admin_* methods are
// present only to satisfy AppClient (this screen never calls them); `adminGenerate` is
// spied since KeeperModule now drives the describe->generate flow (Layer B.4b).
class MockClient implements AppClient {
  connectCalls: string[] = []
  joinCalls: Array<[string, string | undefined]> = []
  sent: string[] = []
  closed = 0
  generateCalls: Array<[string, string]> = []
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
  adminUpdateKey(_id: string, _room?: string, _name?: string, _role?: string): void {}
  adminDeleteKey(_id: string): void {}
  adminDeleteRoom(_room: string): void {}
  adminExportRoom(_room: string, _path?: string): void {}
  adminImportRoom(_path: string, _room?: string): void {}
  adminDeleteRoomData(_room: string, _backup?: boolean, _path?: string): void {}
  adminListSkills(): void {}
  adminEnableSkill(_id: string, _on: boolean): void {}
  adminListRules(): void {}
  adminGenerate(kind: string, description: string): void {
    this.generateCalls.push([kind, description])
  }

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

function renderApp(client: MockClient, width = 110, height = 40) {
  return testRender(<App client={client} prefill={{}} />, { width, height })
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
  test("80 columns bounds every line and completion replaces the import progress frame", async () => {
    const client = new MockClient()
    const harness = await renderApp(client, 80, 34)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)
    await harness.waitForFrame((text) => text.includes("模组文件路径"))

    act(() => client.push(systemLine("② Embedding ███████░ 正在构建一个很长但必须保持在终端边界内的进度消息")))
    await harness.flush()
    const progress = await harness.waitForFrame((text) => text.includes("Embedding"))
    expect(progress.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    act(() => client.push(systemLine("✅ 模组知识池初始化已完成（状态：ready）")))
    await harness.flush()
    const done = await harness.waitForFrame((text) => text.includes("状态：ready"))
    expect(done).not.toContain("Embedding")
    expect(done).not.toContain("███████")
    expect(done.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    act(() => harness.renderer.destroy())
  })

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
    // While awaiting the async broadcast reply, the screen shows an ANIMATED pending
    // state: the "分析中…" caption is driven by the shared spinner (glyph present).
    const frame = await harness.waitForFrame((t) => t.includes("分析中"))
    expect(frame).toContain("分析中")
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(true)

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

  test("推送 system 叙事回复渲染为结果;player 回声被忽略,完成态清除旧进度区", async () => {
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

    // A real progress line contains the deterministic progress-bar glyphs. The final
    // result replaces that region wholesale so stale pixels cannot survive underneath.
    act(() => client.push(systemLine("📄 正在分析模组… ███░")))
    await harness.flush()
    act(() => client.push(systemLine("✅ 模组「shuxue」分析已完成")))
    await harness.flush()

    const done = await harness.waitForFrame((t) => t.includes("分析已完成"))
    expect(done).not.toContain("正在分析模组")
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

  test("描述生成模组:填描述 + 点击生成按钮,adminGenerate 收到 (\"module\", 描述),admin_generated 的 detail 字段渲染出来", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)

    // The path <input> is focused by default on mount: Tab once to reach the
    // description <input> (mirrors the sibling keeper screens' pattern), then type.
    await harness.waitForFrame((t) => t.includes("⚄ 生成模组"))
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("一座渔民接连失踪的雾港小镇")
    })
    await harness.flush()

    const buttonFrame = await harness.waitForFrame((t) => t.includes("⚄ 生成模组"))
    const buttonY = buttonFrame.split("\n").findIndex((line) => line.includes("⚄ 生成模组"))
    expect(buttonY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.generateCalls).toContainEqual(["module", "一座渔民接连失踪的雾港小镇"])

    // While awaiting the reply, an ANIMATED spinner shows (never a static caption).
    const pendingFrame = await harness.waitForFrame((t) => t.includes("正在撰写模组"))
    expect(SPINNER_FRAMES.some((glyph) => pendingFrame.includes(glyph))).toBe(true)

    act(() =>
      client.push({
        type: FrameType.AdminGenerated,
        kind: "module",
        ok: true,
        id: "foggy-port",
        name: "雾港疑云",
        error: "",
        // Short enough not to line-wrap in the fixed-width test terminal (a wrap would
        // split the string across two rendered lines and break a plain substring check).
        detail: "已入库",
      }),
    )
    await harness.flush()

    // `detail` is the real per-room signal for a module — it must be surfaced
    // alongside the name, and the spinner must clear.
    const done = await harness.waitForFrame((t) => t.includes("已入库"))
    expect(done).toContain("雾港疑云")
    expect(done).toContain("已入库")
    expect(SPINNER_FRAMES.some((glyph) => done.includes(glyph))).toBe(false)

    act(() => harness.renderer.destroy())
  })

  test("描述生成模组失败:admin_generated ok=false 时展示 error", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModule(harness)

    await harness.waitForFrame((t) => t.includes("⚄ 生成模组"))
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("坏描述")
    })
    await harness.flush()

    const buttonFrame = await harness.waitForFrame((t) => t.includes("⚄ 生成模组"))
    const buttonY = buttonFrame.split("\n").findIndex((line) => line.includes("⚄ 生成模组"))
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    act(() =>
      client.push({
        type: FrameType.AdminGenerated,
        kind: "module",
        ok: false,
        id: "",
        name: "",
        error: "empty_response",
        detail: "",
      }),
    )
    await harness.flush()

    const failed = await harness.waitForFrame((t) => t.includes("empty_response"))
    expect(failed).toContain("empty_response")

    act(() => harness.renderer.destroy())
  })
})
