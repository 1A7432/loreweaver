import { describe, expect, test } from "bun:test"
import { CLIENT_VIEWS } from "./connection"
import { FakeServer, ManualClock, pump } from "./testkit"

function clockTimers(clock: ManualClock) {
  return { setTimeout: (fn: () => void, ms: number) => clock.setTimeoutFn(fn, ms), clearTimeout: (id: unknown) => clock.clearTimeoutFn(id as ReturnType<typeof setTimeout>) }
}

function setup(options: { pingEveryMs?: number } = {}) {
  const server = new FakeServer()
  const clock = new ManualClock()
  const connection = server.connect({ timers: clockTimers(clock), now: clock.now, pingEveryMs: options.pingEveryMs ?? 15_000, pingTimeoutMs: 5_000, redialBaseMs: 500, redialMaxMs: 4_000 })
  return { server, clock, connection }
}

describe("Connection", () => {
  test("dials, says hello with the key and this client's language, and subscribes every view the client shows", async () => {
    const { server, connection } = setup()
    server.views.set("me", { member: { id: "m1", name: "Ada", role: "player", roleLabel: "Investigator" }, character: null })
    await connection.start()
    await pump()
    const hello = server.current.sent[0]
    expect(hello).toMatchObject({ type: "hello", protocol: "3.0", key: "k", locale: "en", caps: ["text-only"] })
    expect(connection.session.status).toBe("online")
    expect(connection.getState()).toMatchObject({ phase: "online", attempt: 0 })
    const subscribed = server.current.calls("view.subscribe").flatMap((call) => call.params.names as string[])
    expect(new Set(subscribed)).toEqual(new Set(CLIENT_VIEWS))
    expect(connection.session.getSnapshot().views.get("me")?.data).toMatchObject({ member: { name: "Ada" } })
  })

  test("a command's answer and a refusal become local lines for this person, after the newest event", async () => {
    const { server, connection } = setup()
    await connection.start()
    await pump()
    server.say("The door creaks.")
    server.onInput = (text) => (text === ".st" ? { ok: true, text: "Ada: STR 50" } : { ok: false, code: "forbidden", message: "Admins only." })
    await connection.input(".st")
    await connection.input(".reset")
    const lines = connection.getState().lines
    expect(lines.map((line) => [line.kind, line.text, line.after])).toEqual([
      ["result", "Ada: STR 50", 1],
      ["refusal", "Admins only.", 1],
    ])
    expect(lines[1]?.code).toBe("forbidden")
    expect(connection.getState().pending).toBe(0)
    // Speech accepted with nothing to say adds no line.
    server.onInput = () => ({ ok: true })
    await connection.input("I wait.")
    expect(connection.getState().lines).toHaveLength(2)
  })

  test("a notice is a local line; a spinner notice is replaced by the next and ends with the turn", async () => {
    const { server, connection } = setup()
    await connection.start()
    await pump()
    server.signal("notice", { level: "info", text: "Importing…", spinner: true })
    expect(connection.getState().lines.map((line) => [line.text, line.spinner])).toEqual([["Importing…", true]])
    server.signal("notice", { level: "warn", code: "provider_auth", text: "The model refused the key." })
    expect(connection.getState().lines.map((line) => [line.text, line.code])).toEqual([["The model refused the key.", "provider_auth"]])
    server.signal("notice", { level: "info", text: "Working…", spinner: true })
    server.signal("turn", { status: "busy", actor: "Ada" })
    server.signal("turn", { status: "idle" })
    expect(connection.getState().lines.map((line) => line.text)).toEqual(["The model refused the key."])
  })

  test("after a drop it redials with backoff and resumes the same session from the log it holds", async () => {
    const { server, clock, connection } = setup()
    await connection.start()
    await pump()
    server.say("one")
    server.say("two")
    server.current.drop("network")
    expect(connection.session.status).toBe("offline")
    expect(connection.getState()).toMatchObject({ phase: "waiting", attempt: 1 })
    // The first redial fails: the next waits twice as long.
    server.unreachable = true
    clock.advance(500)
    await pump()
    expect(connection.getState()).toMatchObject({ phase: "waiting", attempt: 2 })
    server.unreachable = false
    server.say("three")
    clock.advance(999)
    await pump()
    expect(server.transports).toHaveLength(1)
    clock.advance(1)
    await pump()
    expect(server.transports).toHaveLength(2)
    expect(server.current.sent[0]).toMatchObject({ type: "hello", resume: { epoch: 1, after: 2 } })
    expect(connection.session.status).toBe("online")
    expect(connection.getState()).toMatchObject({ phase: "online", attempt: 0 })
    expect(connection.session.getSnapshot().events.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  test("a fatal error ends it for good: no redial, the server's message kept", async () => {
    const { server, clock, connection } = setup()
    server.refuseHello = { code: "bad_key", message: "That key is not known here." }
    await connection.start()
    await pump()
    expect(connection.session.status).toBe("ended")
    expect(connection.session.canRedial).toBe(false)
    expect(connection.session.getSnapshot().lastError).toMatchObject({ code: "bad_key", message: "That key is not known here." })
    expect(connection.getState().phase).toBe("ended")
    clock.advance(60_000)
    await pump()
    expect(server.transports).toHaveLength(1)
  })

  test("a first dial that fails rejects and is not retried", async () => {
    const { server, clock, connection } = setup()
    server.unreachable = true
    await expect(connection.start()).rejects.toThrow("no route to peer")
    expect(connection.getState()).toMatchObject({ phase: "ended", dialError: "no route to peer" })
    clock.advance(60_000)
    await pump()
    expect(server.transports).toHaveLength(0)
  })

  test("a link that drops before any welcome is not redialled", async () => {
    const { server, clock, connection } = setup()
    server.handle = () => undefined
    await connection.start()
    server.current.drop("reset")
    expect(connection.getState().phase).toBe("ended")
    clock.advance(60_000)
    expect(server.transports).toHaveLength(1)
  })

  test("the client pings on a timer; no pong in time drops the link and redials", async () => {
    const { server, clock, connection } = setup({ pingEveryMs: 1_000 })
    await connection.start()
    await pump()
    clock.advance(1_000)
    await pump()
    expect(server.current.sent.some((frame) => frame.type === "ping")).toBe(true)
    expect(connection.session.getSnapshot().rtt).not.toBeNull()
    server.pong = false
    clock.advance(1_000)
    await pump()
    clock.advance(5_000)
    await pump()
    expect(server.transports[0]?.closed).toBe(true)
    expect(connection.getState().phase).toBe("waiting")
    server.pong = true
    clock.advance(500)
    await pump()
    expect(server.transports).toHaveLength(2)
    expect(connection.session.status).toBe("online")
  })

  test("stop() ends the session, closes the link and cancels a pending redial", async () => {
    const { server, clock, connection } = setup()
    await connection.start()
    await pump()
    server.current.drop()
    connection.stop()
    expect(connection.session.status).toBe("ended")
    clock.advance(60_000)
    await pump()
    expect(server.transports).toHaveLength(1)
    expect(connection.getState().phase).toBe("ended")
  })

  test("a reset drops the local lines written before it", async () => {
    const { server, connection } = setup()
    await connection.start()
    await pump()
    server.onInput = () => ({ ok: true, text: "noted" })
    await connection.input(".st")
    expect(connection.getState().lines).toHaveLength(1)
    server.event("reset", { scope: "all", epoch: 2 })
    expect(connection.getState().lines).toHaveLength(0)
  })

  test("a request while the link is down becomes a 'not connected' line", async () => {
    const { server, connection } = setup()
    await connection.start()
    await pump()
    server.current.drop()
    expect(await connection.input("hello")).toBeNull()
    expect(connection.getState().lines.at(-1)).toMatchObject({ kind: "failed", code: "not_connected" })
  })
})
