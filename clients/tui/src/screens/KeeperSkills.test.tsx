import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type PlayerRole, type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import App, { type AppClient } from "../App"
import { SPINNER_FRAMES } from "../components/Spinner"

// Same MockClient shape as the sibling keeper tests: the admin_* methods this screen
// actually drives are spied (call counts + captured args) and push() injects
// admin_skills / admin_generated / admin_error like the wire.
class MockClient implements AppClient {
  connectCalls: string[] = []
  joinCalls: Array<[string, string | undefined]> = []
  sent: string[] = []
  closed = 0
  listSkillsCalls = 0
  enableSkillCalls: Array<[string, boolean]> = []
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
  adminListSkills(): void {
    this.listSkillsCalls += 1
  }
  adminEnableSkill(id: string, on: boolean): void {
    this.enableSkillCalls.push([id, on])
  }
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
  protocol: "1.1",
  room: "shuxue",
  you: { id: "p1", name: "漱雪", role: "player" },
  locale: "zh",
  server: "mock",
}

function renderApp(client: MockClient) {
  return testRender(<App client={client} prefill={{}} />, { width: 110, height: 40 })
}

const CLICK_X = 6

// From a keeper welcome, click the "技能" menu row to mount KeeperSkills.
async function enterKeeperSkills(harness: Awaited<ReturnType<typeof renderApp>>) {
  const menu = await harness.waitForFrame((t) => t.includes("技能"))
  const rowY = menu.split("\n").findIndex((line) => line.includes("技能"))
  expect(rowY).toBeGreaterThan(0)
  await act(async () => {
    await harness.mockMouse.click(CLICK_X, rowY)
  })
  await harness.flush()
}

function skillsFrame(): ServerFrame {
  return {
    type: FrameType.AdminSkills,
    skills: [
      { id: "mature-mode", name: "Mature mode", description: "Content/tone gate", content_rating: "mature", enabled: true },
      { id: "romance-relationships", name: "Romance", description: "Attraction & tension", content_rating: "mature", enabled: false },
    ],
  }
}

describe("KeeperSkills", () => {
  test("导入模组仅对守秘人可见的同款校验:玩家菜单里没有技能入口", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(PLAYER_WELCOME))

    const frame = await harness.waitForFrame((t) => t.includes("进入游戏"))
    expect(frame).not.toContain("── 守秘人 ──")

    act(() => harness.renderer.destroy())
  })

  test("挂载即请求 adminListSkills;收到 admin_skills 渲染技能列表及其启用状态", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperSkills(harness)

    expect(client.listSkillsCalls).toBeGreaterThan(0)

    act(() => client.push(skillsFrame()))
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("romance-relationships") || t.includes("Romance"))
    expect(frame).toContain("Mature mode")
    expect(frame).toContain("Romance")
    expect(frame).toContain("mature")
    // One enabled, one disabled — both tags show.
    expect(frame).toContain("[开]")
    expect(frame).toContain("[关]")

    act(() => harness.renderer.destroy())
  })

  test("点击某行切换启用:adminEnableSkill 收到 (id, !enabled)", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperSkills(harness)

    act(() => client.push(skillsFrame()))
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("Mature mode"))
    const enabledRowY = frame.split("\n").findIndex((line) => line.includes("Mature mode"))
    expect(enabledRowY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, enabledRowY)
    })
    await harness.flush()

    // mature-mode starts enabled=true -> clicking must request disabling it.
    expect(client.enableSkillCalls).toContainEqual(["mature-mode", false])

    const disabledRowY = frame.split("\n").findIndex((line) => line.includes("Romance"))
    expect(disabledRowY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, disabledRowY)
    })
    await harness.flush()

    // romance-relationships starts enabled=false -> clicking must request enabling it.
    expect(client.enableSkillCalls).toContainEqual(["romance-relationships", true])

    act(() => harness.renderer.destroy())
  })

  test("描述生成技能:填描述 + 点击生成按钮,adminGenerate 收到 (\"skill\", 描述);admin_generated 展示结果并重新拉取列表", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperSkills(harness)

    act(() => client.push(skillsFrame()))
    await harness.flush()

    await harness.waitForFrame((t) => t.includes("⚄ 生成技能"))
    // The list is focused on mount: Tab once to reach the description <input>
    // (mirrors the sibling keeper screens' Tab-to-focus-then-type pattern).
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("阴郁的生存恐怖基调")
    })
    await harness.flush()

    const buttonFrame = await harness.waitForFrame((t) => t.includes("⚄ 生成技能"))
    const buttonY = buttonFrame.split("\n").findIndex((line) => line.includes("⚄ 生成技能"))
    expect(buttonY).toBeGreaterThan(0)
    const listCallsBefore = client.listSkillsCalls
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.generateCalls).toContainEqual(["skill", "阴郁的生存恐怖基调"])

    // An ANIMATED spinner shows while awaiting the (slow, LLM-backed) reply.
    const pendingFrame = await harness.waitForFrame((t) => t.includes("正在撰写技能"))
    expect(SPINNER_FRAMES.some((glyph) => pendingFrame.includes(glyph))).toBe(true)

    act(() =>
      client.push({
        type: FrameType.AdminGenerated,
        kind: "skill",
        ok: true,
        id: "survival-horror",
        name: "Survival horror",
        error: "",
        detail: "",
      }),
    )
    await harness.flush()

    const done = await harness.waitForFrame((t) => t.includes("Survival horror"))
    expect(done).toContain("survival-horror")
    // The new skill only shows up once the list is re-requested.
    expect(client.listSkillsCalls).toBeGreaterThan(listCallsBefore)

    act(() => harness.renderer.destroy())
  })

  test("生成中后端失败(通用 error 帧):清转圈 + 显示错误,绝不卡死", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperSkills(harness)

    act(() => client.push(skillsFrame()))
    await harness.flush()

    await harness.waitForFrame((t) => t.includes("⚄ 生成技能"))
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      await harness.mockInput.typeText("任意描述")
    })
    await harness.flush()

    const buttonFrame = await harness.waitForFrame((t) => t.includes("⚄ 生成技能"))
    const buttonY = buttonFrame.split("\n").findIndex((line) => line.includes("⚄ 生成技能"))
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    // The animated spinner is up while awaiting.
    const pending = await harness.waitForFrame((t) => t.includes("正在撰写技能"))
    expect(SPINNER_FRAMES.some((glyph) => pending.includes(glyph))).toBe(true)

    // A real backend failure (LLM timeout / rate-limit / 401) comes back as a GENERIC error frame,
    // not admin_generated / admin_error. The screen must still clear the spinner + show the error.
    act(() => client.push({ type: FrameType.Error, code: "server_error", message: "KP 后端超时" }))
    await harness.flush()

    const after = await harness.waitForFrame((t) => t.includes("KP 后端超时"))
    expect(after).toContain("KP 后端超时")
    // Spinner renders null when inactive — its caption is gone, proving no stuck spinner.
    expect(after).not.toContain("正在撰写技能")

    act(() => harness.renderer.destroy())
  })

  test("描述为空时点击生成按钮不发送任何请求", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperSkills(harness)

    const form = await harness.waitForFrame((t) => t.includes("⚄ 生成技能"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 生成技能"))
    expect(buttonY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.generateCalls.length).toBe(0)

    act(() => harness.renderer.destroy())
  })
})
