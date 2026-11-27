import { afterEach, describe, expect, test } from "bun:test"
import { App, type AppProps } from "./App"
import { AudioController } from "./audio"
import type { HostHandle } from "./hostLocal"
import type { IrohMode } from "./irohLink"
import { FakeServer, liveRender, pump, waitFor, waitForScreen } from "./testkit"

const TICKET = "endpointabcdefghijklmnopqrstuvwxyz234567"
const PAGE_UP = "\x1b[5~"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

async function boot(server: FakeServer, props: Partial<AppProps> = {}) {
  const modes: IrohMode[] = []
  const remembered: Array<{ host: string; key: string; name?: string }> = []
  const harness = await liveRender(
    <App
      prefill={{ locale: "en", host: TICKET, key: "player-key", name: "Ada" }}
      dial={(mode) => {
        modes.push(mode)
        return server.dial
      }}
      onRememberConnect={(memory) => remembered.push(memory)}
      platform="linux"
      {...props}
    />,
    { width: 110, height: 34 },
  )
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  return { harness, screen, modes, remembered }
}

describe("App", () => {
  test("connect → welcome → menu → game, remembering the server; Esc back to the menu", async () => {
    const server = new FakeServer()
    server.views.set("me", { member: { id: "m1", name: "Ada", role: "player", roleLabel: "Investigator" }, character: null })
    const { harness, screen, modes, remembered } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    const menu = await screen("the menu", (text) => text.includes("Enter game"))
    expect(menu).toContain("Table \"arkham\"")
    expect(menu).toContain("Ada · Investigator")
    expect(modes).toEqual(["n0"])
    expect(remembered).toEqual([{ host: TICKET, key: "player-key", name: "Ada" }])
    expect(server.current.sent[0]).toMatchObject({ type: "hello", key: "player-key", name: "Ada", locale: "en" })
    harness.mockInput.pressEnter()
    await screen("the game view", (text) => text.includes("say or command"))
    server.say("The fog rolls in.")
    await screen("a line in the log", (text) => text.includes("The fog rolls in."))
    harness.mockInput.pressEscape()
    await screen("the menu again", (text) => text.includes("Enter game"))
  })

  test("a refused key ends the session and the connect screen says why", async () => {
    const server = new FakeServer()
    server.refuseHello = { code: "bad_key", message: "That key is not known here." }
    const { harness, screen, remembered } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    await screen("the refusal", (text) => text.includes("That key is not known here."))
    expect(remembered).toEqual([])
  })

  test("another protocol major is refused in the person's words", async () => {
    const server = new FakeServer()
    server.protocol = "4.0"
    const { harness, screen } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    await screen("the mismatch", (text) => text.includes("Protocol 4.0 ≠ 3.0"))
  })

  test("an unreachable ticket, a WebSocket address, a non-ticket and a missing key are each said plainly", async () => {
    const server = new FakeServer()
    server.unreachable = true
    const first = await boot(server)
    await first.screen("the connect screen", (text) => text.includes("⚄ Connect"))
    first.harness.mockInput.pressEnter()
    await first.screen("the dial failure", (text) => text.includes("Could not reach the server: no route to peer"))

    const ws = await boot(new FakeServer(), { prefill: { locale: "en", host: "ws://127.0.0.1:8787", key: "k" } })
    await ws.screen("the connect screen", (text) => text.includes("⚄ Connect"))
    ws.harness.mockInput.pressEnter()
    await ws.screen("the WebSocket refusal", (text) => text.includes("connects by ticket only") && text.includes("addresses are not supported"))

    const junk = await boot(new FakeServer(), { prefill: { locale: "en", host: "hello", key: "k" } })
    await junk.screen("the connect screen", (text) => text.includes("⚄ Connect"))
    junk.harness.mockInput.pressEnter()
    await junk.screen("the ticket refusal", (text) => text.includes("That is not a ticket"))

    const nokey = await boot(new FakeServer(), { prefill: { locale: "en", host: TICKET } })
    await nokey.screen("the connect screen", (text) => text.includes("⚄ Connect"))
    nokey.harness.mockInput.pressEnter()
    await nokey.screen("the key refusal", (text) => text.includes("An access key is required"))
  })

  test("host locally: the bring-up's admin key is kept, the server dialled on loopback, the admin welcomed", async () => {
    const server = new FakeServer({ role: "admin", name: "Admin", room: "main" })
    const kept: Array<{ home: string; key: string }> = []
    let stopped = 0
    const bringUp: AppProps["bringUp"] = async (onLog, _signal, options) => {
      onLog({ kind: "step", key: "hostlocal.step.starting", vars: { dir: "/tmp/data" } })
      expect(options.knownKey).toBeUndefined()
      return { ticket: TICKET, key: "first-admin-key", newKey: true, stop: async () => void (stopped += 1) } satisfies HostHandle
    }
    const { harness, screen, modes, remembered } = await boot(server, { bringUp, onLocalKey: (entry) => kept.push(entry), prefill: { locale: "en", localServerHome: "/srv/lw" } })
    await screen("the connect screen", (text) => text.includes("Host locally"))
    // The host button is the first clickable row; reach it by mouse.
    const frame = harness.captureCharFrame()
    const row = frame.split("\n").findIndex((line) => line.includes("Host locally & play"))
    const col = (frame.split("\n")[row] ?? "").indexOf("Host locally")
    await harness.mockMouse.click(col + 2, row)
    const menu = await screen("the admin's menu", (text) => text.includes("Enter game"))
    expect(menu).toContain("Admin · Admin")
    expect(menu).toContain("every room operation is a command")
    expect(kept).toEqual([{ home: "/srv/lw", key: "first-admin-key" }])
    expect(modes).toEqual(["local"])
    expect(remembered).toEqual([])
    expect(server.current.sent[0]).toMatchObject({ type: "hello", key: "first-admin-key" })
    expect(stopped).toBe(0)
  })

  test("the command list comes from the commands view", async () => {
    const server = new FakeServer()
    server.views.set("commands", {
      commands: [
        { id: "roll", source: "engine", title: "Roll dice", description: "Roll a dice expression.", params: {}, text: { forms: ["r", "roll"], usage: ".r 3d6" }, role: "player", available: true },
        { id: "reset", source: "engine", title: "Reset the room", description: "Wipe the campaign.", params: {}, text: { forms: ["reset"], usage: ".reset story" }, role: "admin", danger: true, available: false, reason: "Admins only." },
      ],
    })
    const { harness, screen } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    await screen("the menu", (text) => text.includes("Enter game"))
    harness.mockInput.pressArrow("down")
    await pump()
    harness.mockInput.pressArrow("down")
    await pump()
    harness.mockInput.pressEnter()
    const list = await screen("the command list", (text) => text.includes("Roll dice"))
    expect(list).toContain("✓ roll  .r 3d6 — Roll dice")
    expect(list).toContain("Roll a dice expression.")
    expect(list).toContain("Not available to you now")
    expect(list).toContain("✗ reset  .reset story — Reset the room [admin] [destructive]")
    expect(list).toContain("why: Admins only.")
    await harness.mockInput.typeText("res")
    const filtered = await screen("the filtered list", (text) => !text.includes("Roll dice"))
    expect(filtered).toContain("Reset the room")
    harness.mockInput.pressEscape()
    await screen("the menu again", (text) => text.includes("Enter game"))
  })

  test("settings show who you are and the room's language and rule system from the room view", async () => {
    const server = new FakeServer({ role: "observer", name: "Cyd" })
    server.views.set("room", { locale: "zh", localeLabel: "中文", system: { id: "coc7", label: "Call of Cthulhu 7e" }, variant: null, keeperMuted: false, uploads: false })
    const { harness, screen } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    await screen("the menu", (text) => text.includes("Enter game"))
    for (let i = 0; i < 3; i += 1) {
      harness.mockInput.pressArrow("down")
      await pump()
    }
    harness.mockInput.pressEnter()
    const settings = await screen("the settings", (text) => text.includes("Signed in as") && text.includes("Room language"))
    expect(settings).toContain("Signed in as Cyd · room arkham · Observer")
    expect(settings).toContain("Room language 中文 · rule system Call of Cthulhu 7e")
    harness.mockInput.pressEscape()
    await screen("the menu again", (text) => text.includes("Enter game"))
  })

  test("a connection that drops is redialled with the same session, not sent back to the connect screen", async () => {
    const server = new FakeServer()
    const { harness, screen } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    await screen("the menu", (text) => text.includes("Enter game"))
    harness.mockInput.pressEnter()
    await screen("the game", (text) => text.includes("say or command"))
    server.current.drop()
    await screen("reconnecting", (text) => text.includes("reconnecting…"))
    await waitFor("the redial", () => server.transports.length === 2 && server.current.sent.some((frame) => frame.type === "hello"), undefined, () => pump(1))
    await screen("online again", (text) => text.includes("● online"))
    harness.mockInput.pressKey(PAGE_UP)
  })

  test("host locally by keyboard: Tab reaches the button, Enter starts it; Disconnect stops that server and returns to the connect screen", async () => {
    const server = new FakeServer({ role: "admin", name: "Admin", room: "main" })
    let stopped = 0
    const bringUp: AppProps["bringUp"] = async () => ({ ticket: TICKET, key: "first-admin-key", newKey: true, stop: async () => void (stopped += 1) })
    const { harness, screen } = await boot(server, { bringUp, prefill: { locale: "en", localServerHome: "/srv/lw" } })
    await screen("the connect screen", (text) => text.includes("Host locally"))
    // Ticket → key → name → the button.
    for (let i = 0; i < 3; i += 1) {
      harness.mockInput.pressTab()
      await pump()
    }
    await screen("the button focused", (text) => text.includes("› ⌂ Host locally & play  Enter"))
    harness.mockInput.pressEnter()
    const menu = await screen("the admin's menu", (text) => text.includes("Enter game") && text.includes("Disconnect"))
    expect(menu).toContain("Import a world card")
    // Enter game, My character, Commands, Import a world card, Add a sound, Settings, Disconnect.
    for (let i = 0; i < 6; i += 1) {
      harness.mockInput.pressArrow("down")
      await pump()
    }
    harness.mockInput.pressEnter()
    await screen("the connect screen again", (text) => text.includes("⚄ Connect"))
    await waitFor("the local server stopped", () => stopped === 1)
    expect(server.current.closed).toBe(true)
  })

  test("when the server this client started exits, the client stops redialling and offers the way back", async () => {
    const server = new FakeServer({ role: "admin", name: "Admin", room: "main" })
    let exit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => (exit = resolve))
    const bringUp: AppProps["bringUp"] = async () => ({ ticket: TICKET, key: "first-admin-key", newKey: true, stop: async () => {}, exited })
    const { harness, screen } = await boot(server, { bringUp, prefill: { locale: "en" } })
    await screen("the connect screen", (text) => text.includes("Host locally"))
    const frame = harness.captureCharFrame()
    const row = frame.split("\n").findIndex((line) => line.includes("Host locally & play"))
    await harness.mockMouse.click((frame.split("\n")[row] ?? "").indexOf("Host locally") + 2, row)
    await screen("the menu", (text) => text.includes("Enter game"))
    server.unreachable = true
    server.current.drop()
    exit(1)
    await screen("the lost screen", (text) => text.includes("The local server this client started has exited"))
    harness.mockInput.pressEnter()
    await screen("the connect screen again", (text) => text.includes("⚄ Connect"))
  })

  test("settings say plainly that server messages change language on the next connect", async () => {
    const server = new FakeServer()
    const { harness, screen } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    await screen("the menu", (text) => text.includes("Enter game"))
    for (let i = 0; i < 3; i += 1) {
      harness.mockInput.pressArrow("down")
      await pump()
    }
    harness.mockInput.pressEnter()
    await screen("the settings", (text) => text.includes("from the next connect"))
    harness.mockInput.pressArrow("right")
    await screen("the warning in the new language", (text) => text.includes("断开后重新连接才会切换"))
  })

  test("Esc in the game view closes an open share form, not the game", async () => {
    const server = new FakeServer()
    const { harness, screen } = await boot(server)
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    await screen("the menu", (text) => text.includes("Enter game"))
    harness.mockInput.pressEnter()
    await screen("the game", (text) => text.includes("say or command"))
    harness.mockInput.pressKey("F8")
    await screen("the share form", (text) => text.includes("Share a picture with the table"))
    harness.mockInput.pressEscape()
    const after = await screen("the form closed", (text) => !text.includes("Share a picture with the table"))
    expect(after).toContain("say or command")
  })

  test("an admin adds a sound from the menu; F9 mutes anywhere, is remembered, and reaches the sound controller", async () => {
    const server = new FakeServer({ role: "admin" })
    const controllers: AudioController[] = []
    const mutes: boolean[] = []
    const { harness, screen } = await boot(server, {
      onMutedChange: (muted) => mutes.push(muted),
      // Players that never run: no sound and no process from a test.
      makeAudio: (connection, muted) => {
        const audio = new AudioController({ session: connection.session, fetchSound: () => Promise.reject(new Error("unused")), muted, which: () => null, onProcessExit: () => () => undefined })
        controllers.push(audio)
        return audio
      },
    })
    await screen("the connect screen", (text) => text.includes("⚄ Connect"))
    harness.mockInput.pressEnter()
    const menu = await screen("the menu", (text) => text.includes("Add a sound"))
    expect(menu).toContain("Import a world card")
    // Enter game, My character, Commands, Import a world card, Add a sound.
    for (let i = 0; i < 4; i += 1) {
      harness.mockInput.pressArrow("down")
      await pump()
    }
    harness.mockInput.pressEnter()
    await screen("the sound form", (text) => text.includes("Add a sound to the room's audio library"))
    harness.mockInput.pressEscape()
    await screen("back to the menu", (text) => text.includes("Enter game"))

    expect(controllers).toHaveLength(1)
    expect(controllers[0]!.getState().muted).toBe(false)
    harness.mockInput.pressKey("F9")
    await waitFor("muted", () => controllers[0]!.getState().muted)
    expect(mutes).toEqual([true])
    harness.mockInput.pressKey("F9")
    await waitFor("unmuted", () => !controllers[0]!.getState().muted)
    expect(mutes).toEqual([true, false])
  })
})
