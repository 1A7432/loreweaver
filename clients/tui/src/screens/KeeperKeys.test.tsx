import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import {
  FrameType,
  type AdminKeyPurpose,
  type PlayerRole,
  type ServerFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import App, { type AppClient } from "../App"

// Same MockClient shape as App.test.tsx, extended so the keeper admin_* methods are
// spied (call counts + captured args) and push() can inject admin_keys / admin_error.
class MockClient implements AppClient {
  connectCalls: string[] = []
  joinCalls: Array<[string, string | undefined]> = []
  sent: string[] = []
  closed = 0
  getConfigCalls = 0
  listKeysCalls = 0
  setModelCalls: Array<[string, string | undefined]> = []
  mintKeyCalls: Array<
    [string, string | undefined, PlayerRole | undefined, AdminKeyPurpose | undefined, number | undefined]
  > = []
  updateKeyCalls: Array<[string, string | undefined, string | undefined, PlayerRole | undefined]> = []
  deleteKeyCalls: string[] = []
  deleteRoomCalls: string[] = []
  exportRoomCalls: Array<[string, string | undefined]> = []
  importRoomCalls: Array<[string, string | undefined]> = []
  deleteRoomDataCalls: Array<[string, boolean | undefined, string | undefined]> = []
  resetRoomCalls: string[] = []
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
  adminMintKey(
    room: string,
    name?: string,
    role?: PlayerRole,
    purpose?: AdminKeyPurpose,
    expiresIn?: number,
  ): void {
    this.mintKeyCalls.push([room, name, role, purpose, expiresIn])
  }
  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void {
    this.updateKeyCalls.push([id, room, name, role])
  }
  adminDeleteKey(id: string): void {
    this.deleteKeyCalls.push(id)
  }
  adminDeleteRoom(room: string): void {
    this.deleteRoomCalls.push(room)
  }
  adminExportRoom(room: string, path?: string): void {
    this.exportRoomCalls.push([room, path])
  }
  adminImportRoom(path: string, room?: string): void {
    this.importRoomCalls.push([path, room])
  }
  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void {
    this.deleteRoomDataCalls.push([room, backup, path])
  }
  adminResetRoom(room: string): void {
    this.resetRoomCalls.push(room)
  }
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

// Row boxes fill their column's width (same layout MainMenu's proven mouse test
// relies on), so a click anywhere across a row's line hits it; x=6 matches the
// working coordinate in App.test.tsx / CharacterScreen.test.tsx.
const CLICK_X = 6

// From a keeper welcome, click the "房间与邀请" menu row to mount KeeperKeys.
async function enterKeeperKeys(harness: Awaited<ReturnType<typeof renderApp>>) {
  const menu = await harness.waitForFrame((t) => t.includes("房间与邀请"))
  const rowY = menu.split("\n").findIndex((line) => line.includes("房间与邀请"))
  expect(rowY).toBeGreaterThan(0)
  await act(async () => {
    await harness.mockMouse.click(CLICK_X, rowY)
  })
  await harness.flush()
}

describe("KeeperKeys", () => {
  test("进入房间与邀请:挂载即请求 adminListKeys,收到 admin_keys 渲染成表", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    // Mounting the screen fires the list request (mirrors AdminPanel's effect).
    expect(client.listKeysCalls).toBeGreaterThan(0)

    // A pushed admin_keys frame paints the (masked) key rows.
    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [
          {
            id: "k1",
            key_masked: "LW1abcd",
            room: "shuxue",
            name: "漱雪",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
          {
            id: "k2",
            key_masked: "LW2wxyz",
            room: "shuxue",
            name: "沈墨",
            role: "keeper",
            purpose: "join",
            expires_at: null,
          },
        ],
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("LW1abcd"))
    expect(frame).toContain("LW1abcd")
    expect(frame).toContain("漱雪")
    expect(frame).toContain("LW2wxyz")
    expect(frame).toContain("沈墨")

    act(() => harness.renderer.destroy())
  })

  test("填写备注后发码固定使用当前房间", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)
    await harness.waitForFrame((t) => t.includes("⚄ 发邀请码"))

    // The current room is display-only; the name field is focused on mount.
    await act(async () => {
      await harness.mockInput.typeText("守秘之钥")
    })
    await harness.flush()

    // Click the mint button (mouse path). Role was untouched -> default "player".
    const form = await harness.waitForFrame((t) => t.includes("⚄ 发邀请码"))
    const buttonY = form.split("\n").findIndex((line) => line.includes("⚄ 发邀请码"))
    expect(buttonY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, buttonY)
    })
    await harness.flush()

    expect(client.mintKeyCalls).toContainEqual(["shuxue", "守秘之钥", "player", undefined, undefined])

    act(() => harness.renderer.destroy())
  })

  test("键盘可切到 keeper 角色再发码:adminMintKey 收到 role=keeper(空 name→undefined)", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)
    await harness.waitForFrame((t) => t.includes("⚄ 发邀请码"))

    // Tab from the blank name onto the role <select>, arrow to keeper, then Enter.
    await act(async () => {
      harness.mockInput.pressTab()
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressArrow("down")
    })
    await harness.flush()
    await act(async () => {
      harness.mockInput.pressEnter()
    })
    await harness.flush()

    expect(client.mintKeyCalls).toContainEqual(["shuxue", undefined, "keeper", undefined, undefined])

    act(() => harness.renderer.destroy())
  })

  test("一键生成 10 分钟 QQ/Discord 聊天绑定码", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    const frame = await harness.waitForFrame((text) => text.includes("生成 QQ / Discord /bind 码"))
    const buttonY = frame.split("\n").findIndex((line) => line.includes("生成 QQ / Discord /bind 码"))
    expect(buttonY).toBeGreaterThan(0)
    await act(async () => harness.mockMouse.click(CLICK_X, buttonY))
    await harness.flush()

    expect(client.mintKeyCalls).toContainEqual(["shuxue", undefined, "keeper", "chat_bind", 600])

    act(() => harness.renderer.destroy())
  })

  test("角色下拉的方向键不会同时改变邀请码列表选择", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)
    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [
          {
            id: "k1",
            key_masked: "LW1",
            room: "shuxue",
            name: "First",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
          {
            id: "k2",
            key_masked: "LW2",
            room: "shuxue",
            name: "Second",
            role: "keeper",
            purpose: "join",
            expires_at: null,
          },
        ],
      }),
    )
    await harness.flush()

    await act(async () => harness.mockInput.pressTab())
    await harness.flush()
    await act(async () => harness.mockInput.pressArrow("down"))
    await harness.flush()

    const frame = await harness.waitForFrame((text) => text.includes("载入选中"))
    const loadY = frame.split("\n").findIndex((line) => line.includes("载入选中"))
    await act(async () => harness.mockMouse.click(CLICK_X, loadY))
    await harness.flush()
    const loaded = await harness.waitForFrame((text) => text.includes("保存修改"))
    const saveY = loaded.split("\n").findIndex((line) => line.includes("保存修改"))
    await act(async () => harness.mockMouse.click(CLICK_X + 14, saveY))
    await harness.flush()

    expect(client.updateKeyCalls.at(-1)).toEqual(["k1", "shuxue", "First", "player"])
    act(() => harness.renderer.destroy())
  })

  test("切换邀请码选择会撤销已武装的删除确认", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)
    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [
          {
            id: "k1",
            key_masked: "LW1",
            room: "shuxue",
            name: "First",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
          {
            id: "k2",
            key_masked: "LW2",
            room: "shuxue",
            name: "Second",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
        ],
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((text) => text.includes("删除邀请码"))
    const deleteY = frame.split("\n").findIndex((line) => line.includes("删除邀请码"))
    await act(async () => harness.mockMouse.click(CLICK_X + 28, deleteY))
    await harness.flush()
    expect(client.deleteKeyCalls).toEqual([])

    // Focus is still on the name input, where arrows navigate the invite list.
    await act(async () => harness.mockInput.pressArrow("down"))
    await harness.flush()
    await act(async () => harness.mockMouse.click(CLICK_X + 28, deleteY))
    await harness.flush()
    expect(client.deleteKeyCalls).toEqual([])

    act(() => harness.renderer.destroy())
  })

  test("收到带 minted 的 admin_keys:明文钥匙醒目显示 + 只显示一次提示", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [
          {
            id: "k1",
            key_masked: "LW1abcd",
            room: "shuxue",
            name: "新钥",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
        ],
        minted: {
          key: "LW-cleartext-01",
          room: "shuxue",
          name: "新钥",
          role: "player",
          purpose: "join",
          expires_at: null,
        },
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("LW-cleartext-01"))
    expect(frame).toContain("LW-cleartext-01")
    expect(frame).toContain("只显示一次")

    act(() => harness.renderer.destroy())
  })

  test("聊天绑定码直接显示可复制的 /bind 命令", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [],
        minted: {
          key: "LW-chat-bind-01",
          room: "shuxue",
          name: "",
          role: "keeper",
          purpose: "chat_bind",
          expires_at: Date.now() / 1000 + 600,
        },
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((text) => text.includes("/bind LW-chat-bind-01"))
    expect(frame).toContain("临时聊天绑定码")
    expect(frame).toContain("10 分钟")

    act(() => harness.renderer.destroy())
  })

  test("已绑定聊天身份只能撤销，不能当邀请码编辑", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [
          {
            id: "chat:binding-id",
            key_masked: "discord:42",
            room: "shuxue",
            name: "discord:42",
            role: "keeper",
            purpose: "chat_bind",
            expires_at: null,
          },
        ],
      }),
    )
    await harness.flush()

    const frame = await harness.waitForFrame((text) => text.includes("discord:42"))
    expect(frame).not.toContain("载入选中")
    expect(frame).not.toContain("保存修改")
    const deleteY = frame.split("\n").findIndex((line) => line.includes("删除邀请码"))
    expect(deleteY).toBeGreaterThan(0)
    await act(async () => harness.mockMouse.click(CLICK_X, deleteY))
    await harness.flush()
    await act(async () => harness.mockMouse.click(CLICK_X, deleteY))
    await harness.flush()

    expect(client.updateKeyCalls).toEqual([])
    expect(client.deleteKeyCalls).toEqual(["chat:binding-id"])
    act(() => harness.renderer.destroy())
  })

  test("可载入选中邀请码并执行修改、删除邀请码、删除房间访问", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [
          {
            id: "k1",
            key_masked: "LW1abcd",
            room: "shuxue",
            name: "漱雪",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
        ],
      }),
    )
    await harness.flush()
    const frame = await harness.waitForFrame((t) => t.includes("载入选中"))
    const lines = frame.split("\n")

    const loadY = lines.findIndex((line) => line.includes("载入选中"))
    expect(loadY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, loadY)
    })
    await harness.flush()

    const loaded = await harness.waitForFrame((t) => t.includes("保存修改"))
    const loadedLines = loaded.split("\n")
    const saveY = loadedLines.findIndex((line) => line.includes("保存修改"))
    expect(saveY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X + 14, saveY)
    })
    await harness.flush()
    expect(client.updateKeyCalls).toContainEqual(["k1", "shuxue", "漱雪", "player"])

    const deleteY = loadedLines.findIndex((line) => line.includes("删除邀请码"))
    expect(deleteY).toBeGreaterThan(0)
    // A destructive op needs a SECOND click to confirm — one click only arms it, so a single
    // misclick can't irreversibly delete anything.
    await act(async () => {
      await harness.mockMouse.click(CLICK_X + 28, deleteY)
    })
    await harness.flush()
    expect(client.deleteKeyCalls).toEqual([]) // armed, not yet fired
    await act(async () => {
      await harness.mockMouse.click(CLICK_X + 28, deleteY)
    })
    await harness.flush()
    expect(client.deleteKeyCalls).toEqual(["k1"])

    const deleteRoomY = loadedLines.findIndex((line) => line.includes("删除房间访问"))
    expect(deleteRoomY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, deleteRoomY)
    })
    await harness.flush()
    expect(client.deleteRoomCalls).toEqual([]) // armed, not yet fired
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, deleteRoomY)
    })
    await harness.flush()
    expect(client.deleteRoomCalls).toEqual(["shuxue"])

    act(() => harness.renderer.destroy())
  })

  test("可导出、导入并完整删除房间数据,完成后显示操作摘要", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    act(() =>
      client.push({
        type: FrameType.AdminKeys,
        keys: [
          {
            id: "k1",
            key_masked: "LW1abcd",
            room: "shuxue",
            name: "漱雪",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
        ],
      }),
    )
    await harness.flush()
    await harness.waitForFrame((t) => t.includes("备份路径"))

    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        harness.mockInput.pressTab()
      })
      await harness.flush()
    }
    await act(async () => {
      await harness.mockInput.typeText("/tmp/shuxue.json")
    })
    await harness.flush()

    const frame = await harness.waitForFrame((t) => t.includes("导出房间备份"))
    const lines = frame.split("\n")
    const exportY = lines.findIndex((line) => line.includes("导出房间备份"))
    expect(exportY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, exportY)
    })
    await harness.flush()
    expect(client.exportRoomCalls).toContainEqual(["shuxue", "/tmp/shuxue.json"])

    const importY = lines.findIndex((line) => line.includes("导入房间备份"))
    expect(importY).toBeGreaterThan(0)
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, importY)
    })
    await harness.flush()
    expect(client.importRoomCalls).toContainEqual(["/tmp/shuxue.json", undefined])

    const resetY = lines.findIndex((line) => line.includes("重开战役"))
    expect(resetY).toBeGreaterThan(0)
    // Reset is its own second-click-to-confirm control and sends no backup/keys.
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, resetY)
    })
    await harness.flush()
    expect(client.resetRoomCalls).toEqual([]) // armed, not yet fired
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, resetY)
    })
    await harness.flush()
    expect(client.resetRoomCalls).toEqual(["shuxue"])

    const deleteY = lines.findIndex((line) => line.includes("完整删除房间"))
    expect(deleteY).toBeGreaterThan(0)
    // Second-click-to-confirm: one click arms, the next fires.
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, deleteY)
    })
    await harness.flush()
    expect(client.deleteRoomDataCalls).toEqual([]) // armed, not yet fired
    await act(async () => {
      await harness.mockMouse.click(CLICK_X, deleteY)
    })
    await harness.flush()
    expect(client.deleteRoomDataCalls).toContainEqual(["shuxue", true, "/tmp/shuxue.json"])

    act(() =>
      client.push({
        type: FrameType.AdminRoomOp,
        action: "delete",
        room: "shuxue",
        path: "/tmp/shuxue.json",
        keys: 1,
        store_rows: 2,
        vector_points: 3,
        media_files: 2,
      }),
    )
    await harness.flush()
    const result = await harness.waitForFrame((t) => t.includes("删除完成"))
    expect(result).toContain("邀请1")
    expect(result).toContain("数据2")
    expect(result).toContain("媒体2")
    expect(result).toContain("向量3")

    act(() => harness.renderer.destroy())
  })

  test("admin_error:有 message 显示 message,无 message 回落到 code", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(KEEPER_WELCOME))
    await enterKeeperKeys(harness)

    // No message -> the code is shown as the fallback.
    act(() => client.push({ type: FrameType.AdminError, code: "forbidden" }))
    await harness.flush()
    const codeFrame = await harness.waitForFrame((t) => t.includes("forbidden"))
    expect(codeFrame).toContain("forbidden")

    // A message takes priority over the code.
    act(() => client.push({ type: FrameType.AdminError, code: "bad_request", message: "房间名不能为空" }))
    await harness.flush()
    const messageFrame = await harness.waitForFrame((t) => t.includes("房间名不能为空"))
    expect(messageFrame).toContain("房间名不能为空")

    act(() => harness.renderer.destroy())
  })

  test("房间与邀请仅对守秘人可见(玩家菜单里没有)", async () => {
    const client = new MockClient()
    const harness = await renderApp(client)
    await harness.flush()
    act(() => client.push(PLAYER_WELCOME))

    const frame = await harness.waitForFrame((t) => t.includes("进入游戏"))
    expect(frame).not.toContain("房间与邀请")
    expect(frame).not.toContain("守秘人")

    act(() => harness.renderer.destroy())
  })
})
