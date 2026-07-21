import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type PlayerRole, type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import App, { type AppClient } from "../App"
import { SPINNER_FRAMES } from "../components/Spinner"

// Same MockClient shape as the sibling keeper tests: the admin_* methods this screen
// actually drives are spied (call counts + captured args) and push() injects
// admin_rules / admin_generated like the wire.
class MockClient implements AppClient {
  connectCalls: string[] = []
  joinCalls: Array<[string, string | undefined]> = []
  sent: string[] = []
  closed = 0
  listRulesCalls = 0
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
  adminListModels(_provider?: string, _apiKey?: string, _baseUrl?: string): void {}
  adminListKeys(): void {}
  adminMintKey(_room: string, _name?: string, _role?: PlayerRole): void {}
  adminUpdateKey(_id: string, _room?: string, _name?: string, _role?: PlayerRole): void {}
  adminDeleteKey(_id: string): void {}
  adminDeleteRoom(_room: string): void {}
  adminExportRoom(_room: string, _path?: string): void {}
  adminImportRoom(_path: string, _room?: string): void {}
  adminDeleteRoomData(_room: string, _backup?: boolean, _path?: string): void {}
  adminResetRoom(_room: string): void {}
  adminListSkills(): void {}
  adminEnableSkill(_id: string, _on: boolean): void {}
  adminListRules(): void {
    this.listRulesCalls += 1
  }
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

function renderApp(client: MockClient) {
  return testRender(<App client={client} prefill={{}} />, { width: 110, height: 40 })
}

const CLICK_X = 6

// From a keeper welcome, click the "规则系统" menu row to mount KeeperRules.
async function enterKeeperRules(harness: Awaited<ReturnType<typeof renderApp>>) {
  const menu = await harness.waitForFrame((t) => t.includes("规则系统"))
  const rowY = menu.split("\n").findIndex((line) => line.includes("规则系统"))
  expect(rowY).toBeGreaterThan(0)
  await act(async () => {
    await harness.mockMouse.click(CLICK_X, rowY)
  })
  await harness.flush()
}

function rulesFrame(): ServerFrame {
  return {
    type: FrameType.AdminRules,
    systems: [
      { id: "coc7", built_in: true },
      { id: "dnd5e", built_in: true },
      { id: "pulp-adventure", built_in: false },
    ],
  }
}

describe("KeeperRules", () => {
  test("挂载即请求 adminListRules;收到 admin_rules 渲染系统列表及 built-in/custom 标签", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperRules(harness)

    expect(client.listRulesCalls).toBeGreaterThan(0)

    act(() => client.push(rulesFrame()))
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("pulp-adventure"))
    expect(frame).toContain("coc7")
    expect(frame).toContain("dnd5e")
    expect(frame).toContain("pulp-adventure")
    expect(frame).toContain("内置")
    expect(frame).toContain("自定义")

    act(() => harness.renderer.destroy())
  })

  test("描述生成规则系统:填描述 + 点击生成按钮,adminGenerate 收到 (\"rule\", 描述);admin_generated 展示结果并重新拉取列表", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperRules(harness)

    act(() => client.push(rulesFrame()))
    await harness.flush()

    await harness.waitForFrame((t) => t.includes("⚄ 生成规则系统"))
    // The list is focused on mount: Tab once to reach the description <input>
    // (mirrors the sibling keeper screens' Tab-to-focus-then-type pattern).
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("一个带血气值和幸运点的通俗冒险系统")
    })
    await harness.flush()

    const buttonFrame = await harness.waitForFrame((t) => t.includes("⚄ 生成规则系统"))
    const buttonY = buttonFrame.split("\n").findIndex((line) => line.includes("⚄ 生成规则系统"))
    expect(buttonY).toBeGreaterThan(0)
    const listCallsBefore = client.listRulesCalls
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.generateCalls).toContainEqual(["rule", "一个带血气值和幸运点的通俗冒险系统"])

    // An ANIMATED spinner shows while awaiting the (slow, LLM-backed) reply.
    const pendingFrame = await harness.waitForFrame((t) => t.includes("正在撰写规则系统"))
    expect(SPINNER_FRAMES.some((glyph) => pendingFrame.includes(glyph))).toBe(true)

    act(() =>
      client.push({
        type: FrameType.AdminGenerated,
        kind: "rule",
        ok: true,
        id: "pulp-adventure",
        name: "pulp-adventure",
        error: "",
        detail: "",
      }),
    )
    await harness.flush()

    const done = await harness.waitForFrame((t) => t.includes("pulp-adventure"))
    expect(done).toContain("pulp-adventure")
    // The new rule system only shows up once the list is re-requested.
    expect(client.listRulesCalls).toBeGreaterThan(listCallsBefore)

    act(() => harness.renderer.destroy())
  })

  test("生成失败:admin_generated ok=false 时展示 error", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperRules(harness)

    await harness.waitForFrame((t) => t.includes("⚄ 生成规则系统"))
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("坏描述")
    })
    await harness.flush()

    const buttonFrame = await harness.waitForFrame((t) => t.includes("⚄ 生成规则系统"))
    const buttonY = buttonFrame.split("\n").findIndex((line) => line.includes("⚄ 生成规则系统"))
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    act(() =>
      client.push({
        type: FrameType.AdminGenerated,
        kind: "rule",
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
