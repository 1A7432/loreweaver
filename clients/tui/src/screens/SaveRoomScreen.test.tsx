import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Role } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { logItems } from "../log"
import { itemsToTranscript } from "../transcript"
import { captureConsole, FakeServer, liveRender, pump, settle, waitFor, waitForScreen, withoutActWarning } from "../testkit"
import { themes } from "../themes"
import { SaveRoomScreen } from "./SaveRoomScreen"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

const SECRET = "SENTINEL-the-well-hides-the-cult-9d41b7"
const BUNDLE = { format: "loreweaver-room", version: 1, turn: 4, documents: [{ type: "lore", id: "l1", version: 1, data: JSON.stringify({ title: SECRET }), meta: "{}" }], state: [], modules: [], events: [] }
const BYTES = new TextEncoder().encode(JSON.stringify(BUNDLE))
const HASH = createHash("sha256").update(BYTES).digest("hex")

/** The server stores the room as a file and answers `save` export with its reference, as the real one does. */
function exportsRoom(server: FakeServer, bytes: Uint8Array = BYTES, hash: string = HASH): void {
  server.files.set(hash, { bytes, mime: "application/json", name: "save-arkham-20261127-101500.json", purpose: "save" })
  server.onCall = (method, params) =>
    method === "command.run" && params.id === "save"
      ? { ok: true, text: "Exported the room: 1 documents, 0 log entries.", data: { documents: 1, events: 0, media: { hash, mime: "application/json", size: bytes.length, name: "save-arkham-20261127-101500.json" } } }
      : { ok: true }
}

async function open(server: FakeServer, role: Role = "admin") {
  server.role = role
  const cache = await mkdtemp(join(tmpdir(), "lw-cache-"))
  const connection = server.connect({ mediaCacheDir: cache })
  connections.push(connection)
  await connection.start()
  await waitFor("the welcome", () => connection.session.status === "online")
  const dir = join(await mkdtemp(join(tmpdir(), "lw-saves-")), "saves")
  let back = 0
  const harness = await withoutActWarning(() =>
    liveRender(<SaveRoomScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="en" saveDir={dir} onBack={() => (back += 1)} />, { width: 110, height: 30 }),
  )
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  return { connection, harness, screen, dir, cache, back: () => back }
}

describe("SaveRoomScreen", () => {
  test("Enter saves the room to a private file and tells the path; the file is fetched over the byte channel and is nowhere else", async () => {
    const server = new FakeServer({ role: "admin", room: "arkham" })
    exportsRoom(server)
    const output = captureConsole()
    try {
      const { harness, screen, dir, cache, connection } = await open(server)
      await screen("the screen", (text) => text.includes("Save the room to a file") && text.includes("Save now"))
      harness.mockInput.pressEnter()
      const frame = await screen("the path", (text) => text.includes("Room saved to"))
      expect(server.current.calls("command.run").map((call) => call.params)).toEqual([{ id: "save", args: { op: "export" } }])

      const files = await readdir(dir)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^arkham-\d{8}-\d{6}\.json$/)
      const path = join(dir, files[0] as string)
      // The path itself is on screen (it may wrap): its folder's last part and the file's name.
      expect(frame.replace(/\s+/g, "")).toContain(files[0] as string)
      const written = await readFile(path, "utf8")
      expect(new Uint8Array(await readFile(path))).toEqual(BYTES)
      expect(written).toContain(SECRET)
      // Not in the media cache, which is not private, and not held as a fetched file.
      expect(await readdir(cache)).toEqual([])
      expect(connection.getState().fetches.size).toBe(0)
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)

      // The secret is in the file and nowhere else: not on screen, not in the local lines, not in
      // the transcript the log would make, not in anything written to the console.
      const transcript = itemsToTranscript(logItems(connection.session.getSnapshot().events, [], connection.getState().lines), { room: "arkham", at: new Date() })
      for (const place of [frame, JSON.stringify(connection.getState().lines), transcript, output.text()]) expect(place).not.toContain(SECRET)
      expect(connection.getState().lines).toEqual([])
    } finally {
      output.restore()
    }
  })

  test("a second Enter makes a second file; the first is kept", async () => {
    const server = new FakeServer({ role: "admin" })
    exportsRoom(server)
    const { harness, screen, dir } = await open(server)
    harness.mockInput.pressEnter()
    await screen("the first save", (text) => text.includes("Room saved to"))
    await waitFor("the first file on disk", () => readdirSync(dir).length === 1)
    harness.mockInput.pressEnter()
    await waitFor("two files on disk", () => readdirSync(dir).length === 2)
    expect(server.current.calls("command.run")).toHaveLength(2)
  })

  test("the server's refusal is shown in its words and nothing is written", async () => {
    const server = new FakeServer({ role: "admin" })
    server.onCall = (method, params) => (method === "command.run" && params.id === "save" ? { ok: false, code: "forbidden", message: "Only room admins may do that." } : { ok: true })
    const { harness, screen, dir, connection } = await open(server)
    harness.mockInput.pressEnter()
    await screen("the refusal", (text) => text.includes("Only room admins may do that."))
    await settle()
    expect(await readdir(dir).catch(() => [])).toEqual([])
    expect(connection.getState().lines).toEqual([])
  })

  test("a link that drops under the save says nothing was saved", async () => {
    const server = new FakeServer({ role: "admin" })
    server.onCall = (method, params, transport) => {
      if (method === "command.run" && params.id === "save") transport.drop("line too long")
      return null
    }
    const { harness, screen, dir } = await open(server)
    harness.mockInput.pressEnter()
    await screen("the words", (text) => text.includes("nothing was saved"))
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })

  test("an answer that names no save file, or the room itself (the old shape), is not written as a file", async () => {
    for (const data of [undefined, BUNDLE]) {
      const server = new FakeServer({ role: "admin" })
      server.onCall = (method, params) => (method === "command.run" && params.id === "save" ? { ok: true, text: "Exported", ...(data === undefined ? {} : { data }) } : { ok: true })
      const { harness, screen, dir } = await open(server)
      harness.mockInput.pressEnter()
      await screen("the words", (text) => text.includes("named no save file to fetch"))
      expect(await readdir(dir).catch(() => [])).toEqual([])
    }
  })

  test("a file whose bytes do not match its hash is not written; nor one the server will not hand over", async () => {
    const server = new FakeServer({ role: "admin" })
    // The server names one hash and sends other bytes under it.
    exportsRoom(server, new TextEncoder().encode("{\"tampered\":true}"), HASH)
    const { harness, screen, dir } = await open(server)
    harness.mockInput.pressEnter()
    await screen("the words", (text) => text.includes("Could not fetch the save file"))
    expect(await readdir(dir).catch(() => [])).toEqual([])

    server.files.clear()
    exportsRoom(server)
    server.files.clear()
    harness.mockInput.pressEnter()
    await screen("the server's refusal", (text) => text.includes("refused: media_not_found"))
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })

  test("a folder that cannot be written says so, with the file system's words", async () => {
    const server = new FakeServer({ role: "admin" })
    exportsRoom(server)
    const connection = server.connect()
    connections.push(connection)
    await connection.start()
    await waitFor("the welcome", () => connection.session.status === "online")
    // A file where the folder should be.
    const blocker = join(await mkdtemp(join(tmpdir(), "lw-saves-")), "not-a-folder")
    await Bun.write(blocker, "x")
    const harness = await withoutActWarning(() =>
      liveRender(<SaveRoomScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="en" saveDir={blocker} onBack={() => {}} />, { width: 110, height: 30 }),
    )
    harnesses.push(harness)
    harness.mockInput.pressEnter()
    await waitForScreen(harness, "the failure", (text) => text.includes("Could not write the save file"))
  })

  test("a player who reaches the screen is told it is for admins and sends nothing; Esc leaves", async () => {
    const server = new FakeServer({ role: "player" })
    const { harness, screen, back } = await open(server, "player")
    const frame = await screen("the refusal", (text) => text.includes("for the room's admins"))
    expect(frame).not.toContain("Save now")
    harness.mockInput.pressEnter()
    await settle()
    expect(server.current.calls("command.run")).toHaveLength(0)
    harness.mockInput.pressEscape()
    await waitFor("back", () => back() === 1)
  })

  test("in Chinese, and the person is the room's admin, never the AI", async () => {
    const server = new FakeServer({ role: "admin" })
    const connection = server.connect()
    connections.push(connection)
    await connection.start()
    await waitFor("the welcome", () => connection.session.status === "online")
    const harness = await withoutActWarning(() => liveRender(<SaveRoomScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="zh" onBack={() => {}} />, { width: 110, height: 30 }))
    harnesses.push(harness)
    const frame = await waitForScreen(harness, "the Chinese screen", (text) => text.includes("把房间存成文件"))
    expect(frame).toContain("现在保存")
    expect(frame).not.toContain("守秘人")
  })
})
