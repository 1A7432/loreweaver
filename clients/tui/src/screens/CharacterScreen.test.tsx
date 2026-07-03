import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type ServerFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import App, { type AppClient } from "../App"

// Same MockClient shape as App.test.tsx: connect/join are recorded, sent input is
// captured, and push() delivers server frames like the real socket would.
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

function renderApp(client: MockClient) {
  return testRender(<App client={client} prefill={{}} />, { width: 110, height: 34 })
}

// Menu-row / button boxes stretch to fill their column's width (same layout the
// already-proven MainMenu mouse test relies on), so a click anywhere across a
// row's line hits it; x=6 mirrors App.test.tsx's own working coordinate.
const CLICK_X = 6

describe("CharacterScreen", () => {
  test("从主菜单键盘进入角色页;无角色时直接展示建卡表单", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    // Down once from "进入游戏" onto "我的角色", Enter activates it.
    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("规则系统"))
    expect(frame).toContain("规则系统")
    expect(frame).toContain("CoC 7 版")
    expect(frame).toContain("D&D 5e")
    expect(frame).toContain("建卡方式")
    expect(frame).toContain("自动掷骰")
    expect(frame).toContain("手动设置")
    expect(frame).toContain("描述生成")
    expect(frame).toContain("导入酒馆卡")
    expect(frame).toContain("姓名")
    expect(frame).toContain("⚄ 自动掷骰")
    // The old Stage-1 stub note is gone; this is real navigation now.
    expect(frame).not.toContain("即将推出")

    act(() => renderer.destroy())
  })

  test("键盘完成建卡:Tab到姓名字段输入后 Enter 发送 .coc <name>,新 state 帧到达后展示掷骰落定与角色卡", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await waitForFrame((t) => t.includes("规则系统"))

    // Tab from method -> system -> name, type a name, submit.
    await act(async () => {
      mockInput.pressTab()
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

    // The default system (index 0) is CoC; `sendInput` carries the exact
    // `.coc <name>` command the server's `cmd_make_char` expects.
    expect(client.sent).toContain(".coc 漱雪")

    // Awaiting the reply plays the dice-tumble flicker (bounded, not a spinner).
    const rolling = await waitForFrame((t) => t.includes("掷骰中"))
    expect(rolling).toContain("⚄ 掷骰中…")

    // The server replies with a refreshed `state` frame — there is no scoped
    // response, so the UI reacts to this arrival, not to a return value.
    act(() => {
      client.push({
        type: FrameType.State,
        character: {
          name: "漱雪",
          system: "CoC",
          hp: 10,
          hpmax: 10,
          mp: 10,
          mpmax: 10,
          san: 65,
          sanmax: 99,
          attributes: { STR: 60, CON: 55, SIZ: 65, DEX: 70, APP: 50, INT: 75, POW: 65, EDU: 80, LUC: 45 },
          status_effects: [],
        },
        party: [],
        initiative: [],
        online: 1,
      })
    })
    await flush()

    // The roll "lands": the new values flash in immediately (theme.success),
    // driven by the incoming character change rather than any timer.
    const landed = await waitForFrame((t) => t.includes("落定"))
    expect(landed).toContain("漱雪")
    expect(landed).toContain("STR 60")

    // After the bounded landing flourish, the screen drops back into view mode
    // showing the settled sheet via the reused CharacterPanel.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    await flush()
    const settled = await waitForFrame((t) => t.includes("重掷 / 新建"))
    expect(settled).toContain("重掷 / 新建")
    expect(settled).toContain("漱雪")
    expect(settled).toContain("STR 60")

    act(() => renderer.destroy())
  })

  test("鼠标也能进入角色页并点击建卡按钮(留空姓名发送裸命令)", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockMouse } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    const menu = await waitForFrame((t) => t.includes("我的角色"))
    const menuRowY = menu.split("\n").findIndex((line) => line.includes("我的角色"))
    expect(menuRowY).toBeGreaterThan(0)

    await act(async () => {
      await mockMouse.click(CLICK_X, menuRowY)
    })
    await flush()

    const form = await waitForFrame((t) => t.includes("⚄ 自动掷骰"))
    const buttonRowY = form.split("\n").findIndex((line) => line.includes("⚄ 自动掷骰"))
    expect(buttonRowY).toBeGreaterThan(0)

    // No system change, no typed name: clicking straight away submits the
    // default (CoC) system with a blank name, i.e. the bare `.coc` command.
    await act(async () => {
      await mockMouse.click(CLICK_X, buttonRowY)
    })
    await flush()

    expect(client.sent).toContain(".coc")

    act(() => renderer.destroy())
  })

  test("建卡屏可导入酒馆卡:路径输入 Enter 发送 .import <path> <system> pc", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await waitForFrame((t) => t.includes("建卡方式"))

    await act(async () => {
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await waitForFrame((t) => t.includes("⚄ 导入"))

    await act(async () => {
      mockInput.pressTab()
    })
    await flush()
    await act(async () => {
      await mockInput.typeText("/cards/ada.json")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    expect(client.sent).toContain(".import /cards/ada.json coc pc")
    const sent = await waitForFrame((t) => t.includes("已发送"))
    expect(sent).toContain(".import /cards/ada.json coc pc")

    await act(async () => {
      mockInput.pressEscape()
    })
    await flush()
    act(() => renderer.destroy())
  })

  test("手动建卡显示点数预算并发送 .dnd + .st 特性", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await waitForFrame((t) => t.includes("建卡方式"))

    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    await act(async () => {
      await mockInput.typeText("米拉")
    })
    await flush()
    await act(async () => {
      mockInput.pressTab()
    })
    await flush()

    const budget = await waitForFrame((t) => t.includes("点数购买 0/27"))
    expect(budget).toContain("STR 力量  8")

    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    expect(client.sent).toContain(".dnd 米拉")
    expect(client.sent).toContain(".st 力量8 敏捷8 体质8 智力8 感知8 魅力8")
    // `.dnd`/`.coc` seeds DEFAULT characteristics (deriving current HP/MP/SAN from
    // those); `.st` then overwrites the characteristics but -- being an in-play EDIT
    // -- preserves the (now stale) current vitals instead of re-deriving them. A
    // trailing finalize word re-derives current HP/MP/SAN to their maxima for the
    // manually-chosen characteristics, so the finished character isn't left with
    // default-derived vitals. Order matters: create, then set attrs, then finalize.
    expect(client.sent).toEqual([".dnd 米拉", ".st 力量8 敏捷8 体质8 智力8 感知8 魅力8", ".st 定稿"])

    await act(async () => {
      mockInput.pressEscape()
    })
    await flush()
    act(() => renderer.destroy())
  })

  test("描述生成模式发送 .genchar <system> <name> | <description>", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await waitForFrame((t) => t.includes("建卡方式"))

    await act(async () => {
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    await act(async () => {
      mockInput.pressTab()
    })
    await flush()
    await act(async () => {
      await mockInput.typeText("阿达")
    })
    await flush()
    await act(async () => {
      mockInput.pressTab()
    })
    await flush()
    await act(async () => {
      await mockInput.typeText("冷静的医生,在雾港调查失踪案")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    expect(client.sent).toContain(".genchar coc 阿达 | 冷静的医生,在雾港调查失踪案")

    await act(async () => {
      mockInput.pressEscape()
    })
    await flush()
    act(() => renderer.destroy())
  })

  test("已有角色时可微调:发送 .st 力量60 侦查70", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    // Seed an existing character before entering the screen, so it opens in
    // "view" mode (with a 微调 action) instead of the create flow.
    act(() => {
      client.push({
        type: FrameType.State,
        character: {
          name: "漱雪",
          system: "CoC",
          hp: 10,
          hpmax: 10,
          mp: 10,
          mpmax: 10,
          san: 65,
          sanmax: 99,
          attributes: { STR: 50, DEX: 50 },
          status_effects: [],
        },
        party: [],
        initiative: [],
        online: 1,
      })
    })
    await flush()

    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    const view = await waitForFrame((t) => t.includes("重掷 / 新建"))
    expect(view).toContain("微调")

    // Down onto "微调", Enter activates it.
    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    await waitForFrame((t) => t.includes("微调指令"))

    await act(async () => {
      await mockInput.typeText("力量60 侦查70")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    expect(client.sent).toContain(".st 力量60 侦查70")
    const sent = await waitForFrame((t) => t.includes("已发送"))
    expect(sent).toContain(".st 力量60 侦查70")

    act(() => renderer.destroy())
  })

  test("已有角色时删除需要两次确认并发送 .st delete", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    act(() => {
      client.push({
        type: FrameType.State,
        character: {
          name: "漱雪",
          system: "CoC",
          hp: 10,
          hpmax: 10,
          mp: 10,
          mpmax: 10,
          san: 65,
          sanmax: 99,
          attributes: { STR: 60, CON: 50, SIZ: 65, DEX: 55, APP: 45, INT: 70, POW: 65, EDU: 80, LUC: 50 },
          status_effects: [],
        },
        party: [],
        initiative: [],
        online: 1,
      })
    })
    await flush()
    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    await waitForFrame((t) => t.includes("删除当前角色"))
    await act(async () => {
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    expect(client.sent).not.toContain(".st delete")
    await waitForFrame((t) => t.includes("确认删除角色"))

    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    expect(client.sent).toContain(".st delete")

    act(() => renderer.destroy())
  })

  test("属性表和角色面板过滤内部修正键并保留核心属性对齐", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderApp(client)
    await flush()
    act(() => client.push(PLAYER_WELCOME))
    await waitForFrame((t) => t.includes("我的角色"))

    act(() => {
      client.push({
        type: FrameType.State,
        character: {
          name: "漱雪",
          system: "CoC",
          hp: 10,
          hpmax: 10,
          mp: 10,
          mpmax: 10,
          san: 65,
          sanmax: 99,
          attributes: {
            STR: 60,
            SANMAXADD: 0,
            HPMAXADD: 0,
            MPMAXADD: 0,
            IDEA: 70,
            KNOW: 80,
            DEX: 55,
            CON: 50,
            SIZ: 65,
            APP: 45,
            INT: 70,
            POW: 65,
            EDU: 80,
            LUC: 40,
          },
          status_effects: [],
        },
        party: [],
        initiative: [],
        online: 1,
      })
    })
    await flush()

    await act(async () => {
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("属性 / ATTRIBUTES"))
    expect(frame).toContain("STR 60")
    expect(frame).toContain("DEX 55")
    expect(frame).toContain("LUC 40")
    expect(frame).not.toContain("SANMAXADD")
    expect(frame).not.toContain("HPMAXADD")
    expect(frame).not.toContain("MPMAXADD")
    expect(frame).not.toContain("SANM 0")
    expect(frame).not.toContain("HPM")
    expect(frame).not.toContain("MPM")
    expect(frame).not.toContain("IDEA")
    expect(frame).not.toContain("KNOW")

    act(() => renderer.destroy())
  })
})
