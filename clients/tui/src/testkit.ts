/**
 * Shared test helpers. Nothing here sleeps on the wall clock: a test waits for the condition
 * it actually depends on (`waitFor`) and moves time only by hand (`ManualClock.advance`), so a
 * starved CI runner changes how long a test takes, never what it sees.
 */

/** Upper bound for one wait, below bun's 5 s test timeout so the failure names what was awaited. */
const WAIT_BOUND_MS = 3000

/** Yield to the event loop (I/O included) until `cond` holds; fail loudly instead of hanging. */
export async function waitFor(
  what: string,
  cond: () => boolean,
  detail?: () => string,
  beforeEachLook?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + WAIT_BOUND_MS
  for (;;) {
    if (beforeEachLook) await beforeEachLook()
    if (cond()) return
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${WAIT_BOUND_MS}ms${detail ? ` — ${detail()}` : ""}`)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * Wait for a screen that only appears after real I/O (a file write, a fetch that settles on a
 * later turn). The renderer's own `waitForFrame` stops as soon as the renderer is idle, which
 * is before such work has finished; this yields to the event loop between looks instead.
 */
export async function waitForScreen(
  harness: { flush: () => Promise<void>; captureCharFrame: () => string },
  what: string,
  has: (frame: string) => boolean,
): Promise<string> {
  let frame = ""
  await waitFor(
    what,
    () => has(frame),
    () => `last frame:\n${frame}`,
    async () => {
      await harness.flush()
      frame = harness.captureCharFrame()
    },
  )
  return frame
}

/** A few event-loop turns: lets something that must NOT happen show up if it were going to. */
export async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Manual timers + clock: a timer fires only when the test advances the clock past it. */
export class ManualClock {
  nowMs = 0
  private seq = 0
  protected readonly timers = new Map<number, { at: number; fn: () => void }>()
  now = (): number => this.nowMs
  setTimeoutFn = ((fn: () => void, ms = 0): ReturnType<typeof setTimeout> => {
    const id = ++this.seq
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    this.timers.delete(id as unknown as number)
  }) as unknown as typeof clearTimeout

  /** The options that route a component's timers and its clock through this clock. */
  get options(): { setTimeoutFn: typeof setTimeout; clearTimeoutFn: typeof clearTimeout; now: () => number } {
    return { setTimeoutFn: this.setTimeoutFn, clearTimeoutFn: this.clearTimeoutFn, now: this.now }
  }

  get armed(): number {
    return this.timers.size
  }

  /** Move the clock forward `ms`, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry
      }
      if (!next) break
      this.timers.delete(next[0])
      this.nowMs = Math.max(this.nowMs, next[1].at)
      next[1].fn()
    }
    this.nowMs = target
  }
}

// ---------------------------------------------------------------------------------------------
// A scripted 3.0 server behind a fake transport. Tests drive the UI with the REAL protocol
// `Session` (through `Connection`) and feed it server frames from here; nothing is mocked above
// the line of bytes. It answers the frames every client sends on its own — `hello`,
// `view.subscribe`, `ping` — and leaves the rest to the test (`onInput`, `onCall`).
// ---------------------------------------------------------------------------------------------

import type { ReactNode } from "react"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { createHash } from "node:crypto"
import { HeaderReader, type ByteFile, type ClientFrame, type EventFrame, type EventKind, type EventPayloads, type Role } from "loreweaver-protocol/v3"
import { Connection, type ConnectionOptions } from "./connection"
import { byteGet, bytePut, StreamGate, type ByteStreamLike, type Dialer, type FetchedFile, type Transport } from "./irohLink"

type Answer = { ok: true; text?: string; data?: unknown } | { ok: false; code: string; message: string }

/** One direction of an in-memory stream: chunks in, reads of at most `max` bytes out. */
export class Pipe {
  readonly #chunks: Uint8Array[] = []
  #ended = false
  #waiting: (() => void) | null = null

  push(chunk: Uint8Array): void {
    if (this.#ended) return
    if (chunk.length > 0) this.#chunks.push(chunk)
    this.#wake()
  }

  end(): void {
    this.#ended = true
    this.#wake()
  }

  #wake(): void {
    const waiting = this.#waiting
    this.#waiting = null
    waiting?.()
  }

  async read(max: number): Promise<number[] | null> {
    while (this.#chunks.length === 0 && !this.#ended) await new Promise<void>((resolve) => (this.#waiting = resolve))
    const chunk = this.#chunks.shift()
    if (chunk === undefined) return null
    if (chunk.length > max) this.#chunks.unshift(chunk.subarray(max))
    return Array.from(chunk.subarray(0, max))
  }

  /** Everything until the end. */
  async all(): Promise<Uint8Array> {
    const parts: number[] = []
    for (;;) {
      const chunk = await this.read(64 * 1024)
      if (chunk === null) return Uint8Array.from(parts)
      parts.push(...chunk)
    }
  }
}

/** A byte stream as the client sees it, and the two pipes behind it. */
export function memoryStream(): { client: ByteStreamLike; toServer: Pipe; toClient: Pipe } {
  const toServer = new Pipe()
  const toClient = new Pipe()
  return {
    toServer,
    toClient,
    client: {
      send: { writeAll: async (buf) => toServer.push(Uint8Array.from(buf)), finish: async () => toServer.end() },
      recv: { read: (max) => toClient.read(max), stop: async () => toClient.end() },
    },
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const line = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`)

export class FakeTransport implements Transport {
  readonly sent: ClientFrame[] = []
  closed = false
  #onValue: ((value: unknown) => void) | undefined
  #onEnd: ((reason: string) => void) | undefined
  readonly #server: FakeServer

  constructor(server: FakeServer) {
    this.#server = server
  }

  send(frame: ClientFrame): void {
    if (this.closed) return
    this.sent.push(frame)
    // Answer on a later turn, as a real server across a link would.
    queueMicrotask(() => this.#server.handle(this, frame))
  }

  start(onValue: (value: unknown) => void, onEnd: (reason: string) => void): void {
    this.#onValue = onValue
    this.#onEnd = onEnd
  }

  close(): void {
    this.closed = true
  }

  readonly #gate = new StreamGate()

  fetch(hash: string): Promise<FetchedFile> {
    return this.#gate.run(() => {
      if (this.closed) return Promise.reject(new Error("closed"))
      const stream = memoryStream()
      void this.#server.serveBytes(this, stream.toServer, stream.toClient)
      return byteGet(stream.client, hash, { stallMs: 2000 })
    })
  }

  put(uploadId: string, bytes: Uint8Array, onProgress?: (sent: number) => void): Promise<ByteFile> {
    return this.#gate.run(() => {
      if (this.closed) return Promise.reject(new Error("closed"))
      const stream = memoryStream()
      void this.#server.serveBytes(this, stream.toServer, stream.toClient)
      return bytePut(stream.client, uploadId, bytes, { stallMs: 2000, ...(onProgress ? { onProgress } : {}) })
    })
  }

  /** A frame from the server. */
  push(value: unknown): void {
    if (!this.closed) this.#onValue?.(value)
  }

  /** The stream breaks under the client. */
  drop(reason = "network"): void {
    if (this.closed) return
    this.closed = true
    this.#onEnd?.(reason)
  }

  calls(method?: string): Extract<ClientFrame, { type: "call" }>[] {
    return this.sent.filter((frame): frame is Extract<ClientFrame, { type: "call" }> => frame.type === "call" && (method === undefined || frame.method === method))
  }

  inputs(): string[] {
    return this.sent.flatMap((frame) => (frame.type === "input" ? [frame.text] : []))
  }
}

export interface FakeServerOptions {
  role?: Role
  name?: string
  room?: string
  locale?: string
}

export class FakeServer {
  readonly transports: FakeTransport[] = []
  readonly views = new Map<string, unknown>()
  readonly events: EventFrame[] = []
  epoch = 1
  role: Role
  name: string
  room: string
  locale: string
  /** Throw from the next dials (the ticket cannot be reached). */
  unreachable = false
  /** Answer a ping (false: the link is silently dead). */
  pong = true
  /** The protocol the welcome names. */
  protocol = "3.0"
  /** A fatal `error` instead of a welcome. */
  refuseHello: { code: string; message: string } | null = null
  onInput: (text: string, transport: FakeTransport) => Answer | null = () => ({ ok: true })
  onCall: (method: string, params: Record<string, unknown>, transport: FakeTransport) => Answer | null = () => ({ ok: true })
  /** Files the room holds, by hash (what a GET answers). */
  readonly files = new Map<string, { bytes: Uint8Array; mime: string; name: string; purpose: "share" | "import" | "audio" }>()
  /** Accepted offers waiting for their bytes. */
  readonly offers = new Map<string, { name: string; mime: string; size: number; sha256: string; purpose: "share" | "import" | "audio" }>()
  /** Every `media.offer` received, in order. */
  readonly offered: Record<string, unknown>[] = []
  /** Refuse every offer with this (the upload switch, an observer…). */
  refuseOffer: { code: string; message: string } | null = null
  /** Answer a byte stream with exactly these chunks instead (a misbehaving server). */
  rawBytes: ((request: unknown) => Uint8Array[]) | null = null
  #uploads = 0
  #seq = 0
  #rev = 0

  constructor(options: FakeServerOptions = {}) {
    this.role = options.role ?? "player"
    this.name = options.name ?? "Ada"
    this.room = options.room ?? "arkham"
    this.locale = options.locale ?? "en"
  }

  dial: Dialer = async () => {
    if (this.unreachable) throw new Error("no route to peer")
    const transport = new FakeTransport(this)
    this.transports.push(transport)
    return transport
  }

  get current(): FakeTransport {
    const transport = this.transports.at(-1)
    if (transport === undefined) throw new Error("nothing dialled")
    return transport
  }

  /** A Connection to this server, the way the app makes one. */
  connect(options: Partial<ConnectionOptions> = {}): Connection {
    return new Connection({ ticket: "endpointfaketicketfaketicketfake", key: "k", locale: "en", client: { name: "test", version: "0" }, dial: this.dial, ...options })
  }

  handle(transport: FakeTransport, frame: ClientFrame): void {
    if (transport.closed) return
    if (frame.type === "ping") {
      if (this.pong) transport.push({ type: "pong", t: frame.t })
      return
    }
    if (frame.type === "hello") {
      if (this.refuseHello) {
        transport.push({ type: "error", ...this.refuseHello, fatal: true })
        transport.drop("closed")
        return
      }
      transport.push({
        type: "welcome",
        protocol: this.protocol,
        server: { name: "loreweaver", version: "3.0.0-test" },
        room: { id: this.room, locale: this.locale },
        you: { id: "m1", name: this.name, role: this.role },
        features: [],
        epoch: this.epoch,
        head: this.#seq,
        first: this.events[0]?.seq ?? 0,
      })
      // As the server does: what was missed in the same generation, never more than the newest 200.
      const oldest = Math.max(0, this.#seq - 200)
      const after = frame.resume !== undefined && frame.resume.epoch === this.epoch ? Math.max(frame.resume.after, oldest) : oldest
      for (const event of this.events) if (event.seq > after) transport.push(event)
      return
    }
    if (frame.type === "input") {
      const answer = this.onInput(frame.text, transport)
      if (answer !== null) this.#answer(transport, frame.rid, answer)
      return
    }
    if (frame.method === "view.subscribe") {
      const names = (frame.params.names as string[]) ?? []
      transport.push({ type: "result", rid: frame.rid, ok: true, data: { problems: [] } })
      for (const name of names) if (this.views.has(name)) transport.push(this.#viewFrame(name))
      return
    }
    if (frame.method === "log.page") {
      const before = frame.params.before as number
      const limit = (frame.params.limit as number) ?? 100
      const events = this.events.filter((event) => event.seq < before).slice(-limit)
      transport.push({ type: "result", rid: frame.rid, ok: true, data: { events } })
      return
    }
    if (frame.method === "media.offer") {
      this.offered.push(frame.params)
      if (this.refuseOffer) {
        this.#answer(transport, frame.rid, { ok: false, ...this.refuseOffer })
        return
      }
      const params = frame.params as { name: string; mime: string; size: number; sha256: string; purpose?: "share" | "import" | "audio" }
      const held = this.files.get(params.sha256)
      if (held) {
        const existing = { hash: params.sha256, size: held.bytes.length, mime: held.mime, name: held.name, from: "m1" }
        this.#answer(transport, frame.rid, { ok: true, data: { existing } })
        return
      }
      const id = `u${++this.#uploads}`
      this.offers.set(id, { name: params.name, mime: params.mime, size: params.size, sha256: params.sha256, purpose: params.purpose ?? "share" })
      this.#answer(transport, frame.rid, { ok: true, data: { upload_id: id } })
      return
    }
    const answer = this.onCall(frame.method, frame.params, transport)
    if (answer !== null) this.#answer(transport, frame.rid, answer)
  }

  /** One byte stream, served the way the real server does (or by `rawBytes`). */
  async serveBytes(_transport: FakeTransport, toServer: Pipe, toClient: Pipe): Promise<void> {
    const received = await toServer.all()
    const reader = new HeaderReader()
    const step = reader.push(received)
    const request = step.state === "line" ? step.value : undefined
    const body = step.state === "line" ? step.rest : new Uint8Array(0)
    const reply = (chunks: Uint8Array[]) => {
      for (const chunk of chunks) toClient.push(chunk)
      toClient.end()
    }
    if (this.rawBytes) return reply(this.rawBytes(request))
    const refuse = (code: string) => reply([line({ ok: false, code, message: `refused: ${code}` })])
    const req = request as { op?: string; hash?: string; upload_id?: string } | undefined
    if (req?.op === "get" && typeof req.hash === "string") {
      const file = this.files.get(req.hash)
      if (!file) return refuse("media_not_found")
      return reply([line({ op: "get", ok: true, hash: req.hash, size: file.bytes.length, mime: file.mime, name: file.name }), file.bytes])
    }
    if (req?.op === "put" && typeof req.upload_id === "string") {
      const offer = this.offers.get(req.upload_id)
      if (!offer) return refuse("media_unknown_upload")
      this.offers.delete(req.upload_id)
      if (body.length !== offer.size) return refuse("media_size_mismatch")
      if (sha256(body) !== offer.sha256) return refuse("media_hash_mismatch")
      this.files.set(offer.sha256, { bytes: body, mime: offer.mime, name: offer.name, purpose: offer.purpose })
      reply([line({ op: "put", ok: true, hash: offer.sha256, size: body.length, mime: offer.mime, name: offer.name })])
      if (offer.purpose === "share") this.event("media", { hash: offer.sha256, mime: offer.mime, size: body.length, name: offer.name, from: "m1" })
      return
    }
    refuse("bad_request")
  }

  #answer(transport: FakeTransport, rid: string, answer: Answer): void {
    if (answer.ok) {
      transport.push({ type: "result", rid, ok: true, ...(answer.text === undefined ? {} : { text: answer.text }), ...(answer.data === undefined ? {} : { data: answer.data }) })
    } else {
      transport.push({ type: "result", rid, ok: false, error: { code: answer.code, message: answer.message } })
    }
  }

  #viewFrame(name: string): unknown {
    return { type: "view", name, rev: ++this.#rev, at: this.#seq, data: this.views.get(name) }
  }

  /** Set a view and push it to the live connection. */
  view(name: string, data: unknown): void {
    this.views.set(name, data)
    const transport = this.transports.at(-1)
    if (transport && !transport.closed) transport.push(this.#viewFrame(name))
  }

  /** Log an event and deliver it to the live connection. */
  event<K extends EventKind>(kind: K, data: EventPayloads[K], extra: { id?: string; turn?: number } = {}): EventFrame {
    const seq = ++this.#seq
    const event = { type: "event", seq, id: extra.id ?? `e${seq}`, ts: 1_700_000_000_000 + seq, kind, data, ...(extra.turn === undefined ? {} : { turn: extra.turn }) } as EventFrame
    this.events.push(event)
    const transport = this.transports.at(-1)
    if (transport && !transport.closed) transport.push(event)
    return event
  }

  /** A narrative line, the most common event. */
  say(text: string, speaker: "player" | "kp" | "npc" | "system" = "kp", name?: string, id?: string): EventFrame {
    return this.event("narrative", { speaker, text, format: speaker === "kp" ? "markdown" : "plain", ...(name ? { name } : {}) }, id ? { id } : {})
  }

  /** A signal to the live connection. */
  signal(kind: string, data: unknown): void {
    this.current.push({ type: "signal", kind, data })
  }
}

/** Let queued microtasks and immediate callbacks run (the fake server answers on them). */
export async function pump(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * `testRender` for a screen fed by a live session: frames arrive on their own turns, outside any
 * `act()`, as they do in the app. Rendering then follows React's scheduler, and a test waits for
 * what it needs with `waitForScreen` instead of wrapping each delivery in `act()`.
 */
export async function liveRender(node: ReactNode, options: { width: number; height: number }): ReturnType<typeof testRender> {
  const harness = await testRender(node, options)
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  env.IS_REACT_ACT_ENVIRONMENT = false
  // Teardown unmounts inside `act()`: call `renderer.destroy()` directly (not inside `act`).
  const destroy = harness.renderer.destroy.bind(harness.renderer)
  harness.renderer.destroy = () => {
    env.IS_REACT_ACT_ENVIRONMENT = true
    act(() => destroy())
  }
  return harness
}
