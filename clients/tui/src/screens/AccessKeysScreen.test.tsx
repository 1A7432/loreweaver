import { afterEach, describe, expect, test } from "bun:test"
import type { Role } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { itemsToTranscript } from "../transcript"
import { logItems } from "../log"
import { FakeServer, liveRender, pump, waitFor, waitForScreen, withoutActWarning } from "../testkit"
import { themes } from "../themes"
import { AccessKeysScreen } from "./AccessKeysScreen"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

const NEW_KEY = "NEWKEY-sentinel-4f9a1c0b7d2e8a63"
const KEYS = {
  keys: [
    { id: "k:aaaaaaaaaaaa", name: "Ada", role: "admin", masked: "Ab3x...Zq9w", created: 1_700_000_000_000, online: true },
    { id: "k:bbbbbbbbbbbb", name: "Cleo", role: "player", masked: "Q1w2...e3r4", online: false },
    { id: "k:cccccccccccc", name: "Eve", role: "observer", masked: "m7n8...p0q1", online: false },
  ],
}

async function open(server: FakeServer, onBack: () => void = () => {}, notice?: string, renderOptions: { kittyKeyboard?: boolean } = {}) {
  const connection = server.connect()
  connections.push(connection)
  await connection.start()
  await waitFor("the welcome", () => connection.session.status === "online")
  const harness = await withoutActWarning(() => liveRender(<AccessKeysScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="en" platform="linux" copyNotice={notice} onBack={onBack} />, { width: 110, height: 34, ...renderOptions }))
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  const calls = () => server.current.calls("command.run").map((call) => call.params)
  // A key press is done when the event loop has run and the screen has settled on what it caused.
  const press = async (action: () => void) => {
    action()
    await pump()
    await harness.flush()
  }
  return { connection, harness, screen, calls, press }
}

/** From the top of the list, down to the `row`th key (the first row is "Mint a new key"), then Enter. */
async function pickKey(press: (action: () => void) => Promise<void>, harness: { mockInput: { pressArrow(direction: "down"): void; pressEnter(): void } }, row: number) {
  for (let i = 0; i < row; i += 1) await press(() => harness.mockInput.pressArrow("down"))
  await press(() => harness.mockInput.pressEnter())
}

function adminServer(): FakeServer {
  const server = new FakeServer({ role: "admin", name: "Ada" })
  server.views.set("admin/keys", KEYS)
  return server
}

describe("AccessKeysScreen", () => {
  test("lists the room's keys: name, role in words, the masked key and who is online; subscribes admin/keys only while open", async () => {
    const server = adminServer()
    const { screen, connection, harness } = await open(server)
    const frame = await screen("the keys", (text) => text.includes("Cleo"))
    expect(frame).toContain("+ Mint a new key")
    expect(frame).toContain("Ada · admin · Ab3x...Zq9w · ● online")
    expect(frame).toContain("Cleo · player · Q1w2...e3r4")
    expect(frame).not.toContain("Cleo · player · Q1w2...e3r4 · ●")
    expect(frame).toContain("Eve · observer · m7n8...p0q1")
    // Never the word for the AI: a person who holds the admin key is the room's admin.
    expect(frame.toLowerCase()).not.toContain("keeper")
    const subscribed = server.current.calls("view.subscribe").flatMap((call) => call.params.names as string[])
    expect(subscribed.filter((name) => name.startsWith("admin/"))).toEqual(["admin/keys"])
    expect(connection.session.getSnapshot().views.has("admin/keys")).toBe(true)
    harness.renderer.destroy()
    harnesses.pop()
    await waitFor("the view dropped", () => !connection.session.getSnapshot().views.has("admin/keys"))
    await waitFor("the unsubscribe sent", () => server.current.calls("view.unsubscribe").some((call) => (call.params.names as string[]).includes("admin/keys")))
  })

  test("a player who somehow reaches the screen is told it is for admins and never subscribes to an admin view", async () => {
    const server = new FakeServer({ role: "player" })
    server.views.set("admin/keys", KEYS)
    let left = 0
    const { screen, harness } = await open(server, () => (left += 1))
    const frame = await screen("the refusal", (text) => text.includes("for the room's admins"))
    expect(frame).not.toContain("Cleo")
    await pump(5)
    expect(server.current.calls("view.subscribe").flatMap((call) => call.params.names as string[]).some((name) => name.startsWith("admin/"))).toBe(false)
    harness.mockInput.pressEscape()
    await waitFor("back", () => left === 1)
  })

  test("minting: a form (name, role), then the new key and the ticket once on their own panel; the key never reaches the log lines or the transcript, and is gone after the panel", async () => {
    const server = adminServer()
    server.onCall = (method, params) => {
      if (method === "command.run" && params.id === "key") {
        return {
          ok: true,
          text: `New player key for Dana (k:dddddddddddd):\n${NEW_KEY}\nIt is shown this once: hand it to them now, it cannot be shown again.`,
          data: { id: "k:dddddddddddd", name: "Dana", role: "player", key: NEW_KEY },
        }
      }
      return { ok: true }
    }
    const { harness, screen, calls, connection, press } = await open(server, () => {}, "Copied 33 characters to the clipboard")
    await screen("the keys", (text) => text.includes("Cleo"))
    harness.mockInput.pressEnter()
    await screen("the form", (text) => text.includes("Tab name / role"))
    await harness.mockInput.typeText("Dana")
    await screen("the typed name", (text) => text.includes("Dana"))
    harness.mockInput.pressEnter()
    await waitFor("the mint", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "key", args: { op: "mint", name: "Dana", role: "player" } })
    const panel = await screen("the key panel", (text) => text.includes(NEW_KEY))
    expect(panel).toContain("New key for Dana (player)")
    expect(panel).toContain("endpointfaketicketfaketicketfake")
    expect(panel).toContain("shown only now")
    expect(panel).toContain("they paste the ticket and the")
    // Selected text is copied with Ctrl+C here (not quit), and the app's confirmation shows.
    expect(panel).toContain("drag to select, Ctrl+C to copy")
    expect(panel).toContain("Copied 33 characters to the clipboard")

    // Held by the panel alone: not in the log lines the narrative view and the transcript are built from.
    const everywhere = () => {
      const snapshot = connection.session.getSnapshot()
      const lines = connection.getState().lines
      return JSON.stringify([lines, [...snapshot.views], snapshot.events, snapshot.viewProblems, [...connection.getState().fetches]]) + itemsToTranscript(logItems(snapshot.events, snapshot.drafts, lines), { at: new Date(0) })
    }
    expect(everywhere()).not.toContain(NEW_KEY)

    // The server's refreshed list names the new key (masked); the panel stays until it is left.
    server.view("admin/keys", { keys: [...KEYS.keys, { id: "k:dddddddddddd", name: "Dana", role: "player", masked: "NEWK...8a63", online: false }] })
    await pump()
    await screen("still the panel", (text) => text.includes(NEW_KEY))
    await press(() => harness.mockInput.pressEscape())
    const list = await screen("the list again", (text) => text.includes("Dana · player · NEWK...8a63"))
    expect(list).not.toContain(NEW_KEY)
    expect(list).not.toContain("endpointfaketicket")
    expect(everywhere()).not.toContain(NEW_KEY)
  })

  test("a role other than player is chosen on the form with Tab and the arrows", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: true, text: `x\n${NEW_KEY}`, data: { id: "k:dddddddddddd", name: "Zed", role: "observer", key: NEW_KEY } })
    const { harness, screen, calls, press } = await open(server)
    await screen("the keys", (text) => text.includes("Cleo"))
    await press(() => harness.mockInput.pressKey("n"))
    await screen("the form", (text) => text.includes("Tab name / role"))
    await harness.mockInput.typeText("Zed")
    await press(() => harness.mockInput.pressTab())
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressArrow("down"))
    harness.mockInput.pressEnter()
    await waitFor("the mint", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "key", args: { op: "mint", name: "Zed", role: "observer" satisfies Role } })
    await screen("the key panel", (text) => text.includes("New key for Zed (observer)"))
  })

  test("a mint with no name is not sent; the server's refusal of a mint is shown in its words", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: false, code: "bad_key_name", message: "That name cannot be used (1 to 64 characters)." })
    const { harness, screen, calls, press } = await open(server)
    await screen("the keys", (text) => text.includes("Cleo"))
    await press(() => harness.mockInput.pressEnter())
    await screen("the form", (text) => text.includes("Tab name / role"))
    await press(() => harness.mockInput.pressEnter())
    await screen("the local refusal", (text) => text.includes("Give the key a name."))
    expect(calls()).toHaveLength(0)
    await harness.mockInput.typeText("   x")
    await press(() => harness.mockInput.pressEnter())
    await screen("the server's words", (text) => text.includes("That name cannot be used (1 to 64 characters)."))
    expect(calls()).toHaveLength(1)
  })

  test("revoking asks first: Esc cancels without a call, Enter sends the typed revoke", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: true, text: "Revoked Cleo (k:bbbbbbbbbbbb); whoever was connected with it was disconnected.", data: { id: "k:bbbbbbbbbbbb", revoked: true } })
    const { harness, screen, calls, press } = await open(server)
    await screen("the keys", (text) => text.includes("Cleo"))
    await pickKey(press, harness, 2)
    const actions = await screen("the actions", (text) => text.includes("Change role"))
    expect(actions).toContain("Cleo · player · Q1w2...e3r4")
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressEnter())
    const confirm = await screen("the confirmation", (text) => text.includes("Revoke Cleo's key?"))
    expect(confirm).toContain("whoever is connected")
    await press(() => harness.mockInput.pressEscape())
    await screen("the actions again", (text) => text.includes("Change role"))
    expect(calls()).toHaveLength(0)

    // The cursor is still on Revoke.
    await press(() => harness.mockInput.pressEnter())
    await screen("the confirmation again", (text) => text.includes("Revoke Cleo's key?"))
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the revoke", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "key", args: { op: "revoke", id: "k:bbbbbbbbbbbb" } })
    await screen("the answer", (text) => text.includes("Revoked Cleo (k:bbbbbbbbbbbb)") && text.includes("Mint a new key"))
  })

  test("a refused revoke shows the server's message, whatever its code", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: false, code: "last_admin", message: "That is this room's last admin key: mint another admin key first." })
    const { harness, screen, calls, press } = await open(server)
    await screen("the keys", (text) => text.includes("Ada"))
    await pickKey(press, harness, 1)
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressEnter())
    await press(() => harness.mockInput.pressEnter())
    const frame = await screen("the refusal", (text) => text.includes("last admin key"))
    expect(frame).toContain("That is this room's last admin key: mint another admin key first.")
    expect(calls()[0]).toEqual({ id: "key", args: { op: "revoke", id: "k:aaaaaaaaaaaa" } })
    // Back on the actions, not in a confirmation that would invite the same refusal again.
    expect(frame).toContain("Change role")
  })

  test("rename and role send typed arguments", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: true, text: "done" })
    const { harness, screen, calls, press } = await open(server)
    await screen("the keys", (text) => text.includes("Cleo"))
    await pickKey(press, harness, 2)
    await press(() => harness.mockInput.pressEnter())
    const rename = await screen("the rename form", (text) => text.includes("Rename Cleo"))
    expect(rename).toContain("Cleo")
    for (let i = 0; i < "Cleo".length; i += 1) harness.mockInput.pressBackspace()
    await harness.mockInput.typeText("Cleopatra")
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the rename", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "key", args: { op: "rename", id: "k:bbbbbbbbbbbb", name: "Cleopatra" } })
    await screen("back on the list", (text) => text.includes("Mint a new key"))

    // The selection stays on Cleo's row after the list comes back.
    await press(() => harness.mockInput.pressEnter())
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressEnter())
    await screen("the role form", (text) => text.includes("Role of Cleo"))
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the role", () => calls().length === 2)
    expect(calls()[1]).toEqual({ id: "key", args: { op: "role", id: "k:bbbbbbbbbbbb", role: "admin" } })
  })

  test("while a key is being minted, Esc waits for the answer instead of losing the key", async () => {
    const server = adminServer()
    server.onCall = () => null
    // The Esc must REACH the screen while the mint is pending. A bare Esc byte is held back by
    // the input parser for some milliseconds of real time (it may begin a longer sequence), so
    // it could land after the answer and close the key panel instead; the kitty keyboard
    // protocol's Esc is a whole sequence, delivered as it is pressed.
    const { harness, screen, calls, press } = await open(server, () => {}, undefined, { kittyKeyboard: true })
    await screen("the keys", (text) => text.includes("Cleo"))
    await press(() => harness.mockInput.pressEnter())
    await screen("the form", (text) => text.includes("Tab name / role"))
    await harness.mockInput.typeText("Dana")
    await screen("the typed name", (text) => text.includes("Dana"))
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the mint", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "key", args: { op: "mint", name: "Dana", role: "player" } })
    await screen("busy", (text) => text.includes("Working…"))
    await press(() => harness.mockInput.pressEscape())
    const frame = await screen("still the form", (text) => text.includes("Working…"))
    expect(frame).toContain("Tab name / role")
    const rid = server.current.calls("command.run")[0]!.rid
    server.current.push({ type: "result", rid, ok: true, text: NEW_KEY, data: { id: "k:dddddddddddd", name: "Dana", role: "player", key: NEW_KEY } })
    await screen("the key panel", (text) => text.includes(NEW_KEY))
  })
})
