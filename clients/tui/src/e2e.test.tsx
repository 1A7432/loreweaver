// End to end: the real 3.0 server, started in-process on loopback with a fresh data directory and
// no model configured, reached through this client's own iroh transport, the protocol `Session`
// and the game view. Nothing here is a double.
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { builtInView } from "loreweaver-protocol/v3"
// A test may reach the server by relative path; nothing in `src/` proper does.
import { openServer, type RunningServer } from "../../../server/src/cli/compose.ts"
import { loadSettings } from "../../../server/src/infra/config.ts"
import { roomWorkerEntry } from "../../../server/src/infra/runtime/worker.ts"
import { Connection } from "./connection"
import { GameView } from "./GameView"
import { irohDialer } from "./irohLink"
import { readLocalFile } from "./media"
import { PNG } from "pngjs"
import { liveRender, waitFor, waitForScreen } from "./testkit"
import { themes } from "./themes"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Wait longer than the default for what crosses the real transport and the server's turn. */
async function until(what: string, cond: () => boolean, detail?: () => string): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    try {
      await waitFor(what, cond, detail)
      return
    } catch (error) {
      if (round === 4) throw error
    }
  }
}

test(
  "a fresh server: welcome as admin with the first key, a command's dice in the log and on screen, views, a failed turn's notice, an undo",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "loreweaver-tui-e2e-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    // The environment is handed in, not read: no `.env`, no model, no network.
    const server: RunningServer = await openServer(loadSettings({ TRPG_DATA_DIR: dir }), { mode: "local", workerEntry: roomWorkerEntry(), report: () => {} })
    cleanups.push(() => server.close())
    expect(server.notes).toContain("model_not_configured")
    const key = server.firstKey?.key
    expect(typeof key).toBe("string")

    const connection = new Connection({ ticket: server.ticket, key: key as string, name: "Ada", locale: "en", client: { name: "loreweaver-tui-test", version: "0" }, dial: irohDialer({ mode: "local" }) })
    cleanups.push(() => connection.stop())
    await connection.start()
    const session = connection.session
    await until("the welcome", () => session.status === "online")
    expect(session.getSnapshot().welcome?.you.role).toBe("admin")
    expect(session.getSnapshot().welcome?.room.id).toBe(server.firstKey?.room)

    // The views the client asked for arrive by themselves.
    await until("the views", () => ["me", "party", "scene", "commands", "room", "usage"].every((name) => session.getSnapshot().views.has(name)), () => [...session.getSnapshot().views.keys()].join(","))
    const commands = builtInView(session.getSnapshot(), "commands")?.data.commands ?? []
    expect(commands.some((entry) => entry.id === "roll" && entry.available)).toBe(true)
    expect(commands.some((entry) => entry.id === "undo")).toBe(true)
    expect(builtInView(session.getSnapshot(), "me")?.data.member.role).toBe("admin")

    const harness = await liveRender(<GameView connection={connection} locale="en" theme={themes.lamplight} themeName="lamplight" />, { width: 110, height: 34 })
    cleanups.push(() => {
      connection.stop()
      harness.renderer.destroy()
    })

    // A typed command: one result, to this client; its dice is an event for the table.
    const rolled = await connection.input(".r 1d6")
    expect(rolled?.ok).toBe(true)
    await until("the dice event", () => session.getSnapshot().events.some((event) => event.kind === "dice"))
    const dice = session.getSnapshot().events.find((event) => event.kind === "dice")
    expect(dice?.kind === "dice" && dice.data.expr).toContain("1d6")
    const total = dice?.kind === "dice" ? dice.data.total : -1
    await waitForScreen(harness, "the dice line", (frame) => frame.includes("1d6") && frame.includes(String(total)))

    // Speech starts a turn; with no model it fails, and says so with a notice.
    const said = await connection.input("I light the lamp.")
    expect(said?.ok).toBe(true)
    await until("the failed turn's notice", () => connection.getState().lines.some((line) => line.kind === "notice" && line.code === "provider_auth"))
    await until("the room goes idle", () => session.getSnapshot().turn?.status === "idle")
    await waitForScreen(harness, "the notice line", (frame) => frame.includes("[WARN]"))
    expect(session.getSnapshot().events.some((event) => event.kind === "narrative" && event.data.speaker === "player" && event.data.text === "I light the lamp.")).toBe(true)

    // An undo: the server rewinds the log and the client drops what it removed.
    const epoch = session.getSnapshot().epoch
    const undone = await connection.input(".undo")
    expect(undone?.ok).toBe(true)
    await until("the rewind", () => session.getSnapshot().events.some((event) => event.kind === "rewind"))
    expect(session.getSnapshot().epoch).not.toBe(epoch)
    expect(session.getSnapshot().events.some((event) => event.kind === "narrative" && event.data.text === "I light the lamp.")).toBe(false)
    await waitForScreen(harness, "the undo marker", (frame) => frame.includes("undone") && !frame.includes("I light the lamp."))
  },
  60_000,
)

test(
  "the byte channel: share a PNG and fetch it back byte for byte; import a character card and, as admin, a world card",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "loreweaver-tui-e2e-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const server: RunningServer = await openServer(loadSettings({ TRPG_DATA_DIR: join(dir, "server") }), { mode: "local", workerEntry: roomWorkerEntry(), report: () => {} })
    cleanups.push(() => server.close())
    const connection = new Connection({
      ticket: server.ticket,
      key: server.firstKey?.key as string,
      name: "Ada",
      locale: "en",
      client: { name: "loreweaver-tui-test", version: "0" },
      dial: irohDialer({ mode: "local" }),
      mediaCacheDir: join(dir, "cache"),
    })
    cleanups.push(() => connection.stop())
    await connection.start()
    const session = connection.session
    await until("the welcome and the views", () => session.status === "online" && session.getSnapshot().views.has("me") && session.getSnapshot().views.has("room"))
    const memberId = session.getSnapshot().welcome?.you.id

    // A share: offered on the control stream, sent on a byte stream, announced as a media event.
    const png = new PNG({ width: 3, height: 2 })
    for (let i = 0; i < 6; i += 1) png.data.set([i * 40, 90, 200, 255], i * 4)
    const bytes = new Uint8Array(PNG.sync.write(png))
    const path = join(dir, "handout.png")
    writeFileSync(path, bytes)
    const stored = await connection.upload(await readLocalFile(path, "image"), "share")
    const hash = createHash("sha256").update(bytes).digest("hex")
    expect(stored).toEqual({ hash, size: bytes.length, mime: "image/png", name: "handout.png" })
    await until("the media event", () => session.getSnapshot().events.some((event) => event.kind === "media" && event.data.hash === hash))
    const media = session.getSnapshot().events.find((event) => event.kind === "media")
    expect(media?.kind === "media" && media.data).toMatchObject({ name: "handout.png", mime: "image/png", from: memberId })
    // Fetched back over its own stream, byte for byte, and kept in the cache.
    const fetched = await connection.fetchMedia(hash)
    expect(Buffer.from(fetched.bytes).equals(Buffer.from(bytes))).toBe(true)
    expect(fetched.path).toBe(join(dir, "cache", hash))
    // A hash the room does not hold: the server's coded refusal, in words.
    await expect(connection.fetchMedia("d".repeat(64))).rejects.toMatchObject({ code: "media_not_found", server: true })

    // A character needs the room's rule system: the admin picks one the server offers.
    await until("the systems", () => (builtInView(session.getSnapshot(), "characters")?.data.systems.length ?? 0) > 0)
    const system = builtInView(session.getSnapshot(), "characters")?.data.systems[0]?.id as string
    expect((await connection.runCommand("rule", { system }))?.ok).toBe(true)

    // A character card, as a literal JSON file: uploaded for import, then imported.
    const card = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Mirabel Hart", description: "A lighthouse keeper's daughter.", personality: "Steady." } }
    writeFileSync(join(dir, "mirabel.json"), JSON.stringify(card))
    const cardFile = await connection.upload(await readLocalFile(join(dir, "mirabel.json"), "card"), "import")
    // Nothing of an import file reaches the table.
    expect(session.getSnapshot().events.some((event) => event.kind === "media" && event.data.hash === cardFile.hash)).toBe(false)
    const imported = await connection.runCommand("import", { file: cardFile.hash, as: "character" })
    expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true })
    await until("the character in the me view", () => builtInView(session.getSnapshot(), "me")?.data.character?.name === "Mirabel Hart")

    // A world card, as the admin: one line for the table, the counts for the admin alone.
    const world = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Drowned City", description: "A city under the sea.", character_book: { entries: [{ keys: ["harbor"], content: "The harbor is older than the city.", comment: "Harbor" }] } } }
    writeFileSync(join(dir, "world.json"), JSON.stringify(world))
    const before = session.getSnapshot().events.length
    const worldFile = await connection.upload(await readLocalFile(join(dir, "world.json"), "card"), "import")
    const answer = await connection.runCommand("import", { file: worldFile.hash, as: "world" })
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true })
    expect(answer?.ok && answer.text).toContain("Drowned City")
    await until("the table's line", () => session.getSnapshot().events.slice(before).some((event) => event.kind === "narrative" && event.data.text.includes("Drowned City")))
    const lines = session.getSnapshot().events.slice(before).filter((event) => event.kind === "narrative")
    expect(lines).toHaveLength(1)
  },
  60_000,
)

