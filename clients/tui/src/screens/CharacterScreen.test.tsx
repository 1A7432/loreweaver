import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import {
  FrameType,
  PROTOCOL_VERSION,
  type CharacterState,
  type RuleSystemEntry,
  type ServerFrame,
  type WelcomeFrame,
} from "loreweaver-protocol"
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
  adminResetRoom(_room: string): void {}
  adminUpdateServer(): void {}
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
  protocol: PROTOCOL_VERSION,
  room: "shuxue",
  you: { id: "p1", name: "漱雪", role: "player" },
  locale: "zh",
  server: "mock",
}

// Shaped like the real `state` frame (protocol 2.3, `net/state.py::_rule_systems`):
// canonical pack ids, and the dot-command word only for a system whose pack declares
// one. `wod` declares none — it can be described into or imported into, never rolled.
const SYSTEMS: RuleSystemEntry[] = [
  { id: "coc7", make_char: "coc" },
  { id: "dnd5e", make_char: "dnd" },
  { id: "wod" },
]

// Attributes arrive as RAW STORAGE KEYS, vitals and derived leaves included — the
// same payload `.st <key> <n>` accepts back. Vitals ride the protocol-2.0 generic
// `resources` list, which carries its own labels.
const SHEET: CharacterState = {
  name: "漱雪",
  system: "coc7",
  resources: [
    { id: "hp", label: "HP", value: 12, max: 12 },
    { id: "mp", label: "MP", value: 13, max: 13 },
    { id: "san", label: "SAN", value: 65, max: 99 },
  ],
  attributes: {
    STR: 55,
    CON: 60,
    SIZ: 65,
    DEX: 70,
    APP: 50,
    INT: 75,
    POW: 65,
    EDU: 80,
    LUC: 45,
    HPMAX: 12,
    MPMAX: 13,
    SANMAX: 99,
    IDEA: 75,
    KNOW: 80,
    HP: 12,
    MP: 13,
    SAN: 65,
  },
  status_effects: [],
}

function stateFrame(extra: Partial<{ character: CharacterState; systems: RuleSystemEntry[] }> = {}): ServerFrame {
  const { character, systems } = { systems: SYSTEMS, ...extra }
  return {
    type: FrameType.State,
    character,
    party: [],
    initiative: [],
    online: 1,
    ...(systems ? { systems } : {}),
  }
}

function renderApp(client: MockClient, width = 110, height = 34) {
  return testRender(<App client={client} prefill={{}} />, { width, height })
}

// Menu-row / button boxes stretch to fill their column's width (same layout the
// already-proven MainMenu mouse test relies on), so a click anywhere across a
// row's line hits it; x=6 mirrors App.test.tsx's own working coordinate.
const CLICK_X = 6

/** Join the room, land a `state` frame, then keyboard-navigate into "我的角色". */
async function openCharacterScreen(client: MockClient, width = 110, height = 34, frame: ServerFrame = stateFrame()) {
  const harness = await renderApp(client, width, height)
  await harness.flush()
  act(() => client.push(PLAYER_WELCOME))
  await harness.waitForFrame((text) => text.includes("我的角色"))
  act(() => client.push(frame))
  await harness.flush()

  await act(async () => harness.mockInput.pressArrow("down"))
  await harness.flush()
  await act(async () => harness.mockInput.pressEnter())
  await harness.flush()
  return harness
}

describe("CharacterScreen system picker (protocol 2.3)", () => {
  test("the picker lists exactly the server's systems; roll mode drops the ones with no make_char word", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(client)

    // Roll mode (the default): only a system whose pack declares a make-character
    // word can be rolled, so `wod` is not offered here.
    const roll = await waitForFrame((text) => text.includes("规则系统"))
    expect(roll).toContain("coc7")
    expect(roll).toContain("dnd5e")
    expect(roll).not.toContain("wod")
    // Ids verbatim off the wire — the client invents no display names.
    expect(roll).not.toContain("CoC 7")
    expect(roll).not.toContain("D&D")
    // The manual/point-buy lane is gone: its budgets live in a pack's constraints
    // and no frame carries them.
    expect(roll).not.toContain("手动设置")

    // Description mode can target any system the server reported.
    await act(async () => mockInput.pressArrow("down"))
    await flush()
    const persona = await waitForFrame((text) => text.includes("wod"))
    expect(persona).toContain("coc7")
    expect(persona).toContain("dnd5e")
    expect(persona).toContain("wod")

    act(() => renderer.destroy())
  })

  test("a server that reports no systems gets a plain message instead of a create form", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await openCharacterScreen(
      client,
      110,
      34,
      // A pre-2.3 server: no `systems` on the frame at all.
      stateFrame({ systems: undefined as unknown as RuleSystemEntry[] }),
    )
    await flush()

    const frame = await waitForFrame((text) => text.includes("服务端没有报告任何规则系统"))
    // No method picker, no system picker, no submit button — nothing to guess with.
    expect(frame).not.toContain("建卡方式")
    expect(frame).not.toContain("自动掷骰")
    expect(frame).not.toContain("coc7")
    expect(client.sent).toEqual([])

    act(() => renderer.destroy())
  })
})

describe("CharacterScreen creation commands", () => {
  test("roll sends `.<make_char> <name>` using the picked system's own word", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(client)
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
    await act(async () => mockInput.pressEnter())
    await flush()

    // The first offered system (coc7) declares `coc`, so that is the word sent —
    // the client never spells a rule system out of its own knowledge.
    expect(client.sent).toEqual([".coc 漱雪"])

    // Awaiting the reply plays the dice-tumble flicker (bounded, not a spinner) —
    // dice glyphs only, no per-system characteristic labels.
    const rolling = await waitForFrame((t) => t.includes("掷骰中"))
    expect(rolling).toContain("漱雪…")
    // Generic dice faces, never a system's characteristic names.
    expect(rolling).not.toContain("STR")
    expect(rolling).not.toContain("力量")

    // The server replies with a refreshed `state` frame — there is no scoped
    // response, so the UI reacts to this arrival, not to a return value.
    act(() => client.push(stateFrame({ character: SHEET })))
    await flush()

    // The roll "lands": the landed sheet names its OWN attributes (storage keys off
    // the wire), which is the only place attribute names come from.
    const landed = await waitForFrame((t) => t.includes("落定"))
    expect(landed).toContain("漱雪")
    expect(landed).toContain("STR 55")

    // After the bounded landing flourish the screen drops back into view mode.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)))
    await flush()
    const settled = await waitForFrame((t) => t.includes("重掷 / 新建"))
    expect(settled).not.toContain("建卡方式")
    expect(settled).toContain("STR 55")

    act(() => renderer.destroy())
  })

  test("picking the second system rolls with ITS word, not the first one's", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(client)
    await waitForFrame((t) => t.includes("规则系统"))

    // Enter on the method select hands focus to the system picker; down = dnd5e.
    await act(async () => mockInput.pressEnter())
    await flush()
    await act(async () => mockInput.pressArrow("down"))
    await flush()
    await act(async () => mockInput.pressTab())
    await flush()
    await act(async () => {
      await mockInput.typeText("米拉")
      mockInput.pressEnter()
    })
    await flush()

    expect(client.sent).toEqual([".dnd 米拉"])

    act(() => renderer.destroy())
  })

  test("mouse click with a blank name sends the bare make-char word", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(PLAYER_WELCOME))
    const menu = await harness.waitForFrame((t) => t.includes("我的角色"))
    act(() => client.push(stateFrame()))
    await harness.flush()
    const menuRowY = menu.split("\n").findIndex((line) => line.includes("我的角色"))
    expect(menuRowY).toBeGreaterThan(0)

    await act(async () => {
      await harness.mockMouse.click(CLICK_X, menuRowY)
    })
    await harness.flush()

    const form = await harness.waitForFrame((t) => t.includes("⚄ 自动掷骰"))
    const buttonRowY = form.split("\n").findIndex((line) => line.includes("⚄ 自动掷骰"))
    expect(buttonRowY).toBeGreaterThan(0)

    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonRowY)
    })
    await harness.flush()

    expect(client.sent).toEqual([".coc"])

    act(() => harness.renderer.destroy())
  })

  test("description mode sends `.genchar <systemId> <name> | <description>`", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(client)
    await waitForFrame((t) => t.includes("建卡方式"))

    await act(async () => mockInput.pressArrow("down"))
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()

    await act(async () => mockInput.pressTab())
    await flush()
    await act(async () => {
      await mockInput.typeText("阿达")
    })
    await flush()
    await act(async () => mockInput.pressTab())
    await flush()
    await act(async () => {
      await mockInput.typeText("冷静的医生,在雾港调查失踪案")
    })
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()

    // The canonical system ID goes on the wire, not a dialect word.
    expect(client.sent).toEqual([".genchar coc7 阿达 | 冷静的医生,在雾港调查失踪案"])

    await act(async () => mockInput.pressEscape())
    await flush()
    act(() => renderer.destroy())
  })

  test("import mode sends `.import <path> <systemId> pc`", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(client)
    await waitForFrame((t) => t.includes("建卡方式"))

    await act(async () => {
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()
    await waitForFrame((t) => t.includes("⚄ 导入"))

    await act(async () => mockInput.pressTab())
    await flush()
    await act(async () => {
      await mockInput.typeText("/cards/ada.json")
    })
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()

    expect(client.sent).toEqual([".import /cards/ada.json coc7 pc"])
    const sent = await waitForFrame((t) => t.includes("已发送"))
    expect(sent).toContain(".import /cards/ada.json coc7 pc")

    await act(async () => mockInput.pressEscape())
    await flush()
    act(() => renderer.destroy())
  })

  test("80 columns gives the creation form full width and clears it when the sheet lands", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(client, 80, 24)

    const create = await waitForFrame((text) => text.includes("建卡方式") && text.includes("规则系统"))
    expect(create).not.toContain("CHARACTER")
    expect(create.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    await act(async () => {
      mockInput.pressTab()
      mockInput.pressTab()
    })
    await flush()
    await act(async () => {
      await mockInput.typeText("八十列调查员")
      mockInput.pressEnter()
    })
    await flush()

    act(() => client.push(stateFrame({ character: { ...SHEET, name: "八十列调查员" } })))
    await flush()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)))
    await flush()

    const settled = await waitForFrame((text) => text.includes("重掷 / 新建"))
    expect(settled).not.toContain("建卡方式")
    expect(settled.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    act(() => renderer.destroy())
  })
})

describe("CharacterScreen view actions", () => {
  test("微调 sends the free-text `.st <text>` exactly as typed", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(
      client,
      80,
      24,
      stateFrame({ character: SHEET }),
    )

    const view = await waitForFrame((t) => t.includes("重掷 / 新建"))
    expect(view).toContain("微调")

    await act(async () => mockInput.pressArrow("down"))
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()
    const tweak = await waitForFrame((t) => t.includes("微调指令"))
    expect(tweak).toContain("⚄ 应用")
    expect(tweak.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    await act(async () => {
      await mockInput.typeText("力量60 侦查70")
    })
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()

    expect(client.sent).toEqual([".st 力量60 侦查70"])
    const sent = await waitForFrame((t) => t.includes("已发送"))
    expect(sent).toContain(".st 力量60 侦查70")

    act(() => renderer.destroy())
  })

  test("重算 sends the canonical `.st finalize`", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(
      client,
      110,
      34,
      stateFrame({ character: SHEET }),
    )
    await waitForFrame((t) => t.includes("重掷 / 新建"))

    await act(async () => {
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()

    // The canonical word, never a locale dialect one: a client issuing the command
    // programmatically has no locale to speak.
    expect(client.sent).toEqual([".st finalize"])

    act(() => renderer.destroy())
  })

  test("delete needs a second confirmation before it sends `.st delete`", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await openCharacterScreen(
      client,
      110,
      34,
      stateFrame({ character: SHEET }),
    )
    await waitForFrame((t) => t.includes("删除当前角色"))

    await act(async () => {
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
      mockInput.pressArrow("down")
    })
    await flush()
    await act(async () => mockInput.pressEnter())
    await flush()
    expect(client.sent).not.toContain(".st delete")
    await waitForFrame((t) => t.includes("确认删除角色"))

    await act(async () => mockInput.pressEnter())
    await flush()
    expect(client.sent).toEqual([".st delete"])

    act(() => renderer.destroy())
  })

  test("the sheet view renders the wire's own attribute keys and hides the internal ones", async () => {
    const client = new MockClient()
    const { renderer, waitForFrame } = await openCharacterScreen(
      client,
      110,
      34,
      stateFrame({
        character: {
          ...SHEET,
          attributes: { ...SHEET.attributes, SANMAXADD: 0, HPMAXADD: 0, MPMAXADD: 0 },
        },
      }),
    )

    const frame = await waitForFrame((t) => t.includes("属性 / ATTRIBUTES"))
    expect(frame).toContain("STR 55")
    expect(frame).toContain("DEX 70")
    expect(frame).toContain("LUC 45")
    expect(frame).not.toContain("SANMAXADD")
    expect(frame).not.toContain("HPMAXADD")
    expect(frame).not.toContain("MPMAXADD")
    expect(frame).not.toContain("IDEA")
    expect(frame).not.toContain("KNOW")

    act(() => renderer.destroy())
  })
})
