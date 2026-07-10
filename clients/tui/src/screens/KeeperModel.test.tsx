import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type PlayerRole, type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import App, { type AppClient } from "../App"

// Same MockClient shape as App.test.tsx, extended so the keeper admin_* methods are
// spied and push() can inject admin_config / admin_models / admin_error like the wire.
class MockClient implements AppClient {
  connectCalls: string[] = []
  joinCalls: Array<[string, string | undefined]> = []
  sent: string[] = []
  closed = 0
  getConfigCalls = 0
  listKeysCalls = 0
  setModelCalls: Array<[string, string | undefined, string | undefined, string | undefined]> = []
  setImagegenCalls: Array<
    [string, string, string | undefined, string | undefined, string | undefined]
  > = []
  listModelsCalls: Array<[string | undefined, string | undefined, string | undefined]> = []
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
  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void {
    this.setModelCalls.push([provider, chatModel, apiKey, baseUrl])
  }
  adminSetImagegen(provider: string, model: string, apiKey?: string, baseUrl?: string, size?: string): void {
    this.setImagegenCalls.push([provider, model, apiKey, baseUrl, size])
  }
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void {
    this.listModelsCalls.push([provider, apiKey, baseUrl])
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
  adminListSkills(): void {}
  adminEnableSkill(_id: string, _on: boolean): void {}
  adminListRules(): void {}
  adminGenerate(_kind: string, _description: string): void {}

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
// `anthropic` has a saved credential, so its row shows the "key saved" tag.
const CONFIG_FRAME = {
  type: FrameType.AdminConfig,
  provider: "anthropic",
  chat_model: "claude-x",
  base_url: "",
  api_key_masked: "sk-...cafe",
  providers: ["anthropic", "openai"],
  saved_providers: ["anthropic"],
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
  test("订阅 provider:当前配置显示已登录/未登录,表单隐藏 API key 并提示 .model login", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() =>
      client.push({
        type: FrameType.AdminConfig,
        provider: "supergrok",
        chat_model: "grok-4.3",
        base_url: "https://api.x.ai/v1",
        api_key_masked: "sub:2026-07-09T12:00Z",
        providers: ["openai", "supergrok", "chatgpt"],
        saved_providers: ["supergrok"],
        override_active: true,
        subscription_status: "logged_in",
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("supergrok") && t.includes("订阅已登录"))
    expect(frame).toContain("订阅已登录")
    expect(frame).toContain("grok-4.3")
    // OAuth path: no classic "API Key · sk-..." line; login is chat-side.
    expect(frame).toContain(".model login")
    expect(frame).toContain("订阅就绪")

    act(() => harness.renderer.destroy())
  })

  test("订阅未登录:当前配置显示未登录文案", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() =>
      client.push({
        type: FrameType.AdminConfig,
        provider: "chatgpt",
        chat_model: "gpt-5.4",
        base_url: "",
        api_key_masked: "",
        providers: ["chatgpt", "openai"],
        saved_providers: [],
        override_active: false,
        subscription_status: "logged_out",
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("chatgpt") && t.includes("订阅未登录"))
    expect(frame).toContain("订阅未登录")
    expect(frame).toContain(".model login")

    act(() => harness.renderer.destroy())
  })

  test("ChatGPT 兼容代理:显式 base_url 保留 API key 输入并提交新 key", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() =>
      client.push({
        type: FrameType.AdminConfig,
        provider: "chatgpt",
        chat_model: "proxy-model",
        base_url: "https://proxy.example/v1",
        api_key_masked: "sk-...proxy",
        providers: ["chatgpt", "openai"],
        saved_providers: ["chatgpt"],
        override_active: true,
        subscription_status: "",
      }),
    )
    await harness.flush()

    const proxyFrame = await harness.waitForFrame((t) => t.includes("proxy-model") && t.includes("API 密钥"))
    expect(proxyFrame).not.toContain(".model login")

    // The provider select remains first; proxy mode keeps the API-key input as the next field.
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("sk-proxy-fresh")
    })
    await harness.flush()

    const form = await harness.waitForFrame((t) => t.includes("⚄ 保存模型"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 保存模型"))
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.setModelCalls).toContainEqual(["chatgpt", "proxy-model", "sk-proxy-fresh", undefined])

    act(() => harness.renderer.destroy())
  })

  test("gpt-subscription:canonical chatgpt 凭据显示订阅就绪", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() =>
      client.push({
        type: FrameType.AdminConfig,
        provider: "gpt-subscription",
        chat_model: "gpt-5.4",
        base_url: "",
        api_key_masked: "sub:2026-07-09T12:00Z",
        providers: ["chatgpt", "gpt-subscription"],
        // The server stores both aliases' OAuth grant under canonical `chatgpt`.
        saved_providers: ["chatgpt"],
        override_active: true,
        // Compatibility shape from a server that exposes the canonical saved provider but omits
        // the newer live status; blank base_url still identifies the OAuth path.
        subscription_status: "",
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("gpt-subscription") && t.includes("订阅就绪"))
    expect(frame).not.toContain("订阅未登录")

    act(() => harness.renderer.destroy())
  })

  test("SuperGrok 生图:Tab 跳过隐藏 key,在尺寸字段回车即可保存", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() =>
      client.push({
        type: FrameType.AdminConfig,
        provider: "supergrok",
        chat_model: "grok-4.3",
        base_url: "https://api.x.ai/v1",
        api_key_masked: "sub:2026-07-09T12:00Z",
        providers: ["supergrok", "openai"],
        saved_providers: ["supergrok"],
        override_active: true,
        subscription_status: "logged_in",
        imagegen: {
          provider: "supergrok",
          // Simulate a stale URL left by a previous image provider; fixed-endpoint SuperGrok must
          // hide it and never send it back to the server.
          base_url: "https://stale-openai.example/v1",
          model: "grok-imagine-image",
          size: "1024x1024",
          api_key_masked: "",
          has_key: true,
          configured: true,
          saved_providers: [],
        },
      }),
    )
    await harness.flush()
    await harness.waitForFrame((t) => t.includes("grok-imagine-image"))

    // Visible order starts provider → model → custom → image provider. Both OAuth key inputs are
    // skipped, so three Tabs land on imageProvider.
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        harness.mockInput.pressTab()
      })
      await harness.flush()
    }
    // Provider Enter must jump directly to imageModel (the fixed base URL is hidden); the next Tab
    // must likewise skip imageBaseUrl and land on imageSize, whose Enter submits the form.
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()

    expect(client.setImagegenCalls).toContainEqual([
      "supergrok",
      "grok-imagine-image",
      undefined,
      undefined,
      "1024x1024",
    ])

    act(() => harness.renderer.destroy())
  })

  test("进入模型/配置:挂载即请求 adminGetConfig + 拉当前 provider 的模型,收到 admin_config 后填充", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    // Mounting fires the config request (mirrors AdminPanel's effect).
    expect(client.getConfigCalls).toBeGreaterThan(0)

    // The pushed config paints the current provider/model/masked key/override state...
    act(() => client.push({ ...CONFIG_FRAME }))
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("claude-x"))
    expect(frame).toContain("anthropic")
    expect(frame).toContain("claude-x")
    expect(frame).toContain("sk-...cafe")
    expect(frame).toContain("运行时生效")
    // ...and the "key saved" tag shows because anthropic is in saved_providers.
    expect(frame).toContain("已存 key")

    // Config also triggers a live model fetch for the seeded provider.
    expect(client.listModelsCalls.some((call) => call[0] === "anthropic")).toBe(true)

    act(() => harness.renderer.destroy())
  })

  test("admin_models 回填模型下拉:返回的模型 ID 出现在选择列表里", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() => client.push({ ...CONFIG_FRAME }))
    await harness.flush()
    act(() =>
      client.push({ type: FrameType.AdminModels, provider: "anthropic", models: ["claude-x", "claude-omega"] }),
    )
    await harness.flush()

    // The dropdown renders the fetched options; `claude-omega` is unique to the list.
    const frame = await harness.waitForFrame((t) => t.includes("claude-omega"))
    expect(frame).toContain("claude-omega")

    act(() => harness.renderer.destroy())
  })

  test("点击保存:adminSetModel 收到回填的 provider/model(4 参形态)", async () => {
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

    // The seeded provider + model flow straight through; no key typed → api_key undefined.
    expect(client.setModelCalls).toContainEqual(["anthropic", "claude-x", undefined, undefined])

    act(() => harness.renderer.destroy())
  })

  test("键盘切 provider:重新拉该 provider 的模型,保存时带上新 provider(模型已随切换重置)", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() => client.push({ ...CONFIG_FRAME }))
    await harness.flush()
    await harness.waitForFrame((t) => t.includes("⚄ 保存模型"))

    // The provider <select> is focused on mount: arrow down commits the next provider (onChange).
    await act(async () => {
      harness.mockInput.pressArrow("down")
    })
    await harness.flush()

    // Switching provider refetches ITS live models.
    expect(client.listModelsCalls.some((call) => call[0] === "openai")).toBe(true)

    // Save via the button: new provider flows through; model was reset by the switch → undefined.
    const form = await harness.waitForFrame((t) => t.includes("⚄ 保存模型"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 保存模型"))
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.setModelCalls).toContainEqual(["openai", undefined, undefined, undefined])

    act(() => harness.renderer.destroy())
  })

  test("填入 API key 后保存:adminSetModel 带上新 key", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperModel(harness)

    act(() => client.push({ ...CONFIG_FRAME }))
    await harness.flush()
    await harness.waitForFrame((t) => t.includes("⚄ 保存模型"))

    // Tab from the provider select to the API-key input, type a key.
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("sk-fresh-key")
    })
    await harness.flush()

    const form = await harness.waitForFrame((t) => t.includes("⚄ 保存模型"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 保存模型"))
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    // The typed key rides along on the same set-model call (provider + seeded model preserved).
    expect(client.setModelCalls).toContainEqual(["anthropic", "claude-x", "sk-fresh-key", undefined])

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
