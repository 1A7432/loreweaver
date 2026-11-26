// The connection owner: dials a ticket, feeds the protocol `Session`, keeps the link alive with a
// client-side ping, and redials with backoff after a drop — but ONLY while `session.canRedial`.
// A fatal `error` (a bad key, another protocol major) ends the session for good and nothing here
// dials again. Every redial attaches the SAME `Session`, which resumes the log it holds.
//
// Server state lives in the session's snapshot alone. What this class keeps besides is the
// client's own: the transport's phase, and the local lines a person sees but the room's log does
// not hold — a command's answer (which goes to the caller alone), a refusal, a notice.
import {
  Session,
  SessionError,
  type BuiltInViewName,
  type Result,
  type SessionSnapshot,
  type SignalPayloads,
  type Timers,
} from "loreweaver-protocol/v3"
import type { Dialer, Transport } from "./irohLink"

/** Every built-in view the client shows. */
export const CLIENT_VIEWS: readonly BuiltInViewName[] = ["me", "party", "scene", "variables", "characters", "commands", "room", "usage"]

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

export interface ConnectionState {
  readonly phase: ConnectionPhase
  /** Redials since the last welcome. */
  readonly attempt: number
  /** Why the first dial failed (`ended` without a session error). */
  readonly dialError: string | null
  /** Requests sent and not yet answered: the client's own "working" signal before the turn's. */
  readonly pending: number
  readonly lines: readonly LocalLine[]
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
  readonly redialBaseMs?: number
  readonly redialMaxMs?: number
  readonly views?: readonly string[]
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
  readonly #options: ConnectionOptions
  readonly #timers: Timers
  #transport: Transport | null = null
  #state: ConnectionState = { phase: "dialing", attempt: 0, dialError: null, pending: 0, lines: [] }
  readonly #listeners = new Set<() => void>()
  #lineId = 0
  #established = false
  #stopped = false
  #redialTimer: unknown = undefined
  #pingTimer: unknown = undefined
  #lastStatus: SessionSnapshot["status"] = "idle"
  #lastResetSeq = 0

  constructor(options: ConnectionOptions) {
    this.#options = options
    this.ticket = options.ticket
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

  #adopt(transport: Transport): void {
    this.#transport = transport
    this.#set({ phase: "online" })
    const attachment = this.session.attach(transport)
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

  #clearTimers(): void {
    this.#clearPing()
    if (this.#redialTimer !== undefined) this.#timers.clearTimeout(this.#redialTimer)
    this.#redialTimer = undefined
  }

  // --- acting --------------------------------------------------------------------------------

  /** What the player typed. The answer, if it says anything, becomes a local line. */
  input(text: string): Promise<Result | null> {
    return this.#track(this.session.input(text))
  }

  /** `command.run`: the same handler a typed command reaches. */
  runCommand(id: string, args: Record<string, unknown> = {}): Promise<Result | null> {
    return this.#track(this.session.runCommand(id, args))
  }

  async #track(request: Promise<Result>): Promise<Result | null> {
    this.#set({ pending: this.#state.pending + 1 })
    try {
      const result = await request
      if (result.ok) {
        if (result.text) this.note({ kind: "result", level: "info", text: result.text })
      } else {
        this.note({ kind: "refusal", level: "warn", text: result.error.message, code: result.error.code })
      }
      return result
    } catch (error) {
      const code = error instanceof SessionError ? error.code : "failed"
      this.note({ kind: "failed", level: "warn", text: "", code })
      return null
    } finally {
      this.#set({ pending: Math.max(0, this.#state.pending - 1) })
    }
  }
}
