import { afterEach, describe, expect, test } from "bun:test"
import type { Connection } from "../connection"
import { logItems } from "../log"
import { FakeServer, liveRender, pump, waitFor, waitForScreen, withoutActWarning } from "../testkit"
import { themes } from "../themes"
import { itemsToTranscript } from "../transcript"
import { endpointName, ModelScreen } from "./ModelScreen"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

const SENTINEL = "sk-SENTINEL-7f3a9c0d1e2b4a68-zzzz"
const KEY = { set: true, masked: "sk-a...wxyz" }
const NO_KEY = { set: false, masked: null }
const lane = (name: string, over: Record<string, unknown>) => ({ lane: name, source: "default", sameAsKeeper: false, provider: null, model: null, baseUrl: null, wire: null, effort: null, contextWindow: null, key: NO_KEY, ...over })
const MODEL = {
  lanes: [
    lane("keeper", { source: "override", provider: "deepseek", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com", wire: "openai-compatible", key: KEY }),
    lane("npc", { sameAsKeeper: true, provider: "deepseek", model: "deepseek-v4-pro", key: KEY }),
    lane("scribe", { source: "override", provider: "openai", model: "gpt-5-mini" }),
    lane("director", { sameAsKeeper: true, provider: "deepseek", model: "deepseek-v4-pro", key: KEY }),
    lane("memory", { source: "environment", provider: "anthropic", model: "claude-haiku", key: KEY }),
  ],
  providers: [
    { id: "openai", preset: true, wire: "openai-compatible", baseUrl: "https://api.openai.com/v1", credential: false },
    { id: "deepseek", preset: true, wire: "openai-compatible", baseUrl: "https://api.deepseek.com", credential: true },
    { id: "anthropic", preset: true, wire: "anthropic", baseUrl: "https://api.anthropic.com", credential: true },
  ],
  imagegen: { source: "default", enabled: false, provider: null, model: null, size: null, baseUrl: null, key: NO_KEY },
  imageProviders: [
    { id: "openai", credential: false },
    { id: "xai", credential: false },
  ],
}
const IMAGE_ON = { ...MODEL, imagegen: { source: "override", enabled: true, provider: "openai", model: "gpt-image-1", size: "1024x1024", baseUrl: "https://api.openai.com/v1", key: KEY } }

async function open(server: FakeServer, onBack: () => void = () => {}) {
  const connection = server.connect()
  connections.push(connection)
  await connection.start()
  await waitFor("the welcome", () => connection.session.status === "online")
  const harness = await withoutActWarning(() => liveRender(<ModelScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="en" onBack={onBack} />, { width: 110, height: 40 }))
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  const calls = () => server.current.calls("command.run").map((call) => call.params)
  // A key press is done when the event loop has run and the screen has settled on what it caused.
  const press = async (action: () => void) => {
    action()
    await pump()
    await harness.flush()
  }
  const down = async (times: number) => {
    for (let i = 0; i < times; i += 1) await press(() => harness.mockInput.pressArrow("down"))
  }
  const tab = async (times = 1) => {
    for (let i = 0; i < times; i += 1) await press(() => harness.mockInput.pressTab())
  }
  const backspaces = async (times: number) => {
    for (let i = 0; i < times; i += 1) harness.mockInput.pressBackspace()
    await pump()
  }
  /** From the overview: the `row`th row (0 = Keeper … 5 = Pictures), Enter, then the first action (Set …), Enter. */
  const openForm = async (row: number) => {
    await down(row)
    await press(() => harness.mockInput.pressEnter())
    await press(() => harness.mockInput.pressEnter())
    // Typing starts only once the form is on screen and has the focus.
    await screen("the form", (text) => text.includes("Set the model for") || text.includes("Set the picture maker"))
  }
  return { connection, harness, screen, calls, press, down, tab, backspaces, openForm }
}

/** A frame as running text: the box borders gone and wrapped lines joined. */
const flat = (frame: string) => frame.replace(/[│┌┐└┘─]/gu, " ").replace(/\s+/g, " ")

function adminServer(view: unknown = MODEL): FakeServer {
  const server = new FakeServer({ role: "admin", name: "Ada" })
  server.views.set("admin/model", view)
  return server
}

test("an endpoint the operator named by URL only is called by its host, never \"?\" while an address is known", () => {
  expect(endpointName("deepseek", "https://api.deepseek.com/v1")).toBe("deepseek")
  expect(endpointName(null, "https://llm.example.net:8443/v1")).toBe("llm.example.net:8443")
  expect(endpointName(null, "not a url")).toBe("?")
  expect(endpointName(null, null)).toBe("?")
  // A name from a server is content: control characters never reach the terminal.
  expect(endpointName("evil\x1b[2Jname", null)).not.toContain("\x1b")
})

describe("ModelScreen", () => {
  test("shows each lane's provider, model, where it comes from and its key; a lane that follows the Keeper's is one short line; pictures too", async () => {
    const server = adminServer()
    const { screen, connection, harness } = await open(server)
    const frame = await screen("the lanes", (text) => text.includes("Pictures"))
    expect(frame).toContain("Server-wide: every room follows it.")
    expect(frame).toContain("Keeper: deepseek / deepseek-v4-pro")
    expect(frame).toContain("set by an admin · key sk-a...wxyz")
    expect(frame).toContain("NPCs: same as the Keeper")
    expect(frame).toContain("Scribe: openai / gpt-5-mini")
    expect(frame).toContain("set by an admin · no key")
    expect(frame).toContain("Stage Director: same as the Keeper")
    expect(frame).toContain("Memory: anthropic / claude-haiku")
    expect(frame).toContain("server settings · key sk-a...wxyz")
    expect(frame).toContain("Pictures: off")
    // Only the Keeper's own detail is shown once: the lanes that follow it carry none.
    expect(frame.split("key sk-a...wxyz").length - 1).toBe(2)
    const subscribed = server.current.calls("view.subscribe").flatMap((call) => call.params.names as string[])
    expect(subscribed.filter((name) => name.startsWith("admin/"))).toEqual(["admin/model"])
    harness.renderer.destroy()
    harnesses.pop()
    await waitFor("the view dropped", () => !connection.session.getSnapshot().views.has("admin/model"))
    await waitFor("the unsubscribe sent", () => server.current.calls("view.unsubscribe").some((call) => (call.params.names as string[]).includes("admin/model")))
  })

  test("pictures that are on show their provider, model and size", async () => {
    const { screen } = await open(adminServer(IMAGE_ON))
    const frame = await screen("the pictures", (text) => text.includes("Pictures: openai"))
    expect(frame).toContain("Pictures: openai / gpt-image-1 · 1024x1024")
  })

  test("a player never subscribes to the admin view and is told the screen is for admins", async () => {
    const server = new FakeServer({ role: "player" })
    server.views.set("admin/model", MODEL)
    let left = 0
    const { screen, harness } = await open(server, () => (left += 1))
    const frame = await screen("the refusal", (text) => text.includes("for the room's admins"))
    expect(frame).not.toContain("deepseek")
    await pump(5)
    expect(server.current.calls("view.subscribe").flatMap((call) => call.params.names as string[]).some((name) => name.startsWith("admin/"))).toBe(false)
    harness.mockInput.pressEscape()
    await waitFor("back", () => left === 1)
  })

  test("setting a model with a key: the key is masked while typed, sent only inside the one command.run call, cleared at once, and found nowhere else", async () => {
    const server = adminServer()
    server.onCall = (method, params) => {
      if (method === "command.run" && params.id === "model") return { ok: true, text: "keeper now uses deepseek / deepseek-v4-flash.\nKey: sk-S...zzzz", data: { lane: {}, keySaved: true } }
      return { ok: true }
    }
    const logged: string[] = []
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => {
      const original = console[name]
      console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
      return () => {
        console[name] = original
      }
    })
    const frames: string[] = []
    try {
      const { harness, screen, calls, connection, tab, backspaces, openForm, press } = await open(server)
      await screen("the lanes", (text) => text.includes("Pictures"))
      await openForm(0)
      const form = await screen("the form", (text) => text.includes("Set the model for Keeper"))
      expect(form).toContain("deepseek · key saved")
      // Provider → model (prefilled with the lane's own) → the list button → the key.
      await tab()
      await backspaces("deepseek-v4-pro".length)
      await harness.mockInput.typeText("deepseek-v4-flash")
      await tab(2)
      await harness.mockInput.typeText(SENTINEL)
      frames.push(await screen("the key typed", (text) => text.includes("key typed (hidden)")))
      expect(frames.at(-1)).toContain("••••••••••••")
      expect(frames.at(-1)).toContain("deepseek-v4-flash")
      await press(() => harness.mockInput.pressEnter())
      await waitFor("the call", () => calls().length === 1)
      expect(calls()[0]).toEqual({ id: "model", args: { op: "set", lane: "keeper", provider: "deepseek", model: "deepseek-v4-flash", key: SENTINEL } })
      frames.push(await screen("the answer", (text) => text.includes("keeper now uses deepseek / deepseek-v4-flash.")))
      expect(frames.at(-1)).toContain("Key: sk-S...zzzz")

      // The one outgoing frame that carries it is that call; nothing else the client holds or writes does.
      const carrying = server.current.sent.filter((frame) => JSON.stringify(frame).includes(SENTINEL))
      expect(carrying).toHaveLength(1)
      expect(carrying[0]).toMatchObject({ type: "call", method: "command.run" })
      const snapshot = connection.session.getSnapshot()
      const lines = connection.getState().lines
      const held = JSON.stringify([snapshot.events, snapshot.drafts, [...snapshot.views], [...snapshot.viewProblems], snapshot.lastError, snapshot.turn, lines, connection.getState().upload, [...connection.getState().fetches]])
      expect(held).not.toContain(SENTINEL)
      expect(itemsToTranscript(logItems(snapshot.events, snapshot.drafts, lines), { at: new Date(0) })).not.toContain(SENTINEL)
      // The answer went to the screen only: no local line (the log and the transcript are built from them).
      expect(lines).toEqual([])
      frames.push(harness.captureCharFrame())
    } finally {
      for (const restore of spies) restore()
    }
    for (const frame of frames) expect(frame).not.toContain(SENTINEL)
    expect(logged.join("\n")).not.toContain(SENTINEL)
  })

  test("the key is cleared when the form is sent even if the server refuses, and when the form is left unsent", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: false, code: "unknown_provider", message: "No provider nonesuch is known here: give its address with base_url=<url>." })
    const { harness, screen, calls, tab, openForm, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await openForm(2)
    await screen("the form", (text) => text.includes("Set the model for Scribe"))
    await tab(3)
    await harness.mockInput.typeText(SENTINEL)
    await screen("the key typed", (text) => text.includes("key typed (hidden)"))
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the call", () => calls().length === 1)
    const refused = await screen("the refusal", (text) => text.includes("No provider nonesuch is known here"))
    // The server's words as they came; the key field is empty again.
    expect(refused).not.toContain("key typed (hidden)")
    expect(refused).toContain("optional: empty uses the key already saved")
    expect(refused).toContain("Set the model for Scribe")

    // The field really is empty, not just painted so: what is typed next is all that is sent.
    await harness.mockInput.typeText("zz")
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the second call", () => calls().length === 2)
    expect(calls()[1]).toEqual({ id: "model", args: { op: "set", lane: "scribe", provider: "openai", model: "gpt-5-mini", key: "zz" } })
    expect(JSON.stringify(calls()[1])).not.toContain(SENTINEL)

    // Typed and abandoned: the next form starts with an empty key.
    await harness.mockInput.typeText("abandoned")
    await screen("typed again", (text) => text.includes("key typed (hidden)"))
    await press(() => harness.mockInput.pressEscape())
    await screen("the actions", (text) => text.includes("Go back to the server's own settings"))
    await press(() => harness.mockInput.pressEnter())
    const again = await screen("the form again", (text) => text.includes("Set the model for Scribe"))
    expect(again).not.toContain("key typed (hidden)")
    expect(calls()).toHaveLength(2)
  })

  test("listing models: busy while the provider answers, then the list to pick from, with a note when it is cut short", async () => {
    const server = adminServer()
    server.onCall = (method, params) => (method === "command.run" && params.id === "model" ? null : { ok: true })
    const { harness, screen, calls, tab, openForm, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await openForm(0)
    await screen("the form", (text) => text.includes("Set the model for Keeper"))
    await tab(2)
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the list call", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "model", args: { op: "list", provider: "deepseek", lane: "keeper" } })
    await screen("busy", (text) => text.includes("Asking the provider…"))
    const rid = server.current.calls("command.run")[0]!.rid
    server.current.push({
      type: "result",
      rid,
      ok: true,
      text: "deepseek offers 3 models:\ndeepseek-chat\ndeepseek-v4-flash\ndeepseek-v4-pro",
      data: { providers: ["openai"], provider: "deepseek", models: ["deepseek-chat", "deepseek-v4-flash", "deepseek-v4-pro"], total: 612, truncated: true, skipped: 2 },
    })
    const listed = await screen("the models", (text) => text.includes("deepseek-v4-flash") && !text.includes("Asking the provider…"))
    expect(listed).toContain("3 models from deepseek: Enter picks one")
    expect(listed).toContain("Showing the first 3 of 612.")
    expect(listed).toContain("2 entries with ids this server does not show were left out.")
    // The list has the focus: pick the second.
    await press(() => harness.mockInput.pressArrow("down"))
    await press(() => harness.mockInput.pressEnter())
    const picked = await screen("the model filled in", (text) => text.includes("Model id") && text.includes("deepseek-v4-flash"))
    expect(picked).toContain("Model id")
    // Sending uses the picked id: the focus moved on to the key, so one Tab reaches the button.
    server.onCall = () => ({ ok: true, text: "keeper now uses deepseek / deepseek-v4-flash." })
    await tab()
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the set call", () => calls().length === 2)
    expect(calls()[1]).toEqual({ id: "model", args: { op: "set", lane: "keeper", provider: "deepseek", model: "deepseek-v4-flash" } })
  })

  test("a failed listing shows the server's message and leaves the form as it was", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: false, code: "model_list_failed", message: "The provider did not list its models (http_401)." })
    const { harness, screen, tab, openForm, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await openForm(0)
    await tab(2)
    await press(() => harness.mockInput.pressEnter())
    const frame = await screen("the failure", (text) => text.includes("did not list its models (http_401)."))
    expect(frame).toContain("Set the model for Keeper")
    expect(frame).not.toContain("Asking the provider…")
  })

  test("another provider is named with its address; without them nothing is sent", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: true, text: "keeper now uses mylab / m1." })
    const { harness, screen, calls, tab, down, openForm, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await openForm(0)
    // The provider list ends with "Other".
    await down(3)
    await press(() => harness.mockInput.pressEnter())
    await screen("the name field", (text) => text.includes("Provider name"))
    await tab(2)
    await harness.mockInput.typeText("m1")
    await press(() => harness.mockInput.pressEnter())
    await screen("the local refusal", (text) => text.includes("Give the provider a name and its address."))
    expect(calls()).toHaveLength(0)
    // Back to the name, the address.
    await tab(5)
    await harness.mockInput.typeText("mylab")
    await tab()
    await harness.mockInput.typeText("http://10.0.0.5:8000/v1")
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the call", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "model", args: { op: "set", lane: "keeper", provider: "mylab", model: "m1", baseUrl: "http://10.0.0.5:8000/v1" } })
  })

  test("resetting a lane asks first: Esc cancels without a call, Enter sends model reset for that lane", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: true, text: "Back to the server's settings for scribe. The Keeper uses deepseek / deepseek-v4-pro." })
    const { harness, screen, calls, down, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await down(2)
    await press(() => harness.mockInput.pressEnter())
    await down(1)
    await press(() => harness.mockInput.pressEnter())
    const confirm = await screen("the confirmation", (text) => text.includes("Reset Scribe to the server's own settings?"))
    expect(flat(confirm)).toContain("Keys that were saved stay saved.")
    await press(() => harness.mockInput.pressEscape())
    await screen("the actions", (text) => text.includes("Set the model…"))
    expect(calls()).toHaveLength(0)
    // The cursor stays on the reset row.
    await press(() => harness.mockInput.pressEnter())
    await screen("the confirmation again", (text) => text.includes("Reset Scribe to the server's own settings?"))
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the reset", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "model", args: { op: "reset", lane: "scribe" } })
    await screen("the answer on the overview", (text) => text.includes("Back to the server's settings for scribe.") && text.includes("Keeper: deepseek"))
  })

  test("a refused reset shows the server's message on the actions", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: false, code: "settings_unavailable", message: "This server does not offer that from chat." })
    const { harness, screen, down, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await press(() => harness.mockInput.pressEnter())
    await down(1)
    await press(() => harness.mockInput.pressEnter())
    await press(() => harness.mockInput.pressEnter())
    const frame = await screen("the refusal", (text) => text.includes("This server does not offer that from chat."))
    expect(frame).toContain("Set the model…")
  })

  test("pictures: set with a provider, address, model, size and no key; and turn them off", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: true, text: "Pictures now come from xai / grok-imagine, 1024x1024." })
    const { harness, screen, calls, tab, down, openForm, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await openForm(5)
    const form = await screen("the form", (text) => text.includes("Set the picture maker"))
    expect(form).toContain("Size")
    expect(form).not.toContain("List the provider's models")
    // Provider list: openai, xai, Other. Choose xai; Enter moves to the address.
    await down(1)
    await press(() => harness.mockInput.pressEnter())
    await harness.mockInput.typeText("https://images.example/v1")
    await tab()
    await harness.mockInput.typeText("grok-imagine")
    await tab(2)
    await harness.mockInput.typeText("1024x1024")
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the call", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "imagegen", args: { op: "set", provider: "xai", model: "grok-imagine", baseUrl: "https://images.example/v1", size: "1024x1024" } })
    await screen("the answer", (text) => text.includes("Pictures now come from xai / grok-imagine, 1024x1024."))

    // Off: the second action of the pictures row.
    server.onCall = () => ({ ok: true, text: "Pictures are off until an admin sets a provider again." })
    await down(0)
    await press(() => harness.mockInput.pressEnter())
    await down(1)
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the off call", () => calls().length === 2)
    expect(calls()[1]).toEqual({ id: "imagegen", args: { op: "off" } })
    await screen("the answer", (text) => text.includes("Pictures are off until an admin sets a provider again."))
  })

  test("an image key is as private as a lane's: masked, and only in the command.run call", async () => {
    const server = adminServer()
    server.onCall = () => ({ ok: true, text: "Pictures now come from openai / gpt-image-1, 1024x1024." })
    const { harness, screen, calls, connection, tab, openForm, press } = await open(server)
    await screen("the lanes", (text) => text.includes("Pictures"))
    await openForm(5)
    await screen("the form", (text) => text.includes("Set the picture maker"))
    // openai → address → model → key.
    await tab(3)
    await harness.mockInput.typeText(SENTINEL)
    const typed = await screen("the key typed", (text) => text.includes("key typed (hidden)"))
    expect(typed).not.toContain(SENTINEL)
    await tab(2)
    await press(() => harness.mockInput.pressEnter())
    await waitFor("the call", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "imagegen", args: { op: "set", provider: "openai", key: SENTINEL } })
    expect(server.current.sent.filter((frame) => JSON.stringify(frame).includes(SENTINEL))).toHaveLength(1)
    expect(JSON.stringify([connection.getState().lines, [...connection.session.getSnapshot().views]])).not.toContain(SENTINEL)
  })
})
