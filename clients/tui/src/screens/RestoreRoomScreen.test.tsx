import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Role } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { MAX_SAVE_BYTES } from "../save"
import { FakeServer, liveRender, pump, settle, waitFor, waitForScreen, withoutActWarning } from "../testkit"
import { themes } from "../themes"
import { RestoreRoomScreen } from "./RestoreRoomScreen"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

const BUNDLE = { format: "loreweaver-room", version: 1, turn: 4, documents: [{ type: "lore", id: "l1", version: 1, data: "{\"title\":\"the well\"}", meta: "{}" }], state: [], modules: [], events: [] }

async function open(server: FakeServer, role: Role = "admin") {
  server.role = role
  const connection = server.connect({ redialBaseMs: 1, redialMaxMs: 1 })
  connections.push(connection)
  await connection.start()
  await waitFor("the welcome", () => connection.session.status === "online")
  let back = 0
  let restored = 0
  const harness = await withoutActWarning(() =>
    liveRender(<RestoreRoomScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="en" onBack={() => (back += 1)} onRestored={() => (restored += 1)} />, { width: 110, height: 34 }),
  )
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  // Across every link the client has had: an import ends the one it was sent on.
  const imports = () => server.transports.flatMap((transport) => transport.calls("command.run")).filter((call) => (call.params.args as { op?: string } | undefined)?.op === "import")
  const dir = await mkdtemp(join(tmpdir(), "lw-restore-"))
  /** Type the file's path into the field and press Enter. */
  const submit = async (file: string) => {
    await harness.mockInput.typeText(join(dir, file))
    harness.mockInput.pressEnter()
  }
  /** Clear what the field holds (a whole path), to type another. */
  const clear = async (file: string) => {
    for (let i = 0; i < join(dir, file).length; i += 1) harness.mockInput.pressBackspace()
    await pump()
  }
  return { connection, harness, screen, imports, dir, submit, clear, back: () => back, restored: () => restored }
}

/** A save the server replaces this room with: it answers, bumps the generation, and ends the link. */
function replacesRoom(server: FakeServer, text = "Loaded the bundle; the room continues from turn 4."): void {
  server.onCall = (method, params, transport) => {
    if (method === "command.run" && params.id === "save") {
      server.epoch += 1
      // After the answer, as the server does: the admin hears it worked, then the link goes.
      queueMicrotask(() => transport.drop("closed"))
      return { ok: true, text, data: { epoch: server.epoch, turn: 4 } }
    }
    return { ok: true }
  }
}

describe("RestoreRoomScreen", () => {
  test("a file that is not a save is refused here, with the reason, and nothing is sent", async () => {
    const server = new FakeServer({ role: "admin" })
    const { harness, screen, submit, clear, dir, imports } = await open(server)
    await screen("the form", (text) => text.includes("Restore the room from a save file"))
    await writeFile(join(dir, "words.json"), "this is not json {")
    await writeFile(join(dir, "list.json"), "[1, 2, 3]")
    await writeFile(join(dir, "number.json"), "42")
    await writeFile(join(dir, "nothing.json"), "null")
    await writeFile(join(dir, "text.json"), "\"a string\"")
    await writeFile(join(dir, "bytes.json"), new Uint8Array([0xff, 0xfe, 0x00, 0x7b]))
    await writeFile(join(dir, "empty.json"), "")
    // A sparse file one byte over the limit: refused by its size, before any of it is read.
    await writeFile(join(dir, "big.json"), "")
    await truncate(join(dir, "big.json"), MAX_SAVE_BYTES + 1)

    const refused: Array<[string, string]> = [
      ["words.json", "not JSON, so it is not a room save: words.json"],
      ["bytes.json", "not JSON, so it is not a room save: bytes.json"],
      ["list.json", "not a room save (it must be one JSON object): list.json"],
      ["number.json", "not a room save (it must be one JSON object): number.json"],
      ["nothing.json", "not a room save (it must be one JSON object): nothing.json"],
      ["text.json", "not a room save (it must be one JSON object): text.json"],
      ["empty.json", "The file is empty"],
      ["big.json", "Too large to send (over 8 MB)"],
      ["gone.json", "No such file"],
    ]
    let previous = ""
    for (const [file, message] of refused) {
      if (previous !== "") await clear(previous)
      await submit(file)
      const frame = await screen(`the refusal of ${file}`, (text) => text.includes(message))
      // Still on the path form: no confirmation was offered.
      expect(frame).not.toContain("Replace the room with this save?")
      previous = file
    }
    await settle()
    expect(server.current.calls("command.run")).toHaveLength(0)
    harness.mockInput.pressEscape()
  })

  test("a save is read, shown by name and size with a plain warning, and nothing is sent until it is confirmed", async () => {
    const server = new FakeServer({ role: "admin" })
    const { harness, screen, submit, dir, imports, back } = await open(server)
    await writeFile(join(dir, "main-20261127-101500.json"), JSON.stringify(BUNDLE))
    await submit("main-20261127-101500.json")
    const frame = await screen("the confirmation", (text) => text.includes("Replace the room with this save?"))
    expect(frame).toContain("File: main-20261127-101500.json")
    expect(frame).toContain(`Size: ${JSON.stringify(BUNDLE).length} B`)
    expect(frame).toContain("The CURRENT room is replaced by this save")
    expect(frame).toContain("Everyone at the table is disconnected")
    expect(frame).toContain("reconnects by themselves")
    // The safe answer is the one the cursor starts on.
    expect(frame).toContain("⚄ Cancel: keep the current room")
    // Never the word for the AI: the person who restores is the room's admin.
    expect(frame.toLowerCase()).not.toContain("keeper")
    await settle()
    expect(server.current.calls("command.run")).toHaveLength(0)

    // Enter on the default answer cancels: back to the path, still nothing sent.
    harness.mockInput.pressEnter()
    await screen("back on the form", (text) => text.includes("Save file") && !text.includes("Replace the room with this save?"))
    // Esc from the confirmation is the same.
    harness.mockInput.pressEnter()
    await screen("the confirmation again", (text) => text.includes("Replace the room with this save?"))
    harness.mockInput.pressEscape()
    await screen("the form again", (text) => !text.includes("Replace the room with this save?"))
    await settle()
    expect(server.current.calls("command.run")).toHaveLength(0)
    expect(imports()).toHaveLength(0)
    expect(back()).toBe(0)
    // Esc on the form leaves the screen.
    harness.mockInput.pressEscape()
    await waitFor("back", () => back() === 1)
  })

  test("confirming sends exactly one save import with the file's bundle, and the drop that follows is a success: the screen leaves for the menu", async () => {
    const server = new FakeServer({ role: "admin" })
    replacesRoom(server)
    const { harness, screen, submit, dir, imports, connection, restored } = await open(server)
    await writeFile(join(dir, "main.json"), JSON.stringify(BUNDLE))
    await submit("main.json")
    await screen("the confirmation", (text) => text.includes("Replace the room with this save?"))
    harness.mockInput.pressArrow("down")
    await pump()
    await harness.flush()
    harness.mockInput.pressEnter()

    await waitFor("the one import", () => imports().length === 1)
    expect(imports()[0]?.params).toEqual({ id: "save", args: { op: "import", bundle: BUNDLE } })
    // The link was ended by the server; the connection owner redials by itself, and the new
    // welcome names another generation: the screen is done.
    await waitFor("the screen leaves", () => restored() === 1)
    expect(connection.session.status).toBe("online")
    expect(connection.session.getSnapshot().epoch).toBe(2)
    expect(server.transports).toHaveLength(2)
    // No error for the expected drop, and nothing in the game's log lines.
    const frame = harness.captureCharFrame()
    expect(frame).not.toContain("Not connected")
    expect(connection.getState().lines).toEqual([])
    expect(server.current.calls("command.run")).toHaveLength(0)
    expect(server.transports[0]?.calls("command.run")).toHaveLength(1)
  })

  test("a drop that beats the answer is told by the generation: replaced is a success, unchanged says nothing happened and offers to retry", async () => {
    const server = new FakeServer({ role: "admin" })
    // The first import: the room is replaced, but the link goes before the answer is out.
    let attempt = 0
    server.onCall = (method, params, transport) => {
      if (method !== "command.run" || params.id !== "save") return { ok: true }
      attempt += 1
      if (attempt === 1) {
        // The link breaks and nothing was done.
        transport.drop("closed")
        return null
      }
      server.epoch += 1
      transport.drop("closed")
      return null
    }
    const { harness, screen, submit, dir, imports, restored, connection } = await open(server)
    await writeFile(join(dir, "main.json"), JSON.stringify(BUNDLE))
    await submit("main.json")
    await screen("the confirmation", (text) => text.includes("Replace the room with this save?"))
    harness.mockInput.pressArrow("down")
    await pump()
    await harness.flush()
    harness.mockInput.pressEnter()
    const frame = await screen("the unchanged room said so", (text) => text.includes("the room was not replaced. Nothing changed"))
    expect(frame).toContain("Save file")
    expect(restored()).toBe(0)
    expect(connection.session.getSnapshot().epoch).toBe(1)

    // Again: this time the generation moved while the answer was lost.
    await waitFor("the first import seen", () => imports().length === 1)
    harness.mockInput.pressEnter()
    await screen("the confirmation again", (text) => text.includes("Replace the room with this save?"))
    harness.mockInput.pressArrow("down")
    await pump()
    await harness.flush()
    harness.mockInput.pressEnter()
    await waitFor("the screen leaves", () => restored() === 1)
    expect(connection.session.getSnapshot().epoch).toBe(2)
    expect(attempt).toBe(2)
  })

  test("the server's refusal is shown in its own words and the room is untouched", async () => {
    const server = new FakeServer({ role: "admin" })
    server.onCall = (method, params) =>
      method === "command.run" && params.id === "save" ? { ok: false, code: "bad_bundle", message: "That save is from a newer version of Loreweaver than this server can read (version 9)." } : { ok: true }
    const { harness, screen, submit, dir, imports, restored, connection } = await open(server)
    await writeFile(join(dir, "future.json"), JSON.stringify({ ...BUNDLE, version: 9 }))
    await submit("future.json")
    await screen("the confirmation", (text) => text.includes("Replace the room with this save?"))
    harness.mockInput.pressArrow("down")
    await pump()
    await harness.flush()
    harness.mockInput.pressEnter()
    const frame = await screen("the refusal", (text) => text.includes("newer version of Loreweaver than this server can read (version 9)."))
    expect(frame).toContain("Save file")
    expect(imports()).toHaveLength(1)
    expect(restored()).toBe(0)
    // The link was never touched.
    expect(server.transports).toHaveLength(1)
    expect(connection.session.status).toBe("online")
    expect(connection.getState().lines).toEqual([])
  })

  test("a player who somehow reaches the screen is told it is for admins and can send nothing", async () => {
    const server = new FakeServer({ role: "player" })
    const { harness, screen, back } = await open(server, "player")
    const frame = await screen("the refusal", (text) => text.includes("for the room's admins"))
    expect(frame).not.toContain("Save file")
    harness.mockInput.pressEnter()
    await settle()
    expect(server.current.calls("command.run")).toHaveLength(0)
    harness.mockInput.pressEscape()
    await waitFor("back", () => back() === 1)
  })

  test("the screen speaks Chinese when the client does, and names the person the room's admin, never the AI", async () => {
    const server = new FakeServer({ role: "admin" })
    const connection = server.connect()
    connections.push(connection)
    await connection.start()
    await waitFor("the welcome", () => connection.session.status === "online")
    const harness = await withoutActWarning(() => liveRender(<RestoreRoomScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="zh" onBack={() => {}} onRestored={() => {}} />, { width: 110, height: 34 }))
    harnesses.push(harness)
    const frame = await waitForScreen(harness, "the Chinese form", (text) => text.includes("从存档文件恢复房间"))
    expect(frame).toContain("存档文件")
    expect(frame).not.toContain("守秘人")
  })
})
