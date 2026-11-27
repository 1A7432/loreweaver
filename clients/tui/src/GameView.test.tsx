import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AudioController, type FetchSound } from "./audio"
import type { Connection } from "./connection"
import { GameView, type GameViewProps } from "./GameView"
import { FakeServer, liveRender, pump, waitFor, waitForScreen } from "./testkit"
import { PNG } from "pngjs"
import { themes } from "./themes"

/** The terminal's Page Up sequence (the mock keyboard has no name for it). */
const PAGE_UP = "\x1b[5~"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

/** A table with a character, a party in a fight, a scene, variables and a finished turn's usage. */
function table(server: FakeServer): void {
  server.views.set("me", {
    member: { id: "m1", name: "Ada", role: "player", roleLabel: "Investigator" },
    character: {
      id: "ch-1",
      name: "Ada Lovelace",
      pack: "coc7",
      status: [],
      resources: [{ id: "hp", label: "HP", value: 11, max: 13 }],
      attributes: [{ key: "STR", label: "STR", value: 45 }],
      skills: [{ key: "Spot Hidden", label: "Spot Hidden", value: 60 }],
    },
  })
  server.views.set("party", {
    members: [
      { id: "m1", name: "Ada", role: "player", online: true, character: "ch-1" },
      { id: "m2", name: "Bao", role: null, online: false, character: "ch-2" },
    ],
    characters: [
      { id: "ch-1", name: "Ada Lovelace", pack: "coc7", status: [], resources: [{ id: "hp", label: "HP", value: 11, max: 13 }], player: { id: "m1", name: "Ada" } },
      { id: "ch-2", name: "Captain Reyes", pack: "coc7", status: [], resources: [{ id: "hp", label: "HP", value: 4, max: 12 }], player: { id: "m2", name: "Bao" } },
    ],
    initiative: { round: 2, acting: "Captain Reyes", order: [{ name: "Captain Reyes", value: 14 }, { name: "Ada Lovelace", value: 9 }] },
  })
  server.views.set("scene", { name: "Miskatonic Library", focus: "the restricted shelf", established: [], time: "23:40", clockModule: null, round: 2 })
  server.views.set("variables", { module: [{ id: "dread", kind: "number", label: "Dread", value: 3, min: 0, max: 10 }], tree: [{ path: "weather", value: "fog" }] })
  server.views.set("usage", { last: { turn: 3, inputTokens: 12_345, outputTokens: 678, cachedInputTokens: 6_000, cacheWriteTokens: 0, reasoningTokens: 0, estimated: false } })
  server.views.set("characters", { claimable: [], systems: [{ id: "coc7", label: "Call of Cthulhu 7e", active: true }], mine: "ch-1" })
}

async function play(server: FakeServer, props: Partial<GameViewProps> = {}, width = 120, height = 40) {
  // Fetched pictures are cached in a folder of the test's own, never in the person's home.
  const connection = server.connect({ mediaCacheDir: await mkdtemp(join(tmpdir(), "loreweaver-cache-")) })
  connections.push(connection)
  await connection.start()
  await waitFor("the welcome", () => connection.session.status === "online")
  const harness = await liveRender(<GameView connection={connection} locale="en" theme={themes.lamplight} themeName="lamplight" platform="linux" {...props} />, { width, height })
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  return { connection, harness, screen }
}

describe("GameView", () => {
  test("draws the log from events and the sidebars and header from views", async () => {
    const server = new FakeServer()
    table(server)
    server.say("**The library exhales dust.**")
    server.say("Keep your voice down.", "npc", "Martha")
    server.event("dice", { actor: "Ada", kind: "check", expr: "1d100", rolls: [7], total: 7, target: 60, outcome: { id: "hard", label: "Hard success", success: true, critical: false, fumble: false, tier: 3 } })
    server.event("blocks", { blocks: [{ kind: "title_card", title: "Act II", subtitle: "The Stacks" }, { kind: "letter", body: "Come alone.", from: "M." }] })
    server.event("media", { hash: "a".repeat(64), mime: "image/png", size: 10, name: "map.png", from: "Martha" })
    const { screen } = await play(server)
    const frame = await screen("the table", (text) => text.includes("Martha") && text.includes("Act II") && text.includes("Dread"))
    expect(frame).toContain("The library exhales dust.")
    expect(frame).toContain("[Martha]: Keep your voice down.")
    expect(frame).toContain("⚄ Ada 1d100 7 vs 60 -> Hard success")
    expect(frame).toContain("│ Come alone.")
    expect(frame).toContain("map.png — shared by Martha")
    // Header: room, scene, clock and round, the last turn's tokens and cache share.
    expect(frame).toContain("joined arkham")
    expect(frame).toContain("Miskatonic Library ◷23:40 ·ROUND2")
    expect(frame).toContain("last turn ↑12.3k ↓678")
    expect(frame).toContain("cache 49%")
    // Sidebars: own character, the other player (offline) with resources, initiative, scene, variables.
    expect(frame).toContain("Ada Lovelace (you)")
    expect(frame).toContain("○ Captain Reyes · Bao")
    expect(frame).toContain("INIT · round 2")
    expect(frame).toContain("▶ Captain Reyes 14")
    expect(frame).toContain("the restricted shelf")
    expect(frame).toContain("weather: fog")
    // One online member, from the party view.
    expect(frame).toContain("arkham · 1 online")
  })

  test("speech and commands go out as typed; an answer and a refusal show to this player as local lines", async () => {
    const server = new FakeServer()
    server.onInput = (text) => {
      if (text === ".st") return { ok: true, text: "Ada Lovelace: STR 45 · Spot Hidden 60" }
      if (text === ".reset") return { ok: false, code: "forbidden", message: "Only the room's admin may do that." }
      server.say(text, "player", "Ada")
      return { ok: true }
    }
    const { harness, screen } = await play(server)
    await harness.mockInput.typeText("I search the shelf")
    harness.mockInput.pressEnter()
    await screen("the echoed line", (text) => text.includes("Ada: I search the shelf"))
    await harness.mockInput.typeText(".st")
    harness.mockInput.pressEnter()
    await screen("the first answer", (text) => text.includes("Spot Hidden 60"))
    await harness.mockInput.typeText(".reset")
    harness.mockInput.pressEnter()
    const frame = await screen("the answers", (text) => text.includes("Spot Hidden 60") && text.includes("✖ Only the room's admin"))
    expect(frame).toContain("Ada Lovelace: STR 45 · Spot Hidden 60")
    expect(server.current.inputs()).toEqual(["I search the shelf", ".st", ".reset"])
  })

  test("an animated busy line while a turn runs; drafts stream after the last event and the event replaces them", async () => {
    const server = new FakeServer()
    const { screen } = await play(server)
    server.signal("turn", { status: "busy", actor: "Ada", activity: "dice" })
    await screen("the busy line", (text) => text.includes("Keeper resolving Ada · rolling"))
    server.signal("draft", { id: "n1", text: "The shelf " })
    server.signal("draft", { id: "n1", text: "groans." })
    await screen("the draft", (text) => text.includes("The shelf groans."))
    server.say("The shelf groans, and a book falls.", "kp", undefined, "n1")
    server.signal("turn", { status: "idle" })
    const frame = await screen("the final line", (text) => text.includes("a book falls.") && !text.includes("Keeper resolving"))
    expect(frame.match(/The shelf groans/g)).toHaveLength(1)
  })

  test("a notice is a transient line for this player", async () => {
    const server = new FakeServer()
    const { screen } = await play(server)
    server.signal("notice", { level: "warn", code: "provider_auth", text: "The Keeper's model refused the key." })
    await screen("the notice", (text) => text.includes("[WARN] The Keeper's model refused the key."))
  })

  test("a choice runs its command with command.run", async () => {
    const server = new FakeServer()
    server.event("blocks", { blocks: [{ kind: "choices", prompt: "Which door?", options: [{ id: "l", label: "Left", command: "mod/door", args: { side: "left" } }, { id: "r", label: "Right", command: "mod/door", args: { side: "right" } }] }] })
    const { harness, screen } = await play(server)
    await screen("the choices", (text) => text.includes("Which door?") && text.includes("Left"))
    harness.mockInput.pressTab()
    await pump()
    harness.mockInput.pressArrow("down")
    await pump()
    harness.mockInput.pressEnter()
    await waitFor("the command call", () => server.current.calls("command.run").length === 1)
    expect(server.current.calls("command.run")[0]?.params).toEqual({ id: "mod/door", args: { side: "right" } })
  })

  test("claiming a character on offer from the roster runs pc claim with its id", async () => {
    const server = new FakeServer()
    server.views.set("characters", { claimable: [{ id: "pre-1", name: "Professor Armitage", blurb: "Head librarian.", source: { kind: "pack", id: "p" }, player: null }], systems: [], mine: null })
    const { harness, screen } = await play(server)
    await screen("the roster", (text) => text.includes("Professor Armitage") && text.includes("Head librarian."))
    harness.mockInput.pressTab()
    await pump()
    harness.mockInput.pressEnter()
    await waitFor("the claim", () => server.current.calls("command.run").length === 1)
    expect(server.current.calls("command.run")[0]?.params).toEqual({ id: "pc", args: { op: "claim", name: "pre-1" } })
  })

  test("an undo removes the lines it took and leaves a marker; a dropped link shows in the header", async () => {
    const server = new FakeServer()
    server.say("You enter the hall.")
    server.say("I open the coffin.", "player", "Ada")
    const { screen } = await play(server)
    await screen("the coffin", (text) => text.includes("I open the coffin."))
    server.event("rewind", { from: 2, kept: [], epoch: 2 })
    const frame = await screen("the undo", (text) => text.includes("The last turn was undone") && !text.includes("I open the coffin."))
    expect(frame).toContain("You enter the hall.")
    server.current.drop()
    await screen("the reconnecting state", (text) => text.includes("reconnecting…"))
  })

  test("PgUp at the top of the log loads older history", async () => {
    const server = new FakeServer()
    for (let i = 1; i <= 230; i += 1) server.say(`entry number ${i}`)
    const { connection, harness } = await play(server, {}, 120, 30)
    expect(connection.session.getSnapshot().events[0]?.seq).toBe(31)
    expect(connection.session.getSnapshot().complete).toBe(false)
    for (let i = 0; i < 60 && server.current.calls("log.page").length === 0; i += 1) {
      harness.mockInput.pressKey(PAGE_UP)
      await pump(2)
    }
    await waitFor("the older page", () => connection.session.getSnapshot().events[0]?.seq === 1)
    expect(server.current.calls("log.page")[0]?.params).toEqual({ before: 31, limit: 100 })
  })

  test("Ctrl+S writes the log, local lines included, to a file; Ctrl+L hides it until PgUp", async () => {
    const server = new FakeServer()
    server.say("The lamp gutters.")
    server.event("dice", { actor: "Ada", kind: "roll", expr: "1d6", rolls: [4], total: 4 })
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-transcript-"))
    const { harness, screen } = await play(server, { transcriptDir: dir })
    await screen("the log", (text) => text.includes("The lamp gutters."))
    harness.mockInput.pressKey("s", { ctrl: true })
    await screen("the saved line", (text) => text.includes("Session log saved to"))
    const files = await readdir(dir)
    expect(files[0]).toMatch(/^arkham-\d{8}-\d{6}\.txt$/)
    const body = await readFile(join(dir, files[0] as string), "utf8")
    expect(body).toContain("KP: The lamp gutters.")
    expect(body).toContain("⚄ Ada 1d6 4")

    harness.mockInput.pressKey("l", { ctrl: true })
    const cleared = await screen("the cleared log", (text) => text.includes("Earlier lines hidden"))
    expect(cleared).not.toContain("The lamp gutters.")
    harness.mockInput.pressKey(PAGE_UP)
    await screen("the log again", (text) => text.includes("The lamp gutters."))
  })

  test("F7 opens the command list; ? shows the keys", async () => {
    const server = new FakeServer()
    let opened = 0
    const { harness, screen } = await play(server, { onCommands: () => (opened += 1) })
    harness.mockInput.pressKey("F7")
    await waitFor("the command list", () => opened === 1)
    harness.mockInput.pressKey("?")
    const help = await screen("the help", (text) => text.includes("F7 the command list"))
    expect(help).toContain("Ctrl+S save log")
    expect(help).toContain("drag to select, Ctrl+C to copy")
  })

  test("a shared picture is an entry in the log: Tab to it, Enter fetches it and shows a preview; Esc closes only the picture", async () => {
    const server = new FakeServer()
    table(server)
    const png = new PNG({ width: 2, height: 2 })
    for (let i = 0; i < 4; i += 1) png.data.set([200, 30, 30, 255], i * 4)
    const bytes = new Uint8Array(PNG.sync.write(png))
    const hash = createHash("sha256").update(bytes).digest("hex")
    server.files.set(hash, { bytes, mime: "image/png", name: "map.png", purpose: "share" })
    server.event("media", { hash, mime: "image/png", size: bytes.length, name: "map.png", from: "m2" })
    server.event("blocks", { blocks: [{ kind: "image", hash: "c".repeat(64), caption: "The cellar door" }] })
    const modal: boolean[] = []
    const { harness, screen, connection } = await play(server, { pictureGraphics: false, pictureEnv: {}, onModalChange: (open) => modal.push(open) })
    // Who shared it comes from the party view.
    await screen("the entry", (text) => text.includes("map.png — shared by Bao"))
    harness.mockInput.pressTab()
    await screen("the newest picture selected", (text) => text.includes("The cellar door  Enter: view"))
    harness.mockInput.pressArrow("up")
    await screen("the shared picture selected", (text) => text.includes("map.png — shared by Bao  Enter: view"))
    harness.mockInput.pressEnter()
    const shown = await screen("the preview", (text) => text.includes("▀") && text.includes("Enter / Esc / q close"))
    expect(shown).toContain("🖼 map.png · shared by Bao")
    expect(connection.getState().fetches.get(hash)).toMatchObject({ status: "ready" })
    expect(modal.at(-1)).toBe(true)
    harness.mockInput.pressEscape()
    await screen("the preview closed", (text) => !text.includes("Enter / Esc / q close"))
    expect(modal.at(-1)).toBe(false)
    // A picture the server does not hold: its refusal, in the server's words.
    harness.mockInput.pressArrow("down")
    await screen("the block's picture selected", (text) => text.includes("The cellar door  Enter: view"))
    harness.mockInput.pressEnter()
    await screen("the refusal", (text) => text.includes("refused: media_not_found"))
  })

  test("F8 shares a local picture: the file is offered, sent, and the table sees it", async () => {
    const server = new FakeServer()
    table(server)
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-share-"))
    const png = new PNG({ width: 1, height: 1 })
    await writeFile(join(dir, "handout.png"), PNG.sync.write(png))
    const { harness, screen } = await play(server, { pictureGraphics: false, pictureEnv: {} })
    harness.mockInput.pressKey("F8")
    await screen("the share form", (text) => text.includes("Share a picture with the table"))
    await harness.mockInput.typeText(join(dir, "nope.png"))
    harness.mockInput.pressEnter()
    await screen("the missing file said plainly", (text) => text.includes("No such file"))
    for (let i = 0; i < "nope.png".length; i += 1) harness.mockInput.pressBackspace()
    await harness.mockInput.typeText("handout.png")
    harness.mockInput.pressEnter()
    await screen("the shared picture in the log", (text) => text.includes("handout.png — shared by Ada") && !text.includes("Share a picture with the table"))
    expect(server.offered[0]).toMatchObject({ name: "handout.png", mime: "image/png", purpose: "share" })
  })

  test("the share form says why when uploads are off; an observer is told too", async () => {
    const server = new FakeServer()
    table(server)
    server.views.set("room", { locale: "en", localeLabel: "English", system: null, variant: null, keeperMuted: false, uploads: false })
    const { harness, screen } = await play(server)
    await screen("the room view", (text) => text.includes("joined arkham"))
    await waitFor("the room view", () => server.current.calls("view.subscribe").length > 0)
    harness.mockInput.pressKey("F8")
    await screen("the reason", (text) => text.includes("The admin has turned uploads off in this room"))
    harness.mockInput.pressEscape()
    await screen("closed", (text) => !text.includes("turned uploads off"))

    const watcher = new FakeServer({ role: "observer" })
    const second = await play(watcher)
    second.harness.mockInput.pressKey("F8")
    await second.screen("the observer's reason", (text) => text.includes("Observers cannot upload files"))
  })

  test("the header says what the room plays, from the audio view, and the muted mark from the sound controller", async () => {
    const server = new FakeServer()
    table(server)
    const playing = { id: "harbor/rain", title: "Rain on the quay", hash: "b".repeat(64), mime: "audio/ogg", size: 10, loop: true, volume: 1, paused: false }
    server.views.set("audio", { library: [{ hash: "b".repeat(64), mime: "audio/ogg", size: 10 }], playing: { bgm: playing } })
    // Muted: the controller never fetches or starts a player, so nothing here makes a sound.
    const silent: FetchSound = () => Promise.reject(new Error("no fetch while muted"))
    const { screen, connection } = await play(server, {}, 170)
    await screen("the music", (text) => text.includes("· Music: Rain on the quay"))
    server.view("audio", { library: [], playing: { bgm: { ...playing, paused: true }, ambience: { ...playing, id: "harbor/gulls", title: "Gulls" } } })
    await screen("paused, and the ambience", (text) => text.includes("Music: Rain on the quay (paused) · Ambience: Gulls"))

    const audio = new AudioController({ session: connection.session, fetchSound: silent, muted: true, which: () => null, onProcessExit: () => () => undefined })
    const second = await play(server, { audio }, 170)
    await second.screen("the muted mark", (text) => text.includes("Ambience: Gulls · sound muted (F9)"))
    audio.dispose()
  })

  test("a notice reads as a warning line apart from the story; the scene panel lists what the table established", async () => {
    const server = new FakeServer()
    table(server)
    server.views.set("scene", { name: "Cellar", focus: "", established: [{ text: "The door is locked", at: "23:10" }, { text: "Martha lied", at: null }], time: null, clockModule: null, round: null })
    const { screen } = await play(server)
    await screen("the scene", (text) => text.includes("ESTABLISHED"))
    server.signal("notice", { level: "warn", code: "provider_auth", text: "The model provider refused the login." })
    const frame = await screen("the notice", (text) => text.includes("[WARN] The model provider refused the login."))
    expect(frame).toContain("· The door is locked (23:10)")
    expect(frame).toContain("· Martha lied")
  })
})
