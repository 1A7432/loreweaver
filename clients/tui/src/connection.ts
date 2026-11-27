// The connection owner: dials a ticket, feeds the protocol `Session`, keeps the link alive with a
// client-side ping, and redials with backoff after a drop — but ONLY while `session.canRedial`.
// A fatal `error` (a bad key, another protocol major) ends the session for good and nothing here
// dials again. Every redial attaches the SAME `Session`, which resumes the log it holds.
//
// Server state lives in the session's snapshot alone. What this class keeps besides is the
// client's own: the transport's phase, the local lines a person sees but the room's log does not
// hold — a command's answer (which goes to the caller alone), a refusal, a notice — and the byte
// channel's client state: files fetched (and the on-disk cache behind them) and an upload's progress.
import {
  decodeMediaOfferResult,
  HELLO_TIMEOUT_MS,
  isContentHash,
  Session,
  SessionError,
  type BuiltInViewName,
  type ByteFile,
  type Result,
  type SessionSnapshot,
  type SignalPayloads,
  type Timers,
  type UploadPurpose,
} from "loreweaver-protocol/v3"
import { ByteError, type Dialer, type Transport } from "./irohLink"
import { cachedMediaPath, readCachedMedia, sha256Hex, sniffImageMime, writeCachedMedia, type LocalFile } from "./media"

/** Every built-in view the client shows. */
export const CLIENT_VIEWS: readonly BuiltInViewName[] = ["me", "party", "scene", "variables", "characters", "commands", "room", "usage", "panels", "audio"]

/** Local lines kept; the oldest go first. */
export const MAX_LOCAL_LINES = 200

/**
 * - `dialing`: a dial is under way.
 * - `online`: a link is up (the session's own status says whether the welcome came).
 * - `waiting`: the link dropped; the next dial is scheduled.
 * - `ended`: stopped for good — by the caller, a fatal error, or a first connection that never got in.
 */
export type ConnectionPhase = "dialing" | "online" | "waiting" | "ended"

/** A line for this person alone, placed in the log after the event numbered `after`. */
export interface LocalLine {
  readonly id: number
  readonly after: number
  /** `result`: a command's answer · `refusal`: `result.ok === false` · `notice`: a `notice` signal · `failed`: a request that got no result. */
  readonly kind: "result" | "refusal" | "notice" | "failed"
  readonly level: "info" | "warn"
  /** Text as the server wrote it (already in the right language); empty for `failed`. */
  readonly text: string
  /** The refusal's or failure's code. */
  readonly code?: string
  /** A notice about a long operation under way: shown animated until the next notice or the turn ends. */
  readonly spinner?: boolean
}

/** A file fetched over the byte channel (or read back from the cache). */
export interface FetchedMedia {
  readonly hash: string
  readonly bytes: Uint8Array
  readonly mime: string
  readonly name: string
  /** The cache file holding it; undefined when the cache could not be written. */
  readonly path?: string
}

export type FetchState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly file: FetchedMedia }
  /** `message`: the server's words (already in this member's language), or "" for a client-side failure. */
  | { readonly status: "failed"; readonly code: string; readonly message: string }

/** The upload under way. */
export interface UploadProgress {
  readonly name: string
  readonly purpose: UploadPurpose
  readonly size: number
  readonly sent: number
}

/**
 * Why the client stopped trying to reach the server: `redials` — the redials ran out;
 * `server_exited` — the server this client started itself has exited.
 */
export type LostReason = "redials" | "server_exited"

export interface ConnectionState {
  readonly phase: ConnectionPhase
  /** Redials since the last welcome. */
  readonly attempt: number
  /** Why the first dial failed (`ended` without a session error). */
  readonly dialError: string | null
  /** Requests sent and not yet answered: the client's own "working" signal before the turn's. */
  readonly pending: number
  readonly lines: readonly LocalLine[]
  /** Files asked for by hash, the newest last; at most `MAX_HELD_FETCHES`. */
  readonly fetches: ReadonlyMap<string, FetchState>
  readonly upload: UploadProgress | null
  /** Set when the client gave up on a server it had been playing on. */
  readonly lost: LostReason | null
}

/** Fetched files held in memory; the oldest go first (the disk cache keeps them). */
export const MAX_HELD_FETCHES = 16
/** Redials after a drop before the client gives up and says so. */
export const DEFAULT_MAX_REDIALS = 10

export interface RunCommandOptions {
  /** Leave the answer out of the local lines (see `Connection.runCommand`). */
  readonly quiet?: boolean
}

export interface ConnectionOptions {
  readonly ticket: string
  readonly key: string
  readonly name?: string
  /** This client's language: results and errors addressed to it are written in it. */
  readonly locale: string
  readonly client: { readonly name: string; readonly version: string }
  readonly dial: Dialer
  readonly timers?: Timers
  readonly now?: () => number
  readonly pingEveryMs?: number
  readonly pingTimeoutMs?: number
  /** How long a link may stay up without the server's welcome (default the protocol's `HELLO_TIMEOUT_MS`). */
  readonly welcomeTimeoutMs?: number
  readonly redialBaseMs?: number
  readonly redialMaxMs?: number
  readonly views?: readonly string[]
  /** Redials after a drop before giving up (default `DEFAULT_MAX_REDIALS`). */
  readonly maxRedials?: number
  /** Where fetched media is cached; the client's own cache folder when absent. */
  readonly mediaCacheDir?: string
}

const DEFAULT_PING_EVERY_MS = 15_000
const DEFAULT_PING_TIMEOUT_MS = 10_000
const DEFAULT_REDIAL_BASE_MS = 500
const DEFAULT_REDIAL_MAX_MS = 15_000

const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

export class Connection {
  readonly session: Session
  readonly ticket: string
  /** The language this connection said in `hello`: what the server words this member's answers in. */
  readonly locale: string
  readonly #options: ConnectionOptions
  readonly #timers: Timers
  #transport: Transport | null = null
  #state: ConnectionState = { phase: "dialing", attempt: 0, dialError: null, pending: 0, lines: [], fetches: new Map(), upload: null, lost: null }
  readonly #inflight = new Map<string, Promise<FetchedMedia>>()
  readonly #listeners = new Set<() => void>()
  #lineId = 0
  #established = false
  #stopped = false
  #redialTimer: unknown = undefined
  #pingTimer: unknown = undefined
  #welcomeTimer: unknown = undefined
  #lastStatus: SessionSnapshot["status"] = "idle"
  #lastResetSeq = 0

  constructor(options: ConnectionOptions) {
    this.#options = options
    this.ticket = options.ticket
    this.locale = options.locale
    this.#timers = options.timers ?? GLOBAL_TIMERS
    this.session = new Session({
      key: options.key,
      ...(options.name ? { name: options.name } : {}),
      locale: options.locale,
      client: options.client,
      caps: ["text-only"],
      timers: this.#timers,
      ...(options.now ? { now: options.now } : {}),
      // A listener of ours that throws must not take the session down; it has nowhere useful to go.
      onListenerError: () => undefined,
    })
    // Wanted before the first attach: the session subscribes them on every welcome.
    void this.session.viewSubscribe(options.views ?? CLIENT_VIEWS).catch(() => undefined)
    this.session.subscribe(this.#onSession)
    this.session.onNotice(this.#onNotice)
  }

  // --- the local store -------------------------------------------------------------------

  getState = (): ConnectionState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #set(patch: Partial<ConnectionState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /** Add a local line after the newest event. */
  note(line: Omit<LocalLine, "id" | "after">): void {
    const added: LocalLine = { ...line, id: ++this.#lineId, after: this.session.getSnapshot().head }
    // A new notice replaces a spinner notice: the operation it announced has moved on.
    const kept = line.kind === "notice" ? this.#state.lines.filter((entry) => !entry.spinner) : this.#state.lines
    this.#set({ lines: [...kept, added].slice(-MAX_LOCAL_LINES) })
  }

  // --- the link ----------------------------------------------------------------------------

  /** The first dial. Rejects when the ticket cannot be reached; that failure is not redialled. */
  async start(): Promise<void> {
    try {
      const transport = await this.#options.dial(this.ticket)
      if (this.#stopped) {
        transport.close()
        return
      }
      this.#adopt(transport)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.#stopped) this.#set({ phase: "ended", dialError: message })
      this.#stopped = true
      throw error
    }
  }

  /** Give up: the link closes, the session ends, nothing is redialled. */
  stop(): void {
    if (this.#stopped && this.#transport === null) return
    this.#stopped = true
    this.#clearTimers()
    const transport = this.#transport
    this.#transport = null
    transport?.close()
    this.session.end()
    this.#set({ phase: "ended" })
  }

  /**
   * Stop trying to reach the server and say why (`state.lost`): the redials ran out, or the
   * server this client started has exited. The session ends; nothing is dialled again.
   */
  giveUp(reason: LostReason): void {
    if (this.#state.lost !== null || this.#state.phase === "ended") return
    this.#set({ lost: reason })
    this.stop()
  }

  #adopt(transport: Transport): void {
    this.#transport = transport
    this.#set({ phase: "online" })
    const attachment = this.session.attach(transport)
    // The link is up and hello is sent; a server that then says nothing — neither welcome nor
    // a refusal — would otherwise hold this client "connecting" for ever (pings start at the
    // welcome). Drop the link: after a first welcome that is a redial, before it the end.
    this.#clearWelcome()
    this.#welcomeTimer = this.#timers.setTimeout(() => {
      this.#welcomeTimer = undefined
      if (this.#transport !== transport || this.session.status === "online" || this.#stopped) return
      this.#transport = null
      transport.close()
      this.session.closed("welcome timeout")
      this.#dropped()
    }, this.#options.welcomeTimeoutMs ?? HELLO_TIMEOUT_MS)
    transport.start(
      (value) => attachment.receive(value),
      (reason) => {
        if (this.#transport === transport) this.#transport = null
        attachment.closed(reason)
        this.#dropped()
      },
    )
  }

  /** The link went away (the session already knows). */
  #dropped(): void {
    this.#clearPing()
    this.#clearWelcome()
    if (this.#stopped) return
    if (!this.session.canRedial || !this.#established) {
      this.#stopped = true
      this.#set({ phase: "ended" })
      return
    }
    this.#scheduleRedial()
  }

  #scheduleRedial(): void {
    const attempt = this.#state.attempt
    if (attempt >= (this.#options.maxRedials ?? DEFAULT_MAX_REDIALS)) {
      this.giveUp("redials")
      return
    }
    const base = this.#options.redialBaseMs ?? DEFAULT_REDIAL_BASE_MS
    const max = this.#options.redialMaxMs ?? DEFAULT_REDIAL_MAX_MS
    const delay = Math.min(max, base * 2 ** Math.min(attempt, 16))
    this.#set({ phase: "waiting", attempt: attempt + 1 })
    this.#redialTimer = this.#timers.setTimeout(() => {
      this.#redialTimer = undefined
      void this.#redial()
    }, delay)
  }

  async #redial(): Promise<void> {
    if (this.#stopped || !this.session.canRedial) return
    this.#set({ phase: "dialing" })
    let transport: Transport
    try {
      transport = await this.#options.dial(this.ticket)
    } catch {
      if (!this.#stopped && this.session.canRedial) this.#scheduleRedial()
      return
    }
    if (this.#stopped || !this.session.canRedial) {
      transport.close()
      return
    }
    this.#adopt(transport)
  }

  #onSession = (): void => {
    const snapshot = this.session.getSnapshot()
    if (snapshot.status !== this.#lastStatus) {
      this.#lastStatus = snapshot.status
      if (snapshot.status === "online") {
        this.#clearWelcome()
        this.#established = true
        this.#set({ phase: "online", attempt: 0 })
        this.#schedulePing()
      } else if (snapshot.status === "ended") {
        this.#stopped = true
        this.#clearTimers()
        const transport = this.#transport
        this.#transport = null
        transport?.close()
        this.#set({ phase: "ended", lines: this.#state.lines.filter((line) => !line.spinner) })
      } else if (snapshot.status === "offline") {
        this.#set({ lines: this.#state.lines.filter((line) => !line.spinner) })
      }
    }
    // A finished turn ends whatever long operation a spinner notice announced.
    if (snapshot.turn?.status === "idle" && this.#state.lines.some((line) => line.spinner)) {
      this.#set({ lines: this.#state.lines.filter((line) => !line.spinner) })
    }
    // A reset cleared the scrollback: the local lines before it go with it.
    const first = snapshot.events[0]
    if (first !== undefined && first.kind === "reset" && first.seq > this.#lastResetSeq) {
      this.#lastResetSeq = first.seq
      this.#set({ lines: this.#state.lines.filter((line) => line.after >= first.seq) })
    }
  }

  #onNotice = (notice: SignalPayloads["notice"]): void => {
    this.note({
      kind: "notice",
      level: notice.level,
      text: notice.text,
      ...(notice.code ? { code: notice.code } : {}),
      ...(notice.spinner ? { spinner: true } : {}),
    })
  }

  #schedulePing(): void {
    this.#clearPing()
    const every = this.#options.pingEveryMs ?? DEFAULT_PING_EVERY_MS
    this.#pingTimer = this.#timers.setTimeout(() => {
      this.#pingTimer = undefined
      void this.#ping()
    }, every)
  }

  async #ping(): Promise<void> {
    const transport = this.#transport
    if (transport === null || this.#stopped) return
    try {
      await this.session.ping({ timeoutMs: this.#options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS })
      if (this.#transport === transport && !this.#stopped) this.#schedulePing()
    } catch (error) {
      // No pong in time: the link is dead even if the stream has not noticed. Drop it and redial.
      if (error instanceof SessionError && error.code === "timeout" && this.#transport === transport) {
        this.#transport = null
        transport.close()
        this.session.closed("ping timeout")
        this.#dropped()
      }
    }
  }

  #clearPing(): void {
    if (this.#pingTimer !== undefined) this.#timers.clearTimeout(this.#pingTimer)
    this.#pingTimer = undefined
  }

  #clearWelcome(): void {
    if (this.#welcomeTimer !== undefined) this.#timers.clearTimeout(this.#welcomeTimer)
    this.#welcomeTimer = undefined
  }

  #clearTimers(): void {
    this.#clearPing()
    this.#clearWelcome()
    if (this.#redialTimer !== undefined) this.#timers.clearTimeout(this.#redialTimer)
    this.#redialTimer = undefined
  }

  // --- acting --------------------------------------------------------------------------------

  /** What the player typed. The answer, if it says anything, becomes a local line. */
  input(text: string): Promise<Result | null> {
    return this.#track(this.session.input(text))
  }

  /**
   * `command.run`: the same handler a typed command reaches. `quiet` adds no local line for the
   * answer, the refusal or a failure: the caller shows the outcome itself. A command whose
   * answer carries a secret (a minted access key) must be run this way, or the key would sit in
   * the log lines the narrative view and the transcript are built from.
   */
  runCommand(id: string, args: Record<string, unknown> = {}, options: RunCommandOptions = {}): Promise<Result | null> {
    return this.#track(this.session.runCommand(id, args), options.quiet === true)
  }

  // --- the byte channel --------------------------------------------------------------------

  #setFetch(hash: string, state: FetchState): void {
    const fetches = new Map(this.#state.fetches)
    fetches.delete(hash)
    fetches.set(hash, state)
    for (const key of fetches.keys()) {
      if (fetches.size <= MAX_HELD_FETCHES) break
      if (key !== hash) fetches.delete(key)
    }
    this.#set({ fetches })
  }

  /**
   * A file by its content hash: from the disk cache when it holds it intact, else over a byte
   * stream (then kept in the cache). `hint` is what the log said about it (an event's `mime` and
   * `name`); a cached file has no other record of them. The progress shows in `state.fetches`;
   * a failure rejects with a `ByteError` (`server`: its message is the server's own words).
   * `hold: false` leaves `state.fetches` alone: a sound, which no picture view shows and which
   * may be large, is not kept in memory here.
   */
  fetchMedia(hash: string, hint: { mime?: string; name?: string } = {}, options: { hold?: boolean } = {}): Promise<FetchedMedia> {
    if (!isContentHash(hash)) return Promise.reject(new ByteError("bad_hash"))
    const running = this.#inflight.get(hash)
    if (running) return running
    const fetching = this.#fetch(hash, hint, options.hold ?? true).finally(() => {
      this.#inflight.delete(hash)
    })
    this.#inflight.set(hash, fetching)
    return fetching
  }

  async #fetch(hash: string, hint: { mime?: string; name?: string }, hold: boolean): Promise<FetchedMedia> {
    if (hold) this.#setFetch(hash, { status: "loading" })
    const dir = this.#options.mediaCacheDir
    try {
      let file: FetchedMedia
      const cached = await readCachedMedia(hash, dir)
      if (cached !== null) {
        const path = cachedMediaPath(hash, dir)
        file = { hash, bytes: cached, mime: hint.mime || sniffImageMime(cached) || "application/octet-stream", name: hint.name || hash.slice(0, 12), ...(path ? { path } : {}) }
      } else {
        const transport = this.#transport
        if (transport === null || this.session.status !== "online") throw new ByteError("not_connected")
        const got = await transport.fetch(hash)
        const path = await writeCachedMedia(hash, got.bytes, dir)
        file = { hash, bytes: got.bytes, mime: got.mime, name: got.name, ...(path ? { path } : {}) }
      }
      if (hold) this.#setFetch(hash, { status: "ready", file })
      return file
    } catch (error) {
      const failure = toByteError(error)
      if (hold) this.#setFetch(hash, { status: "failed", code: failure.code, message: failure.server ? failure.message : "" })
      throw failure
    }
  }

  /**
   * Upload a file: `media.offer` on the control stream, then — unless the server already holds
   * the bytes (`existing`) — the bytes on a PUT stream. Resolves with the stored file (its hash
   * is what `import {file}` names). One upload at a time; its progress is `state.upload`. A
   * refusal rejects with a `ByteError` carrying the server's code and words.
   */
  async upload(file: LocalFile, purpose: UploadPurpose = "share"): Promise<ByteFile> {
    if (this.#state.upload !== null) throw new ByteError("upload_busy")
    const sha256 = sha256Hex(file.bytes)
    const size = file.bytes.length
    this.#set({ upload: { name: file.name, purpose, size, sent: 0 } })
    this.#set({ pending: this.#state.pending + 1 })
    try {
      let result: Result
      try {
        result = await this.session.call("media.offer", { name: file.name, mime: file.mime, size, sha256, purpose })
      } catch (error) {
        throw toByteError(error)
      }
      if (!result.ok) throw new ByteError(result.error.code, result.error.message, true)
      const offer = decodeMediaOfferResult(result.data)
      if (offer === null) throw new ByteError("bad_reply")
      if ("existing" in offer) {
        const { hash, size: stored, mime, name } = offer.existing
        if (hash !== sha256) throw new ByteError("bad_reply")
        return { hash, size: stored, mime, name }
      }
      const transport = this.#transport
      if (transport === null) throw new ByteError("not_connected")
      const receipt = await transport.put(offer.upload_id, file.bytes, (sent) => {
        const current = this.#state.upload
        if (current !== null) this.#set({ upload: { ...current, sent } })
      })
      if (receipt.hash !== sha256 || receipt.size !== size) throw new ByteError("bad_reply")
      return receipt
    } finally {
      this.#set({ upload: null, pending: Math.max(0, this.#state.pending - 1) })
    }
  }

  async #track(request: Promise<Result>, quiet = false): Promise<Result | null> {
    this.#set({ pending: this.#state.pending + 1 })
    try {
      const result = await request
      if (quiet) return result
      if (result.ok) {
        if (result.text) this.note({ kind: "result", level: "info", text: result.text })
      } else {
        this.note({ kind: "refusal", level: "warn", text: result.error.message, code: result.error.code })
      }
      return result
    } catch (error) {
      if (!quiet) this.note({ kind: "failed", level: "warn", text: "", code: error instanceof SessionError ? error.code : "failed" })
      return null
    } finally {
      this.#set({ pending: Math.max(0, this.#state.pending - 1) })
    }
  }
}

/** Whatever a byte operation threw, as a coded `ByteError`. */
function toByteError(error: unknown): ByteError {
  if (error instanceof ByteError) return error
  if (error instanceof SessionError) return new ByteError(error.code === "link_closed" || error.code === "session_ended" ? "not_connected" : error.code)
  return new ByteError("failed", error instanceof Error ? error.message : String(error))
}
