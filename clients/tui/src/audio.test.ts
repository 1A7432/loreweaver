import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AudioView, ViewAudioLayer } from "loreweaver-protocol/v3"
import { AudioController, audioLine, connectionSounds, findPlayers, MIN_LOOP_RUN_MS, PLAYERS, spawnPlayer, type FetchSound, type PlayerProcess } from "./audio"
import type { Connection } from "./connection"
import { FakeServer, settle, waitFor } from "./testkit"

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

function sound(text: string, mime = "audio/ogg"): { bytes: Uint8Array; hash: string; mime: string } {
  const bytes = new TextEncoder().encode(text)
  return { bytes, hash: sha(bytes), mime }
}

const RAIN = sound("rain on the quay")
const WIND = sound("wind in the eaves")
const BELL = sound("a bell, once")
const SOUNDS = [RAIN, WIND, BELL]

function layer(entry: { hash: string; mime: string }, extra: Partial<ViewAudioLayer> = {}): ViewAudioLayer {
  return { id: `pack/${entry.hash.slice(0, 6)}`, title: "Rain on the quay", hash: entry.hash, mime: entry.mime, size: 16, loop: true, volume: 0.8, paused: false, ...extra }
}

function audioView(playing: AudioView["playing"] = {}): AudioView {
  return { library: [], playing }
}

/** A player process that never runs: it records what it is sent and exits when told to. */
class FakeProcess implements PlayerProcess {
  readonly signals: string[] = []
  #listeners: Array<(code: number | null) => void> = []
  ended = false
  constructor(
    readonly command: string,
    readonly args: readonly string[],
  ) {}
  #held = false
  #pendingTerm = false
  // As a real process: a SIGTERM to a stopped one waits until it runs again.
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.ended) return false
    this.signals.push(signal)
    if (signal === "SIGSTOP") this.#held = true
    if (signal === "SIGCONT") {
      this.#held = false
      if (this.#pendingTerm) this.exit(null)
    }
    if (signal === "SIGKILL") this.exit(null)
    if (signal === "SIGTERM") {
      if (this.#held) this.#pendingTerm = true
      else this.exit(null)
    }
    return true
  }
  onExit(listener: (code: number | null) => void): void {
    this.#listeners.push(listener)
  }
  exit(code: number | null): void {
    if (this.ended) return
    this.ended = true
    for (const listener of this.#listeners.splice(0)) listener(code)
  }
  get alive(): boolean {
    return !this.ended
  }
}

interface Rig {
  server: FakeServer
  connection: Connection
  audio: AudioController
  spawned: FakeProcess[]
  fetched: string[]
  ipc: Array<{ socket: string; command: readonly unknown[] }>
  exitHooks: Array<() => void>
  clock: { now: number }
  alive: () => FakeProcess[]
}

const rigs: Rig[] = []
afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rig.audio.dispose()
    rig.connection.stop()
  }
})

async function rig(options: { view?: AudioView; players?: string[]; platform?: NodeJS.Platform; muted?: boolean; fetchSound?: FetchSound } = {}): Promise<Rig> {
  const server = new FakeServer({ role: "admin" })
  if (options.view) server.views.set("audio", options.view)
  const connection = server.connect({ redialBaseMs: 1 })
  const spawned: FakeProcess[] = []
  const fetched: string[] = []
  const ipc: Rig["ipc"] = []
  const exitHooks: Array<() => void> = []
  const clock = { now: 1_000 }
  const players = new Set(options.players ?? ["mpv"])
  const fetchSound: FetchSound =
    options.fetchSound ??
    (async (hash) => {
      fetched.push(hash)
      const found = SOUNDS.find((entry) => entry.hash === hash)
      if (!found) throw new Error("not found")
      return { bytes: found.bytes, path: `/cache/${hash}.ogg` }
    })
  const audio = new AudioController({
    session: connection.session,
    fetchSound: async (hash, mime) => {
      if (options.fetchSound) fetched.push(hash)
      return fetchSound(hash, mime)
    },
    spawn: (command, args) => {
      const proc = new FakeProcess(command, args)
      spawned.push(proc)
      return proc
    },
    which: (command) => (players.has(command) ? `/usr/bin/${command}` : null),
    platform: options.platform ?? "linux",
    sendIpc: async (socket, command) => {
      ipc.push({ socket, command })
    },
    now: () => clock.now,
    onProcessExit: (listener) => {
      exitHooks.push(listener)
      return () => {
        const at = exitHooks.indexOf(listener)
        if (at >= 0) exitHooks.splice(at, 1)
      }
    },
    socketDir: "/tmp",
    ...(options.muted ? { muted: true } : {}),
  })
  await connection.start()
  await waitFor("the welcome", () => connection.session.status === "online")
  const made: Rig = { server, connection, audio, spawned, fetched, ipc, exitHooks, clock, alive: () => spawned.filter((proc) => proc.alive) }
  rigs.push(made)
  return made
}

function playSignal(entry: { hash: string; mime: string }, layerName: "bgm" | "ambience" | "sfx", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `s-${Math.random()}`, action: "play", layer: layerName, sound: "pack/x", hash: entry.hash, mime: entry.mime, size: 16, ...extra }
}

describe("AudioController", () => {
  test("on connect it starts what the view says plays; a paused layer waits for its resume", async () => {
    const { spawned, server, alive } = await rig({ view: audioView({ bgm: layer(RAIN), ambience: layer(WIND, { paused: true, title: "Wind" }) }) })
    await waitFor("the bgm player", () => spawned.length === 1)
    const bgm = spawned[0]!
    expect(bgm.command).toBe("mpv")
    expect(bgm.args).toContain("--loop-file=inf")
    expect(bgm.args).toContain("--volume=80")
    expect(bgm.args).toContain("--no-terminal")
    expect(bgm.args.at(-1)).toBe(`/cache/${RAIN.hash}.ogg`)
    // The paused ambience is fetched but not started until it is resumed.
    server.signal("audio", { id: "r1", action: "resume", layer: "ambience", sound: "pack/wind" })
    await waitFor("the ambience player", () => spawned.length === 2)
    expect(spawned[1]!.args.at(-1)).toBe(`/cache/${WIND.hash}.ogg`)
    expect(alive()).toHaveLength(2)
  })

  test("signals: play, pause (SIGSTOP), resume (SIGCONT), volume (mpv's IPC), stop", async () => {
    const { server, spawned, ipc, alive } = await rig({ view: audioView() })
    server.signal("audio", playSignal(RAIN, "bgm", { loop: true, volume: 0.5 }))
    await waitFor("the player", () => spawned.length === 1)
    const proc = spawned[0]!
    expect(proc.args).toContain("--volume=50")
    const socket = proc.args.find((arg) => arg.startsWith("--input-ipc-server="))?.slice("--input-ipc-server=".length)
    expect(socket).toStartWith("/tmp/lw-mpv-")

    server.signal("audio", { id: "p", action: "pause", layer: "bgm", sound: "pack/x" })
    await waitFor("held", () => proc.signals.includes("SIGSTOP"))
    server.signal("audio", { id: "r", action: "resume", layer: "bgm", sound: "pack/x" })
    await waitFor("continued", () => proc.signals.includes("SIGCONT"))
    server.signal("audio", { id: "v", action: "volume", layer: "bgm", sound: "pack/x", volume: 0.25 })
    await waitFor("the volume sent", () => ipc.length === 1)
    expect(ipc[0]).toEqual({ socket: socket!, command: ["set_property", "volume", 25] })
    server.signal("audio", { id: "s", action: "stop", layer: "bgm", sound: "pack/x" })
    await waitFor("stopped", () => alive().length === 0)
    expect(proc.signals).toContain("SIGTERM")
  })

  test("a paused player that is stopped is continued so the SIGTERM lands", async () => {
    const { server, spawned, alive } = await rig({ view: audioView() })
    server.signal("audio", playSignal(RAIN, "bgm"))
    await waitFor("the player", () => spawned.length === 1)
    server.signal("audio", { id: "p", action: "pause", layer: "bgm" })
    await waitFor("held", () => spawned[0]!.signals.includes("SIGSTOP"))
    server.signal("audio", { id: "s", action: "stop", layer: "bgm" })
    await waitFor("stopped", () => alive().length === 0)
    expect(spawned[0]!.signals).toEqual(["SIGSTOP", "SIGTERM", "SIGCONT"])
  })

  test("an sfx sounds once beside the bgm, which keeps playing", async () => {
    const { server, spawned, audio } = await rig({ view: audioView({ bgm: layer(RAIN) }) })
    await waitFor("the bgm", () => spawned.length === 1)
    server.signal("audio", playSignal(BELL, "sfx", { volume: 1 }))
    server.signal("audio", playSignal(BELL, "sfx", { volume: 0.5 }))
    await waitFor("two bells", () => spawned.length === 3)
    expect(spawned[1]!.args).not.toContain("--loop-file=inf")
    expect(spawned[2]!.args).toContain("--volume=50")
    expect(spawned[0]!.alive).toBe(true)
    expect(audio.running).toBe(3)
    spawned[1]!.exit(0)
    spawned[2]!.exit(0)
    expect(audio.running).toBe(1)
  })

  test("a second play on a layer replaces the first (the old player is killed); the same sound twice is fetched once", async () => {
    const { server, spawned, fetched, alive } = await rig({ view: audioView() })
    server.signal("audio", playSignal(RAIN, "bgm"))
    await waitFor("the first", () => spawned.length === 1)
    server.signal("audio", playSignal(WIND, "bgm"))
    await waitFor("the second", () => spawned.length === 2)
    expect(spawned[0]!.signals).toEqual(["SIGTERM"])
    expect(alive()).toEqual([spawned[1]!])
    server.signal("audio", playSignal(RAIN, "bgm"))
    await waitFor("the first again", () => spawned.length === 3)
    expect(fetched.filter((hash) => hash === RAIN.hash)).toHaveLength(1)
  })

  test("a reset of all stops every layer; a lighter reset leaves the music", async () => {
    const { server, spawned, alive } = await rig({ view: audioView({ bgm: layer(RAIN) }) })
    await waitFor("the bgm", () => spawned.length === 1)
    server.signal("audio", playSignal(BELL, "sfx"))
    await waitFor("the bell", () => spawned.length === 2)
    server.event("reset", { scope: "story", epoch: 2 })
    server.epoch = 2
    await settle()
    expect(alive()).toHaveLength(2)
    server.event("reset", { scope: "all", epoch: 3 })
    await waitFor("everything stopped", () => alive().length === 0)
    // The view that follows says nothing plays: nothing starts again.
    server.view("audio", audioView())
    await settle()
    expect(spawned).toHaveLength(2)
  })

  test("leaving (the session ends) and the app exiting stop every player", async () => {
    const left = await rig({ view: audioView({ bgm: layer(RAIN), ambience: layer(WIND) }) })
    await waitFor("both layers", () => left.spawned.length === 2)
    left.connection.stop()
    expect(left.alive()).toHaveLength(0)
    expect(left.exitHooks).toHaveLength(0)

    const exiting = await rig({ view: audioView({ bgm: layer(RAIN) }) })
    await waitFor("the bgm", () => exiting.spawned.length === 1)
    exiting.server.signal("audio", playSignal(BELL, "sfx"))
    await waitFor("the bell", () => exiting.spawned.length === 2)
    expect(exiting.exitHooks).toHaveLength(1)
    for (const hook of [...exiting.exitHooks]) hook()
    expect(exiting.alive()).toHaveLength(0)
  })

  test("a dropped link keeps the music; the view after the reconnect does not restart the same sound", async () => {
    const { server, connection, spawned } = await rig({ view: audioView({ bgm: layer(RAIN) }) })
    await waitFor("the bgm", () => spawned.length === 1)
    const before = connection.session.getSnapshot().views.get("audio")
    server.current.drop()
    await waitFor("redialled", () => server.transports.length === 2 && connection.session.status === "online")
    await waitFor("the fresh view held", () => connection.session.getSnapshot().views.get("audio") !== before)
    await settle()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.alive).toBe(true)
    // What changed while away is taken from the view: the music moved on to the wind.
    server.view("audio", audioView({ bgm: layer(WIND) }))
    await waitFor("the new sound", () => spawned.length === 2)
    expect(spawned[0]!.alive).toBe(false)
  })

  test("muted: nothing is fetched or played; unmuting starts what the view says", async () => {
    const { server, spawned, fetched, audio, alive } = await rig({ view: audioView({ bgm: layer(RAIN) }), muted: true })
    await waitFor("the view", () => audio.running === 0 && server.current.calls("view.subscribe").length > 0)
    server.signal("audio", playSignal(BELL, "sfx"))
    await settle()
    expect(spawned).toHaveLength(0)
    expect(fetched).toHaveLength(0)
    audio.setMuted(false)
    await waitFor("the bgm", () => spawned.length === 1)
    expect(audio.getState().muted).toBe(false)
    audio.setMuted(true)
    expect(alive()).toHaveLength(0)
    expect(audio.getState().muted).toBe(true)
  })

  test("no player on the machine: audio is off, said once, nothing fetched", async () => {
    const { server, spawned, fetched, audio } = await rig({ view: audioView({ bgm: layer(RAIN) }), players: [] })
    await waitFor("the no-player mark", () => audio.getState().noPlayer)
    server.signal("audio", playSignal(BELL, "sfx"))
    expect(spawned).toHaveLength(0)
    expect(fetched).toHaveLength(0)
    expect(audioLine(audioView({ bgm: layer(RAIN) }), audio.getState(), "en")).toBe("Music: Rain on the quay · sound off: no audio player on this computer (install mpv)")
  })

  test("a sound the found player cannot play stays silent (aplay plays wav only)", async () => {
    const { server, spawned, fetched } = await rig({ view: audioView(), players: ["aplay"] })
    server.signal("audio", playSignal(RAIN, "bgm"))
    await settle()
    expect(spawned).toHaveLength(0)
    expect(fetched).toHaveLength(0)
  })

  test("a fetch that fails leaves the layer silent; the next play tries again", async () => {
    let fail = true
    const { server, spawned, fetched } = await rig({
      view: audioView(),
      fetchSound: async (hash) => {
        if (fail) throw new Error("media_not_found")
        return { bytes: RAIN.bytes, path: `/cache/${hash}` }
      },
    })
    server.signal("audio", playSignal(RAIN, "bgm"))
    await waitFor("the failed fetch", () => fetched.length === 1)
    await settle()
    expect(spawned).toHaveLength(0)
    fail = false
    server.signal("audio", playSignal(RAIN, "bgm"))
    await waitFor("the retry plays", () => spawned.length === 1)
    expect(fetched).toHaveLength(2)
  })

  test("bytes that are not the sound named are refused", async () => {
    const { server, spawned, fetched } = await rig({ view: audioView(), fetchSound: async (hash) => ({ bytes: WIND.bytes, path: `/cache/${hash}` }) })
    server.signal("audio", playSignal(RAIN, "bgm"))
    await waitFor("the fetch", () => fetched.length === 1)
    await settle()
    expect(spawned).toHaveLength(0)
  })

  test("afplay loops by respawn on a clean exit, not after a failure or an exit too soon", async () => {
    const { server, spawned, clock } = await rig({ view: audioView(), players: ["afplay"], platform: "darwin" })
    server.signal("audio", playSignal({ hash: RAIN.hash, mime: "audio/mpeg" }, "bgm", { loop: true, volume: 0.4 }))
    await waitFor("afplay", () => spawned.length === 1)
    expect(spawned[0]!.command).toBe("afplay")
    expect(spawned[0]!.args).toEqual(["-v", "0.4", `/cache/${RAIN.hash}.ogg`])
    clock.now += MIN_LOOP_RUN_MS + 1
    spawned[0]!.exit(0)
    expect(spawned).toHaveLength(2)
    spawned[1]!.exit(0) // at once: the file plainly does not play
    expect(spawned).toHaveLength(2)
    server.signal("audio", playSignal({ hash: RAIN.hash, mime: "audio/mpeg" }, "bgm"))
    await waitFor("again", () => spawned.length === 3)
    clock.now += MIN_LOOP_RUN_MS + 1
    spawned[2]!.exit(1)
    expect(spawned).toHaveLength(3)
  })

  test("pause is skipped on Windows (no way to hold a process)", async () => {
    const { server, spawned } = await rig({ view: audioView(), platform: "win32" })
    server.signal("audio", playSignal(RAIN, "bgm"))
    await waitFor("the player", () => spawned.length === 1)
    expect(spawned[0]!.args.some((arg) => arg.startsWith("--input-ipc-server=\\\\.\\pipe\\lw-mpv-"))).toBe(true)
    server.signal("audio", { id: "p", action: "pause", layer: "bgm" })
    server.signal("audio", { id: "r", action: "resume", layer: "bgm" })
    await settle()
    expect(spawned[0]!.signals).toEqual([])
  })
})

describe("players and files", () => {
  test("the player table: looked for in order, afplay only on macOS", () => {
    const all = (command: string) => `/bin/${command}`
    expect(findPlayers(all, "darwin").map((player) => player.name)).toEqual(["mpv", "ffplay", "afplay", "paplay", "aplay"])
    expect(findPlayers(all, "linux").map((player) => player.name)).toEqual(["mpv", "ffplay", "paplay", "aplay"])
    const ffplay = PLAYERS.find((player) => player.name === "ffplay")!
    expect(ffplay.args({ path: "/a.ogg", volume: 0.3, loop: true })).toEqual(["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", "30", "-loop", "0", "/a.ogg"])
    const paplay = PLAYERS.find((player) => player.name === "paplay")!
    expect(paplay.args({ path: "/a.wav", volume: 0.5, loop: false })).toEqual(["--volume=32768", "/a.wav"])
    expect(paplay.plays("audio/mpeg")).toBe(false)
  })

  test("a sound comes over the byte channel into the media cache, under a name with its extension", async () => {
    const server = new FakeServer({ role: "admin" })
    server.files.set(RAIN.hash, { bytes: RAIN.bytes, mime: "audio/ogg", name: "rain.ogg", purpose: "audio" })
    const cache = await mkdtemp(join(tmpdir(), "loreweaver-audio-cache-"))
    const connection = server.connect({ mediaCacheDir: cache })
    await connection.start()
    await waitFor("the welcome", () => connection.session.status === "online")
    try {
      const file = await connectionSounds(connection)(RAIN.hash, "audio/ogg")
      expect(file.path).toBe(join(cache, `${RAIN.hash}.ogg`))
      expect([...(await readFile(file.path))]).toEqual([...RAIN.bytes])
      expect([...(await readFile(join(cache, RAIN.hash)))]).toEqual([...RAIN.bytes])
      // A sound is not kept among the fetched pictures.
      expect(connection.getState().fetches.size).toBe(0)
      // The second time it comes from the cache, even with the server gone.
      server.files.clear()
      const again = await connectionSounds(connection)(RAIN.hash, "audio/ogg")
      expect(again.path).toBe(file.path)
    } finally {
      connection.stop()
    }
  })

  test.skipIf(process.platform === "win32")("the real spawn: a stopped process, held or not, is gone (no orphan)", async () => {
    // `sleep`, not a player: no sound is ever made by a test.
    const running = spawnPlayer("sleep", ["30"])
    const ended = new Promise<number | null>((resolve) => running.onExit(resolve))
    expect(running.kill("SIGTERM")).toBe(true)
    expect(await ended).toBeNull()
    expect(running.kill("SIGTERM")).toBe(false)

    const held = spawnPlayer("sleep", ["30"])
    const heldEnded = new Promise<number | null>((resolve) => held.onExit(resolve))
    held.kill("SIGSTOP")
    held.kill("SIGTERM")
    held.kill("SIGCONT")
    expect(await heldEnded).toBeNull()

    const missing = spawnPlayer("loreweaver-no-such-player", [])
    expect(await new Promise<number | null>((resolve) => missing.onExit(resolve))).toBe(-1)
  })
})

describe("audioLine", () => {
  test("what plays per layer, paused, muted; empty when there is nothing to say", () => {
    const quiet = { muted: false, noPlayer: false }
    expect(audioLine(null, quiet, "en")).toBe("")
    expect(audioLine(audioView(), quiet, "en")).toBe("")
    const view = audioView({ bgm: layer(RAIN), ambience: layer(WIND, { title: "Wind\u001b[31m", paused: true }) })
    expect(audioLine(view, quiet, "en")).toBe("Music: Rain on the quay · Ambience: Wind[31m (paused)")
    expect(audioLine(view, { muted: true, noPlayer: true }, "zh")).toBe("音乐：Rain on the quay · 环境音：Wind[31m （暂停） · 已静音（F9）")
    expect(audioLine(audioView(), { muted: true, noPlayer: false }, "en")).toBe("sound muted (F9)")
  })
})
