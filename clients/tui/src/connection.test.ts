import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("a quiet command leaves no local line: its answer (which may carry a secret), its refusal and its failure are the caller's alone", async () => {
    const { server, connection } = setup()
    await connection.start()
    await pump()
    server.onCall = (_method, params) => (params.id === "key" ? { ok: true, text: "the new key: SECRET-IN-THE-ANSWER", data: { key: "SECRET-IN-THE-ANSWER" } } : { ok: false, code: "forbidden", message: "Admins only." })
    const answered = await connection.runCommand("key", { op: "mint", name: "Dana" }, { quiet: true })
    expect(answered).toMatchObject({ ok: true, text: "the new key: SECRET-IN-THE-ANSWER" })
    const refused = await connection.runCommand("reset", {}, { quiet: true })
    expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(connection.getState().lines).toEqual([])
    expect(connection.getState().pending).toBe(0)
    // Without it, the same answer is a line.
    await connection.runCommand("reset", {})
    expect(connection.getState().lines.map((line) => line.kind)).toEqual(["refusal"])
    // A request that gets no answer at all is null, and still no line.
    connection.stop()
    expect(await connection.runCommand("key", { op: "list" }, { quiet: true })).toBeNull()
    expect(connection.getState().lines.map((line) => line.kind)).toEqual(["refusal"])
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

describe("Connection: the byte channel", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])
  const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

  async function online(options: Record<string, unknown> = {}) {
    const server = new FakeServer()
    const cache = await mkdtemp(join(tmpdir(), "lw-cache-"))
    const connection = server.connect({ mediaCacheDir: cache, ...options })
    await connection.start()
    await pump()
    return { server, connection, cache }
  }

  test("fetchMedia gets the bytes over a stream, keeps them in the cache, and serves the cache next time", async () => {
    const { server, connection, cache } = await online()
    const hash = hashOf(png)
    server.files.set(hash, { bytes: png, mime: "image/png", name: "map.png", purpose: "share" })
    const file = await connection.fetchMedia(hash)
    expect(file).toMatchObject({ hash, mime: "image/png", name: "map.png", path: join(cache, hash) })
    expect(Buffer.from(await readFile(join(cache, hash))).equals(Buffer.from(png))).toBe(true)
    expect(connection.getState().fetches.get(hash)).toMatchObject({ status: "ready" })
    // The server forgets it; the cache still answers, and its type is read from the bytes.
    server.files.clear()
    const again = await server.connect({ mediaCacheDir: cache }).fetchMedia(hash)
    expect(again.mime).toBe("image/png")
  })

  test("a fetch the server refuses is a failed fetch with the server's words", async () => {
    const { connection } = await online()
    const hash = "b".repeat(64)
    await expect(connection.fetchMedia(hash)).rejects.toMatchObject({ code: "media_not_found", server: true })
    expect(connection.getState().fetches.get(hash)).toEqual({ status: "failed", code: "media_not_found", message: "refused: media_not_found" })
    await expect(connection.fetchMedia("../etc/passwd")).rejects.toMatchObject({ code: "bad_hash" })
  })

  test("upload offers on the control stream, PUTs the bytes, and the share shows as a media event", async () => {
    const { server, connection } = await online()
    const progress: number[] = []
    connection.subscribe(() => {
      const upload = connection.getState().upload
      if (upload) progress.push(upload.sent)
    })
    const stored = await connection.upload({ name: "map.png", mime: "image/png", bytes: png }, "share")
    expect(stored).toEqual({ hash: hashOf(png), size: png.length, mime: "image/png", name: "map.png" })
    expect(server.offered[0]).toEqual({ name: "map.png", mime: "image/png", size: png.length, sha256: hashOf(png), purpose: "share" })
    expect(progress.at(-1)).toBe(png.length)
    expect(connection.getState().upload).toBeNull()
    await pump()
    expect(connection.session.getSnapshot().events.at(-1)).toMatchObject({ kind: "media", data: { name: "map.png" } })
    // The same bytes again: the server already holds them, nothing is sent.
    const again = await connection.upload({ name: "map.png", mime: "image/png", bytes: png }, "share")
    expect(again.hash).toBe(hashOf(png))
    expect(server.offers.size).toBe(0)
  })

  test("a refused offer rejects with the server's code and words", async () => {
    const { server, connection } = await online()
    server.refuseOffer = { code: "media_disabled", message: "上传已关闭。" }
    await expect(connection.upload({ name: "a.png", mime: "image/png", bytes: png }, "import")).rejects.toMatchObject({ code: "media_disabled", message: "上传已关闭。", server: true })
    expect(server.offered[0]?.purpose).toBe("import")
  })
})

describe("Connection: giving up", () => {
  test("after the redials run out it gives up and says so; nothing more is dialled", async () => {
    const server = new FakeServer()
    const clock = new ManualClock()
    const connection = server.connect({ timers: clockTimers(clock), now: clock.now, redialBaseMs: 100, redialMaxMs: 100, maxRedials: 3 })
    await connection.start()
    await pump()
    server.unreachable = true
    server.current.drop()
    for (let i = 0; i < 6; i += 1) {
      clock.advance(100)
      await pump()
    }
    expect(connection.getState().lost).toBe("redials")
    expect(connection.getState().phase).toBe("ended")
    expect(clock.armed).toBe(0)
  })

  test("giveUp('server_exited') stops a redialling connection at once", async () => {
    const server = new FakeServer()
    const clock = new ManualClock()
    const connection = server.connect({ timers: clockTimers(clock), now: clock.now })
    await connection.start()
    await pump()
    server.current.drop()
    connection.giveUp("server_exited")
    expect(connection.getState()).toMatchObject({ lost: "server_exited", phase: "ended" })
    clock.advance(60_000)
    await pump()
    expect(server.transports).toHaveLength(1)
  })
})
