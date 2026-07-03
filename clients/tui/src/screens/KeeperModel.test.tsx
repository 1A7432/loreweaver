import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type PlayerRole, type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import App, { type AppClient } from "../App"

// Same MockClient shape as App.test.tsx, extended so the keeper admin_* methods are
// spied and push() can inject admin_config / admin_error like the wire.
class MockClient implements AppClient {
  connectCalls: string[] = []
  joinCalls: Array<[string, string | undefined]> = []
  sent: string[] = []
  closed = 0
  getConfigCalls = 0
  listKeysCalls = 0
  setModelCalls: Array<[string, string | undefined]> = []
  mintKeyCalls: Array<[string, string | undefined, PlayerRole | undefined]> = []
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
  adminGetConfig(): void {
    this.getConfigCalls += 1
  }
  adminSetModel(provider: string, chatModel?: string): void {
    this.setModelCalls.push([provider, chatModel])
  }
  adminListKeys(): void {
    this.listKeysCalls += 1
  }
  adminMintKey(room: string, name?: string, role?: PlayerRole): void {
    this.mintKeyCalls.push([room, name, role])
  }
  adminUpdateKey(_id: string, _room?: string, _name?: string, _role?: PlayerRole): void {}
  adminDeleteKey(_id: string): void {}
  adminDeleteRoom(_room: string): void {}
  adminExportRoom(_room: string, _path?: string): void {}
  adminImportRoom(_path: string, _room?: string): void {}
  adminDeleteRoomData(_room: string, _backup?: boolean, _path?: string): void {}

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

function renderApp(client: MockClient) {
  return testRender(<App client={client} prefill={{}} />, { width: 110, height: 40 })
}

const CLICK_X = 6

// A representative admin_config reply (the wire's source of truth the form re-seeds from).
const CONFIG_FRAME = {
  type: FrameType.AdminConfig,
  provider: "anthropic",
  chat_model: "claude-x",
  base_url: "",
  api_key_masked: "sk-...cafe",
  providers: ["anthropic", "openai"],
  override_active: true,
} as const

// From a keeper welcome, click the "模型 / 配置" menu row to mount KeeperModel.
async function enterKeeperModel(harness: Awaited<ReturnType<typeof renderApp>>) {
  const menu = await harness.waitForFrame((t) => t.includes("模型 / 配置"))
  const rowY = menu.split("\n").findIndex((line) => line.includes("模型 / 配置"))
  expect(rowY).toBeGreaterThan(0)
  await act(async () => {
    await harness.mockMouse.click(CLICK_X, rowY)
  })
  await harness.flush()
}

describe("KeeperModel", () => {
  test("进入模型/配置:挂载即请求 adminGetConfig,收到 admin_config 后填充当前配置", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    // Mounting fires the config request (mirrors AdminPanel's effect).
    expect(client.getConfigCalls).toBeGreaterThan(0)

    // The pushed config paints the current provider/model/masked key/override state.
    act(() => client.push({ ...CONFIG_FRAME }))
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("claude-x"))
    expect(frame).toContain("anthropic")
    expect(frame).toContain("claude-x")
    expect(frame).toContain("sk-...cafe")
    expect(frame).toContain("运行时生效")

    act(() => harness.renderer.destroy())
  })

  test("点击保存:adminSetModel 收到从 admin_config 回填的 provider/model", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() => client.push({ ...CONFIG_FRAME }))
    await harness.flush()

    const form = await harness.waitForFrame((t) => t.includes("⚄ 保存模型"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 保存模型"))
    expect(buttonY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    // The seeded provider + model flow straight through to adminSetModel.
    expect(client.setModelCalls).toContainEqual(["anthropic", "claude-x"])

    act(() => harness.renderer.destroy())
  })

  test("键盘切 provider 后保存:adminSetModel 收到新 provider", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() => client.push({ ...CONFIG_FRAME }))
    await harness.flush()
    await harness.waitForFrame((t) => t.includes("⚄ 保存模型"))

    // The provider <select> is focused on mount: arrow to the next provider, Enter
    // moves focus onto the model field, Enter there submits.
    await act(async () => {
      harness.mockInput.pressArrow("down")
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()

    expect(client.setModelCalls).toContainEqual(["openai", "claude-x"])

    act(() => harness.renderer.destroy())
  })

  test("admin_error:有 message 显示 message,无 message 回落到 code", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() => client.push({ type: FrameType.AdminError, code: "unknown_provider" }))
    await harness.flush()
    const codeFrame = await harness.waitForFrame((t) => t.includes("unknown_provider"))
    expect(codeFrame).toContain("unknown_provider")

    act(() => client.push({ type: FrameType.AdminError, code: "unknown_provider", message: "没有这个 provider:zzz" }))
    await harness.flush()
    const messageFrame = await harness.waitForFrame((t) => t.includes("没有这个 provider"))
    expect(messageFrame).toContain("没有这个 provider:zzz")

    act(() => harness.renderer.destroy())
  })
})
