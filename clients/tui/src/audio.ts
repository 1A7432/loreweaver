// The room's sound (protocol 3.0 §9.4 `audio` signal, §10.4 `audio` view), played through an
// external player found on this machine — the terminal has no audio of its own.
//
// The view is the state, the signal is the transition. The controller starts what the `audio`
// view says plays whenever a new value of it arrives (every connect and reconnect brings one),
// follows the `audio` signals in between, and takes the view as the truth again after a `reset`
// of scope `all` (which stops every layer). Starting from a view is idempotent: a layer already
// playing the sound the view names keeps playing, so a reconnect does not restart the music.
//
// It lives outside React and holds only what this client owns: the players it started, which
// sounds it already has on disk, the mute switch. What plays is read from the session.
//
// Players, in the order they are looked for, and what each can do:
//   mpv     every type · native loop · volume, also changed while playing (its IPC socket)
//   ffplay  every type · native loop · volume at start
//   afplay  macOS only · mp3/wav/aac/m4a/flac (no ogg) · volume at start · loop by respawn
//   paplay  wav/flac/ogg · volume at start · loop by respawn
//   aplay   wav only · no volume · loop by respawn
// Pause is SIGSTOP/SIGCONT on POSIX for all of them (on Windows it is skipped). A volume change
// to a player that cannot take one while playing applies from its next start (a respawned loop,
// the next `play`). `fadeMs` is not done by any of them: the change is immediate. Whatever a
// player cannot do is skipped silently; a sound no found player can play stays silent.
import { link, mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { spawn as nodeSpawn } from "node:child_process"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { builtInView, stripControlChars, type AudioView, type HeldView, type Session, type SignalFrame, type SignalPayloads } from "loreweaver-protocol/v3"
import type { Connection } from "./connection"
import { tt } from "./i18n"
import { extensionForMime, sha256Hex } from "./media"

export type AudioLayer = SignalPayloads["audio"]["layer"]
/** The layers that hold one sound each; `sfx` is one-shot. */
export type LoopLayer = Exclude<AudioLayer, "sfx">
export const LOOP_LAYERS: readonly LoopLayer[] = ["bgm", "ambience"]

/** A player process as the controller drives it. */
export interface PlayerProcess {
  /** Send a signal; false when the process is already gone. */
  kill(signal?: NodeJS.Signals): boolean
  /** Called once when the process ends, or failed to start (code -1); null when a signal ended it. */
  onExit(listener: (code: number | null) => void): void
}

export type SpawnPlayer = (command: string, args: readonly string[]) => PlayerProcess
/** The command's path on this machine, or null. */
export type FindCommand = (command: string) => string | null
/** One JSON command to an mpv IPC socket; never rejects. */
export type SendIpc = (socket: string, command: readonly unknown[]) => Promise<void>
/** A sound's bytes (to check against its hash) and a file a player can open. */
export type FetchSound = (hash: string, mime: string) => Promise<{ bytes: Uint8Array; path: string }>

export interface PlayOptions {
  readonly path: string
  /** 0..1. */
  readonly volume: number
  /** Only when the player loops natively. */
  readonly loop: boolean
  /** mpv's IPC socket, when the player has one. */
  readonly ipc?: string
}

export interface PlayerSpec {
  readonly name: string
  /** Only looked for on these platforms; everywhere when absent. */
  readonly platforms?: readonly NodeJS.Platform[]
  readonly plays: (mime: string) => boolean
  readonly args: (options: PlayOptions) => string[]
  /** Loops by itself; otherwise a looping layer is respawned when the player exits cleanly. */
  readonly nativeLoop: boolean
  /** Takes a volume change while playing (over an IPC socket). */
  readonly ipc: boolean
}

const percent = (volume: number): number => Math.round(clamp01(volume) * 100)
const any = (): boolean => true
const among =
  (...mimes: string[]) =>
  (mime: string): boolean =>
    mimes.includes(mime)

/** The players this client knows, in the order they are looked for. */
export const PLAYERS: readonly PlayerSpec[] = [
  {
    name: "mpv",
    plays: any,
    nativeLoop: true,
    ipc: true,
    args: ({ path, volume, loop, ipc }) => [
      "--no-video",
      "--no-terminal",
      "--really-quiet",
      `--volume=${percent(volume)}`,
      ...(loop ? ["--loop-file=inf"] : []),
      ...(ipc ? [`--input-ipc-server=${ipc}`] : []),
      "--",
      path,
    ],
  },
  {
    name: "ffplay",
    plays: any,
    nativeLoop: true,
    ipc: false,
    args: ({ path, volume, loop }) => ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(percent(volume)), ...(loop ? ["-loop", "0"] : []), path],
  },
  {
    name: "afplay",
    platforms: ["darwin"],
    plays: among("audio/mpeg", "audio/wav", "audio/aac", "audio/mp4", "audio/flac"),
    nativeLoop: false,
    ipc: false,
    args: ({ path, volume }) => ["-v", String(clamp01(volume)), path],
  },
  {
    name: "paplay",
    plays: among("audio/wav", "audio/flac", "audio/ogg"),
    nativeLoop: false,
    ipc: false,
    args: ({ path, volume }) => [`--volume=${Math.round(clamp01(volume) * 65536)}`, path],
  },
  {
    name: "aplay",
    plays: among("audio/wav"),
    nativeLoop: false,
    ipc: false,
    args: ({ path }) => ["-q", path],
  },
]

/** The players found on this machine, in preference order. */
export function findPlayers(which: FindCommand, platform: NodeJS.Platform, players: readonly PlayerSpec[] = PLAYERS): PlayerSpec[] {
  return players.filter((player) => (player.platforms === undefined || player.platforms.includes(platform)) && which(player.name) !== null)
}

/** A clean exit sooner than this after a start ends a respawned loop (a player that cannot play the file). */
export const MIN_LOOP_RUN_MS = 500

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

interface Running {
  readonly proc: PlayerProcess
  readonly startedAt: number
  readonly ipc?: string
  /** Killed by this controller: its exit is not a loop's end. */
  stopping: boolean
  /** Held with SIGSTOP. */
  held: boolean
}

interface LayerState {
  readonly hash: string
  readonly mime: string
  loop: boolean
  volume: number
  paused: boolean
  /** The fetch failed or the bytes did not match: a fresh view or the next `play` tries again. */
  failed: boolean
  /** Set once the file is on disk and a player is chosen. */
  path?: string
  player?: PlayerSpec
  running?: Running
}

/** What the controller reads of the session. */
export type AudioSession = Pick<Session, "subscribe" | "getSnapshot" | "onSignal">

export interface AudioControllerOptions {
  readonly session: AudioSession
  readonly fetchSound: FetchSound
  readonly spawn?: SpawnPlayer
  readonly which?: FindCommand
  readonly platform?: NodeJS.Platform
  readonly sendIpc?: SendIpc
  readonly now?: () => number
  /** Register a hook run when the app exits; returns its removal. Defaults to `process.on("exit")`. */
  readonly onProcessExit?: (listener: () => void) => () => void
  readonly muted?: boolean
  /** Where mpv's IPC sockets go (POSIX); the system's temporary folder by default. */
  readonly socketDir?: string
}

/** The controller's own state, for the status line. */
export interface AudioLocalState {
  readonly muted: boolean
  /** Something was to play and no player was found on this machine: audio is off. */
  readonly noPlayer: boolean
}

let socketSerial = 0

export class AudioController {
  readonly #session: AudioSession
  readonly #fetchSound: FetchSound
  readonly #spawn: SpawnPlayer
  readonly #which: FindCommand
  readonly #platform: NodeJS.Platform
  readonly #sendIpc: SendIpc
  readonly #now: () => number
  readonly #socketDir: string
  readonly #layers = new Map<LoopLayer, LayerState>()
  readonly #sfx = new Set<Running>()
  /** Sounds already on disk and checked, by hash: never fetched again. */
  readonly #files = new Map<string, string>()
  readonly #listeners = new Set<() => void>()
  readonly #unsubscribe: Array<() => void> = []
  #players: PlayerSpec[] | null = null
  #state: AudioLocalState
  #lastView: HeldView<AudioView> | null = null
  #lastResetSeq = 0
  /** A view older than the last reset of `all` is not the truth any more. */
  #resetAt = 0
  #disposed = false

  constructor(options: AudioControllerOptions) {
    this.#session = options.session
    this.#fetchSound = options.fetchSound
    this.#spawn = options.spawn ?? spawnPlayer
    this.#which = options.which ?? ((command) => Bun.which(command))
    this.#platform = options.platform ?? process.platform
    this.#sendIpc = options.sendIpc ?? sendMpvIpc
    this.#now = options.now ?? Date.now
    this.#socketDir = options.socketDir ?? tmpdir()
    this.#state = { muted: options.muted ?? false, noPlayer: false }
    this.#unsubscribe.push(this.#session.subscribe(this.#onSnapshot))
    this.#unsubscribe.push(this.#session.onSignal(this.#onSignal))
    const onExit = options.onProcessExit ?? onProcessExit
    this.#unsubscribe.push(onExit(this.#stopAll))
    this.#onSnapshot()
  }

  // --- the local store -------------------------------------------------------------------------

  getState = (): AudioLocalState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #set(patch: Partial<AudioLocalState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        // a listener's failure is its own
      }
    }
  }

  // --- control ---------------------------------------------------------------------------------

  /** Muted: nothing is fetched or played. Unmuted: what the view says plays starts. */
  setMuted(muted: boolean): void {
    if (this.#disposed || muted === this.#state.muted) return
    this.#set({ muted })
    if (muted) {
      this.#stopAll()
      return
    }
    const held = this.#lastView
    if (held !== null && held.at >= this.#resetAt) this.#reconcile(held.data)
  }

  /** Stop every player and stop listening. Also what an ended session does by itself. */
  dispose(): void {
    if (this.#disposed) return
    this.#stopAll()
    this.#disposed = true
    for (const off of this.#unsubscribe.splice(0)) off()
  }

  /** Players running now (for tests and diagnostics). */
  get running(): number {
    let count = this.#sfx.size
    for (const state of this.#layers.values()) if (state.running) count += 1
    return count
  }

  // --- the session -----------------------------------------------------------------------------

  #onSnapshot = (): void => {
    if (this.#disposed) return
    const snapshot = this.#session.getSnapshot()
    // Left, refused or given up on: nothing of this session plays any more.
    if (snapshot.status === "ended") {
      this.dispose()
      return
    }
    // A reset of `all` clears what the room plays; the views that follow say what plays now.
    const first = snapshot.events[0]
    if (first !== undefined && first.kind === "reset" && first.seq > this.#lastResetSeq) {
      this.#lastResetSeq = first.seq
      if (first.data.scope === "all") {
        this.#resetAt = first.seq
        this.#stopAll()
      }
    }
    // Every new value of the view is a picture of what plays: start from it (idempotently).
    const held = builtInView(snapshot, "audio")
    if (held !== this.#lastView) {
      this.#lastView = held
      if (held !== null && held.at >= this.#resetAt && !this.#state.muted) this.#reconcile(held.data)
    }
  }

  #onSignal = (frame: SignalFrame): void => {
    if (frame.kind !== "audio" || this.#disposed || this.#state.muted) return
    const signal = frame.data
    if (signal.layer === "sfx") {
      if (signal.action === "play" && signal.hash && signal.mime) void this.#playSfx(signal.hash, signal.mime, signal.volume ?? 1)
      else if (signal.action === "stop") for (const run of [...this.#sfx]) this.#kill(run)
      return
    }
    const layer = signal.layer
    const current = this.#layers.get(layer)
    switch (signal.action) {
      case "play":
        if (signal.hash && signal.mime) {
          this.#apply(layer, { hash: signal.hash, mime: signal.mime, loop: signal.loop ?? true, volume: signal.volume ?? 1, paused: false }, true)
        }
        return
      case "stop":
        this.#stopLayer(layer)
        return
      case "pause":
      case "resume":
        if (current) this.#setPaused(layer, current, signal.action === "pause")
        return
      case "volume":
        if (current && typeof signal.volume === "number") this.#setVolume(current, clamp01(signal.volume))
        return
    }
  }

  #reconcile(view: AudioView): void {
    for (const layer of LOOP_LAYERS) {
      const wanted = view.playing[layer]
      if (wanted === undefined) this.#stopLayer(layer)
      else this.#apply(layer, { hash: wanted.hash, mime: wanted.mime, loop: wanted.loop, volume: clamp01(wanted.volume), paused: wanted.paused }, false)
    }
  }

  // --- layers ----------------------------------------------------------------------------------

  /** Make `layer` play `wanted`. Unless `restart`, a layer already on the same sound is only adjusted. */
  #apply(layer: LoopLayer, wanted: { hash: string; mime: string; loop: boolean; volume: number; paused: boolean }, restart: boolean): void {
    const current = this.#layers.get(layer)
    if (!restart && current !== undefined && current.hash === wanted.hash && !current.failed) {
      current.loop = wanted.loop
      if (current.volume !== wanted.volume) this.#setVolume(current, wanted.volume)
      if (current.paused !== wanted.paused) this.#setPaused(layer, current, wanted.paused)
      return
    }
    this.#stopLayer(layer)
    const state: LayerState = { ...wanted, failed: false }
    this.#layers.set(layer, state)
    void this.#prepare(layer, state)
  }

  async #prepare(layer: LoopLayer, state: LayerState): Promise<void> {
    const prepared = await this.#ready(state.hash, state.mime)
    if (this.#layers.get(layer) !== state || this.#disposed || this.#state.muted) return
    if (prepared === "failed") {
      state.failed = true
      return
    }
    if (prepared === null) return
    state.path = prepared.path
    state.player = prepared.player
    if (!state.paused) this.#startLayer(layer, state)
  }

  /**
   * A player for the type and the file on disk: null when no found player plays it (silent, not
   * a failure), "failed" when the fetch failed or the bytes are not the sound named.
   */
  async #ready(hash: string, mime: string): Promise<{ path: string; player: PlayerSpec } | null | "failed"> {
    const player = this.#playerFor(mime)
    if (player === null) return null
    const known = this.#files.get(hash)
    if (known !== undefined) return { path: known, player }
    try {
      const file = await this.#fetchSound(hash, mime)
      if (sha256Hex(file.bytes) !== hash) return "failed"
      this.#files.set(hash, file.path)
      return { path: file.path, player }
    } catch {
      return "failed"
    }
  }

  #playerFor(mime: string): PlayerSpec | null {
    if (this.#players === null) {
      this.#players = findPlayers(this.#which, this.#platform)
      if (this.#players.length === 0) this.#set({ noPlayer: true })
    }
    return this.#players.find((player) => player.plays(mime)) ?? null
  }

  #startLayer(layer: LoopLayer, state: LayerState): void {
    const player = state.player
    const path = state.path
    if (player === undefined || path === undefined) return
    const run = this.#launch(player, path, state.volume, state.loop && player.nativeLoop)
    if (run === null) return
    state.running = run
    run.proc.onExit((code) => {
      if (state.running !== run) return
      state.running = undefined
      if (run.stopping || this.#disposed || this.#layers.get(layer) !== state) return
      // A loop the player cannot do itself: start it again — unless it failed, or ended so soon
      // that it plainly cannot play the file.
      if (state.loop && !player.nativeLoop && code === 0 && this.#now() - run.startedAt >= MIN_LOOP_RUN_MS && !state.paused) this.#startLayer(layer, state)
    })
  }

  #launch(player: PlayerSpec, path: string, volume: number, loop: boolean): Running | null {
    const ipc = player.ipc ? this.#socketPath() : undefined
    let proc: PlayerProcess
    try {
      proc = this.#spawn(player.name, player.args({ path, volume, loop, ...(ipc ? { ipc } : {}) }))
    } catch {
      return null
    }
    return { proc, startedAt: this.#now(), stopping: false, held: false, ...(ipc ? { ipc } : {}) }
  }

  #socketPath(): string {
    const name = `lw-mpv-${process.pid}-${++socketSerial}`
    return this.#platform === "win32" ? `\\\\.\\pipe\\${name}` : join(this.#socketDir, `${name}.sock`)
  }

  #setPaused(layer: LoopLayer, state: LayerState, paused: boolean): void {
    state.paused = paused
    const run = state.running
    if (paused) {
      // No way to hold a process on Windows: skipped.
      if (run !== undefined && !run.held && this.#platform !== "win32" && run.proc.kill("SIGSTOP")) run.held = true
      return
    }
    if (run !== undefined) {
      if (run.held) {
        run.held = false
        run.proc.kill("SIGCONT")
      }
      return
    }
    // Paused before it ever started (a view said so on connect): it starts now, from the top.
    if (state.path !== undefined) this.#startLayer(layer, state)
  }

  #setVolume(state: LayerState, volume: number): void {
    state.volume = volume
    const ipc = state.running?.ipc
    if (ipc !== undefined) void this.#sendIpc(ipc, ["set_property", "volume", percent(volume)])
  }

  #stopLayer(layer: LoopLayer): void {
    const state = this.#layers.get(layer)
    if (state === undefined) return
    this.#layers.delete(layer)
    if (state.running !== undefined) this.#kill(state.running)
    state.running = undefined
  }

  #kill(run: Running): void {
    run.stopping = true
    this.#sfx.delete(run)
    run.proc.kill("SIGTERM")
    // A stopped process does not act on SIGTERM until it runs again.
    if (run.held) run.proc.kill("SIGCONT")
  }

  #stopAll = (): void => {
    for (const layer of LOOP_LAYERS) this.#stopLayer(layer)
    for (const run of [...this.#sfx]) this.#kill(run)
  }

  // --- sfx -------------------------------------------------------------------------------------

  async #playSfx(hash: string, mime: string, volume: number): Promise<void> {
    const prepared = await this.#ready(hash, mime)
    if (prepared === null || prepared === "failed" || this.#disposed || this.#state.muted) return
    const run = this.#launch(prepared.player, prepared.path, clamp01(volume), false)
    if (run === null) return
    this.#sfx.add(run)
    run.proc.onExit(() => {
      this.#sfx.delete(run)
    })
  }
}

// --- the real world ------------------------------------------------------------------------------

/** A player process, not detached (it goes with this client's process group), output discarded. */
export const spawnPlayer: SpawnPlayer = (command, args) => {
  const child = nodeSpawn(command, [...args], { stdio: "ignore" })
  const listeners: Array<(code: number | null) => void> = []
  let ended: { code: number | null } | null = null
  const finish = (code: number | null): void => {
    if (ended !== null) return
    ended = { code }
    for (const listener of listeners.splice(0)) listener(code)
  }
  child.on("exit", (code) => finish(code))
  child.on("error", () => finish(-1))
  return {
    kill: (signal) => {
      if (ended !== null) return false
      try {
        return child.kill(signal)
      } catch {
        return false
      }
    },
    onExit: (listener) => {
      if (ended !== null) listener(ended.code)
      else listeners.push(listener)
    },
  }
}

const onProcessExit = (listener: () => void): (() => void) => {
  process.on("exit", listener)
  return () => {
    process.off("exit", listener)
  }
}

/** One command over mpv's JSON IPC; a socket that is not there (yet) is ignored. */
export const sendMpvIpc: SendIpc = (socket, command) =>
  new Promise<void>((resolve) => {
    try {
      const connection = createConnection(socket)
      const done = (): void => {
        clearTimeout(timer)
        connection.destroy()
        resolve()
      }
      const timer = setTimeout(done, 1000)
      connection.on("error", done)
      connection.on("connect", () => connection.end(`${JSON.stringify({ command })}\n`))
      connection.on("close", done)
    } catch {
      resolve()
    }
  })

/**
 * A file a player can open: the cached file under a name with the type's extension (a hard link
 * beside it — some players go by the name), or a copy in the temporary folder when the cache
 * could not be written.
 */
export async function playablePath(file: { hash: string; bytes: Uint8Array; path?: string }, mime: string): Promise<string> {
  const extension = extensionForMime(mime)
  if (file.path !== undefined) {
    const named = `${file.path}${extension}`
    try {
      const info = await stat(named).catch(() => null)
      if (info !== null && info.size !== file.bytes.length) await unlink(named)
      if (info === null || info.size !== file.bytes.length) await link(file.path, named)
      return named
    } catch {
      return file.path
    }
  }
  const dir = join(tmpdir(), "loreweaver-audio")
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${file.hash}${extension}`)
  await writeFile(path, file.bytes)
  return path
}

/** Sounds over this connection's byte channel, into the cache pictures use. */
export function connectionSounds(connection: Connection): FetchSound {
  return async (hash, mime) => {
    const file = await connection.fetchMedia(hash, { mime }, { hold: false })
    return { bytes: file.bytes, path: await playablePath(file, mime) }
  }
}

/** The controller the app runs for a connection. */
export function audioFor(connection: Connection, muted: boolean): AudioController {
  return new AudioController({ session: connection.session, fetchSound: connectionSounds(connection), muted })
}

// --- the status line -----------------------------------------------------------------------------

/**
 * What plays, per layer (titles from the `audio` view), and the local marks: muted, or no player
 * on this machine. Empty when there is nothing to say.
 */
export function audioLine(view: AudioView | null, local: AudioLocalState, locale: string | undefined): string {
  const parts: string[] = []
  const playing = view?.playing ?? {}
  for (const layer of LOOP_LAYERS) {
    const entry = playing[layer]
    if (entry === undefined) continue
    const title = stripControlChars(entry.title) || stripControlChars(entry.id)
    const text = tt(locale, layer === "bgm" ? "audio.line.bgm" : "audio.line.ambience", { title })
    parts.push(entry.paused ? `${text} ${tt(locale, "audio.line.paused")}` : text)
  }
  if (local.muted) parts.push(tt(locale, "audio.line.muted"))
  else if (local.noPlayer && parts.length > 0) parts.push(tt(locale, "audio.line.noPlayer"))
  return parts.join(" · ")
}
