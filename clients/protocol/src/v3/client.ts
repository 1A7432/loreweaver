// The 3.0 client session: everything a UI needs that is neither UI nor transport.
//
// A transport hands it a link (`{ send(frame) }`) and feeds it what arrives (`receive`) and
// when the link goes (`closed`). In return it keeps a live, consistent picture of the table
// — the room's log, the drafts being streamed, the turn status, the views — as one immutable
// snapshot, and offers methods to act. It does no I/O, opens no connection and keeps no
// timer it was not handed: the clock and the timer functions are injected.
//
// The session outlives a link. When the link drops, `attach` a new one: the session says
// hello again with `resume {epoch, after}` from the log it kept, re-subscribes the views it
// wants and reconciles what it holds. A FATAL `error` frame (a bad key, another protocol
// major…) ends it for good: `status` becomes `"ended"` and `canRedial` false.
import {
  type BuiltInViewName,
  type BuiltInViews,
  type ClientFrame,
  type ErrorBody,
  type EventFrame,
  type HelloFrame,
  MAX_VIEW_NAMES,
  PAGE_LIMIT,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  protocolMajor,
  type ResultFrame,
  RESUME_LIMIT,
  type SignalFrame,
  type SignalPayloads,
  type ViewFrame,
  type ViewListing,
  type ViewSchema,
  type WelcomeFrame,
} from "./frames.js";
import { BUILT_IN_VIEW_SCHEMAS } from "./views.js";
import { decodeEventFrame, inspectServerFrame, MAX_PAGE_EVENTS, MAX_SHORT_CHARS, MAX_TEXT_CHARS } from "./decode.js";
import { matchesSchema } from "./schema.js";

/** The default size of the log window the session keeps; the oldest events beyond it are dropped. */
export const DEFAULT_MAX_EVENTS = 2000;

/** Where frames go. The transport's owner makes one per connection. */
export interface Link {
  send(frame: ClientFrame): void;
}

/** What `attach` returns: the same `receive` / `closed` as the session's, bound to this one link. */
export interface Attachment {
  receive(value: unknown): void;
  closed(reason?: string): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionOptions {
  readonly key: string;
  /** The name to appear under; the key's own name when absent. */
  readonly name?: string;
  /** The client's language: what results and errors addressed to it are written in. */
  readonly locale: string;
  readonly client: { readonly name: string; readonly version: string };
  readonly caps?: readonly string[];
  /** The log window: at most this many events are kept, the oldest dropped first. */
  readonly maxEvents?: number;
  /** A default timeout for every request, in ms; none when absent. */
  readonly requestTimeoutMs?: number;
  /** Timer functions; the global ones when absent. Only used for request timeouts. */
  readonly timers?: Timers;
  /** The clock, in ms; `Date.now` when absent. Used for ping round trips. */
  readonly now?: () => number;
  /** Where an error thrown by a listener goes; rethrown on its own microtask when absent. */
  readonly onListenerError?: (error: unknown) => void;
}

/**
 * - `idle`: never attached.
 * - `connecting`: attached, `hello` sent, no `welcome` yet.
 * - `online`: welcomed.
 * - `offline`: the link dropped; attach a new one to resume.
 * - `ended`: refused for good (a fatal error) or ended by the caller: do not redial.
 */
export type SessionStatus = "idle" | "connecting" | "online" | "offline" | "ended";

/** A coded failure. `fatal`: the session is over and must not be redialled. */
export interface SessionFailure {
  readonly code: string;
  readonly message: string;
  readonly fatal: boolean;
}

/**
 * A request did not get its `result`: `link_closed`, `timeout`, `not_connected`,
 * `session_ended`, or the fatal code that ended the session.
 */
export class SessionError extends Error {
  readonly code: string;
  readonly fatal: boolean;

  constructor(code: string, message = code, fatal = false) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.fatal = fatal;
  }
}

/** The one answer to an `input` or a `call`. A refusal is an answer, not an exception. */
export type Result<T = unknown> = { readonly ok: true; readonly data: T; readonly text?: string } | { readonly ok: false; readonly error: ErrorBody };

export interface RequestOptions {
  /** Overrides the session's `requestTimeoutMs` for this request. */
  readonly timeoutMs?: number;
}

/** A view's latest value, the rev it came under and the log position it reflects. */
export interface HeldView<T = unknown> {
  readonly name: string;
  readonly rev: number;
  readonly at: number;
  readonly data: T;
}

/** A bubble being streamed: shown after the last event until its `narrative` event replaces it. */
export interface Draft {
  readonly id: string;
  readonly text: string;
}

/** Events the client knows it is missing: every `seq` with `after < seq < before`. */
export interface LogGap {
  readonly after: number;
  readonly before: number;
}

export type TurnStatus = SignalPayloads["turn"];

export interface SessionSnapshot {
  readonly status: SessionStatus;
  /** The welcome of the current (or last) connection. */
  readonly welcome: WelcomeFrame | null;
  /** The room generation the log was built under; null before the first welcome. */
  readonly epoch: number | null;
  /** The newest `seq` the room is known to have handed out. */
  readonly head: number;
  /** The log window, in `seq` order, without duplicates. `seq` may skip (an undo leaves holes). */
  readonly events: readonly EventFrame[];
  readonly drafts: readonly Draft[];
  /** The latest `turn` signal; null when unknown (before one, after a drop). */
  readonly turn: TurnStatus | null;
  readonly views: ReadonlyMap<string, HeldView>;
  /** A subscription the server refused, by view name: its code. */
  readonly viewProblems: ReadonlyMap<string, string>;
  /** Events known missing inside the window; `loadOlder` fills it. */
  readonly gap: LogGap | null;
  /** The window starts at the beginning of the room's log: there is nothing older to load. */
  readonly complete: boolean;
  /** The last ping's round trip, in ms. */
  readonly rtt: number | null;
  readonly lastError: SessionFailure | null;
}

interface Pending {
  readonly resolve: (result: Result) => void;
  readonly reject: (error: SessionError) => void;
  readonly timer: unknown;
}

interface PendingPing {
  readonly resolve: (rtt: number) => void;
  readonly reject: (error: SessionError) => void;
  readonly timer: unknown;
}

interface Current {
  readonly link: Link;
  /** Which attachment this is: a view's rev is only comparable within one. */
  readonly serial: number;
  live: boolean;
}

const BUILT_IN_SCHEMAS: ReadonlyMap<string, ViewSchema> = new Map(Object.entries(BUILT_IN_VIEW_SCHEMAS));

const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShort(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SHORT_CHARS;
}

/** Index of the first event with `seq >= target` (events sorted by seq). */
function lowerBound(events: readonly EventFrame[], target: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((events[mid] as EventFrame).seq < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export class Session {
  readonly #options: SessionOptions;
  readonly #maxEvents: number;
  readonly #timers: Timers;
  readonly #now: () => number;

  #status: SessionStatus = "idle";
  #current: Current | null = null;
  #serial = 0;
  #welcome: WelcomeFrame | null = null;
  #lastError: SessionFailure | null = null;

  // The log.
  #epoch: number | null = null;
  #head = 0;
  /** The newest seq received (kept when the window drops it): what a resume asks after. */
  #lastSeq = 0;
  #events: readonly EventFrame[] = [];
  #gap: LogGap | null = null;
  #complete = false;
  /** Moves whenever the log is cut, cleared or discarded: a page fetched before is void. */
  #logVersion = 0;
  #loading: Promise<number> | null = null;

  #drafts: readonly Draft[] = [];
  #turn: TurnStatus | null = null;
  #rtt: number | null = null;

  // Views.
  readonly #wanted = new Set<string>();
  #views: ReadonlyMap<string, HeldView> = new Map();
  /** The attachment each held view's rev came from. */
  readonly #viewSerial = new Map<string, number>();
  #viewProblems: ReadonlyMap<string, string> = new Map();

  // Requests.
  #rid = 0;
  readonly #pending = new Map<string, Pending>();
  readonly #pings = new Map<number, PendingPing>();

  // Notification.
  readonly #listeners = new Set<() => void>();
  readonly #signalListeners = new Set<(frame: SignalFrame) => void>();
  #snapshot: SessionSnapshot | null = null;
  #dropped = 0;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    this.#timers = options.timers ?? GLOBAL_TIMERS;
    this.#now = options.now ?? Date.now;
  }

  // --- state -------------------------------------------------------------------------

  get status(): SessionStatus {
    return this.#status;
  }

  /** False once the session is over: the transport's owner must not dial again. */
  get canRedial(): boolean {
    return this.#status !== "ended";
  }

  /** Frames dropped as malformed since the session began (unknown kinds are not counted). */
  get droppedFrames(): number {
    return this.#dropped;
  }

  /** The current picture of the table: the same object until something changes. */
  getSnapshot = (): SessionSnapshot => {
    if (this.#snapshot === null) {
      this.#snapshot = Object.freeze({
        status: this.#status,
        welcome: this.#welcome,
        epoch: this.#epoch,
        head: this.#head,
        events: this.#events,
        drafts: this.#drafts,
        turn: this.#turn,
        views: this.#views,
        viewProblems: this.#viewProblems,
        gap: this.#gap,
        complete: this.#complete,
        rtt: this.#rtt,
        lastError: this.#lastError,
      });
    }
    return this.#snapshot;
  };

  /** Be told whenever the snapshot changed (`useSyncExternalStore(session.subscribe, session.getSnapshot)`). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every signal as it arrives — `notice` and `audio` above all, which are not kept. */
  onSignal(listener: (frame: SignalFrame) => void): () => void {
    this.#signalListeners.add(listener);
    return () => {
      this.#signalListeners.delete(listener);
    };
  }

  /** `notice` signals as they arrive. */
  onNotice(listener: (notice: SignalPayloads["notice"]) => void): () => void {
    return this.onSignal((frame) => {
      if (frame.kind === "notice") listener(frame.data);
    });
  }

  /** A built-in view's latest value, typed. */
  view<K extends BuiltInViewName>(name: K): HeldView<BuiltInViews[K]> | null {
    return (this.#views.get(name) as HeldView<BuiltInViews[K]> | undefined) ?? null;
  }

  /** A module view's latest value (`<module>/<name>`), as the module shaped it. */
  moduleView(name: string): HeldView | null {
    return this.#views.get(name) ?? null;
  }

  // --- the link ------------------------------------------------------------------------

  /** Start a connection over `link`: says hello, resuming from the kept log when there is one. */
  attach(link: Link): Attachment {
    if (this.#status === "ended") throw new SessionError("session_ended", this.#lastError?.message ?? "session_ended", true);
    if (this.#current !== null) this.#drop("link_replaced", "");
    const current: Current = { link, serial: ++this.#serial, live: true };
    this.#current = current;
    this.#status = "connecting";
    this.#changed();
    const options = this.#options;
    const hello: HelloFrame = {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      key: options.key,
      locale: options.locale,
      client: { name: options.client.name, version: options.client.version },
      caps: [...(options.caps ?? [])],
    };
    if (options.name !== undefined) hello.name = options.name;
    if (this.#epoch !== null) hello.resume = { epoch: this.#epoch, after: this.#lastSeq };
    this.#send(current, hello);
    return {
      receive: (value) => {
        if (current.live) this.#receive(value);
      },
      closed: (reason) => {
        if (current.live) this.#drop("link_closed", reason ?? "");
      },
    };
  }

  /** One parsed JSON value from the current link. */
  receive(value: unknown): void {
    if (this.#current !== null) this.#receive(value);
  }

  /** The current link is gone (the transport noticed). Pending requests are rejected. */
  closed(reason?: string): void {
    if (this.#current !== null) this.#drop("link_closed", reason ?? "");
  }

  /** The caller gives up: the session ends for good. The transport closes the link itself. */
  end(): void {
    if (this.#status !== "ended") this.#end({ code: "ended", message: "", fatal: true });
  }

  // --- requests ------------------------------------------------------------------------

  /** A line the player typed: speech or a text command. */
  input(text: string, options: RequestOptions = {}): Promise<Result> {
    return this.#request((rid) => ({ type: "input", rid, text }), options);
  }

  /** Any call; the typed helpers below cover the methods the server implements. */
  call(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<Result> {
    return this.#request((rid) => ({ type: "call", rid, method, params }), options);
  }

  /** `command.run {id, args}`: the same handler a typed command reaches. */
  runCommand(id: string, args: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<Result> {
    return this.call("command.run", { id, args }, options);
  }

  /** `view.list`: the views this connection may subscribe to, each with its schema. */
  async viewList(options: RequestOptions = {}): Promise<Result<{ views: ViewListing[] }>> {
    const result = await this.call("view.list", {}, options);
    if (!result.ok) return result;
    const views = isRecord(result.data) ? result.data.views : undefined;
    if (!Array.isArray(views)) return badResult();
    const listed: ViewListing[] = [];
    for (const entry of views) {
      if (!isRecord(entry) || !isShort(entry.name) || !isRecord(entry.schema)) continue;
      const listing: ViewListing = { name: entry.name, schema: entry.schema };
      if (typeof entry.title === "string") listing.title = entry.title;
      listed.push(listing);
    }
    return { ok: true, data: { views: listed } };
  }

  /**
   * `view.subscribe`: the names join the set this session wants, re-subscribed on every
   * connection — they stay wanted even when this call cannot be made now (rejected with
   * `not_connected`). The current values follow as `view` frames.
   */
  async viewSubscribe(names: readonly string[], options: RequestOptions = {}): Promise<Result<{ problems: { name: string; code: string }[] }>> {
    for (const name of names) this.#wanted.add(name);
    return this.#subscribe([...new Set(names)], options);
  }

  /** `view.unsubscribe`: the names leave the wanted set and their values are dropped at once. */
  async viewUnsubscribe(names: readonly string[], options: RequestOptions = {}): Promise<Result<{ removed: string[] }>> {
    const views = new Map(this.#views);
    const problems = new Map(this.#viewProblems);
    for (const name of names) {
      this.#wanted.delete(name);
      views.delete(name);
      problems.delete(name);
      this.#viewSerial.delete(name);
    }
    this.#views = views;
    this.#viewProblems = problems;
    this.#changed();
    const removed: string[] = [];
    for (const chunk of chunks([...new Set(names)], MAX_VIEW_NAMES)) {
      const result = await this.call("view.unsubscribe", { names: chunk }, options);
      if (!result.ok) return result;
      const list = isRecord(result.data) ? result.data.removed : undefined;
      if (Array.isArray(list)) for (const name of list) if (typeof name === "string") removed.push(name);
    }
    return { ok: true, data: { removed } };
  }

  /** `view.get`: the view recomputed now. A view this session wants is updated from it too. */
  async viewGet(name: string, options: RequestOptions = {}): Promise<Result<HeldView>> {
    const serial = this.#current?.serial ?? -1;
    const result = await this.call("view.get", { name }, options);
    if (!result.ok) return result;
    const data = result.data;
    if (!isRecord(data) || data.name !== name || !Number.isSafeInteger(data.rev) || !Number.isSafeInteger(data.at) || !("data" in data)) return badResult();
    const held: HeldView = { name, rev: data.rev as number, at: data.at as number, data: data.data };
    if (BUILT_IN_SCHEMAS.has(name) && !matchesSchema(held.data, BUILT_IN_SCHEMAS.get(name) as ViewSchema)) return badResult("bad_view");
    if (this.#current?.serial === serial) this.#hold(held, serial);
    return { ok: true, data: held };
  }

  /** `log.page {before, limit}`: a page of history, oldest first. It does not touch the window. */
  async logPage(before: number, limit: number = PAGE_LIMIT, options: RequestOptions = {}): Promise<Result<{ events: EventFrame[] }>> {
    const result = await this.call("log.page", { before, limit }, options);
    if (!result.ok) return result;
    const list = isRecord(result.data) ? result.data.events : undefined;
    if (!Array.isArray(list) || list.length > MAX_PAGE_EVENTS) return badResult();
    const events: EventFrame[] = [];
    for (const item of list) {
      const event = decodeEventFrame(item);
      if (event === null) this.#dropped++;
      else events.push(event);
    }
    events.sort((a, b) => a.seq - b.seq);
    return { ok: true, data: { events } };
  }

  /**
   * Load older events into the window: into the gap when there is one (what a resume could
   * not replay), else before the oldest event held — while the window has room. Resolves
   * with how many events were added. One load at a time: a second call shares the first.
   *
   * 0 does not by itself mean "nothing older": a `log.page` the server refused also resolves
   * 0, leaves `gap` and `complete` as they were, and puts the refusal on the snapshot as
   * `lastError` (`{code, message, fatal: false}`, a new object), where every non-fatal
   * refusal of the session goes. Nothing older is `complete: true` with no `gap`. Without a
   * connection it rejects, as every request does.
   */
  loadOlder(options: RequestOptions = {}): Promise<number> {
    if (this.#loading !== null) return this.#loading;
    const loading = this.#loadOlder(options).finally(() => {
      this.#loading = null;
    });
    this.#loading = loading;
    return loading;
  }

  /** Measure the round trip: `ping {t}` → `pong {t}`. The caller schedules it. */
  ping(options: RequestOptions = {}): Promise<number> {
    const current = this.#current;
    if (current === null) return Promise.reject(this.#notConnected());
    let t = this.#now();
    while (this.#pings.has(t)) t += 0.001;
    return new Promise<number>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
      const timer =
        timeoutMs === undefined
          ? undefined
          : this.#timers.setTimeout(() => {
              if (this.#pings.delete(t)) reject(new SessionError("timeout"));
            }, timeoutMs);
      this.#pings.set(t, { resolve, reject, timer });
      this.#send(current, { type: "ping", t });
    });
  }

  // --- inbound -------------------------------------------------------------------------

  #receive(value: unknown): void {
    if (this.#status === "ended") return;
    const decoded = inspectServerFrame(value);
    if (decoded.kind === "malformed") {
      this.#dropped++;
      return;
    }
    if (decoded.kind === "unknown") {
      // An event of a kind this version does not know still took its place in the log.
      if (decoded.seq !== undefined && decoded.seq > this.#lastSeq) {
        this.#lastSeq = decoded.seq;
        this.#head = Math.max(this.#head, decoded.seq);
        this.#changed();
      }
      return;
    }
    const frame = decoded.frame;
    switch (frame.type) {
      case "welcome":
        this.#onWelcome(frame);
        return;
      case "event":
        this.#onEvent(frame);
        this.#trim();
        this.#changed();
        return;
      case "signal":
        this.#onSignal(frame);
        return;
      case "view":
        this.#onView(frame);
        return;
      case "result":
        this.#onResult(frame);
        return;
      case "error": {
        const failure: SessionFailure = { code: frame.code, message: frame.message, fatal: frame.fatal };
        if (frame.fatal) this.#end(failure);
        else {
          this.#lastError = failure;
          this.#changed();
        }
        return;
      }
      case "pong": {
        const ping = this.#pings.get(frame.t);
        if (ping === undefined) return;
        this.#pings.delete(frame.t);
        if (ping.timer !== undefined) this.#timers.clearTimeout(ping.timer);
        this.#rtt = Math.max(0, this.#now() - frame.t);
        this.#changed();
        ping.resolve(this.#rtt);
        return;
      }
    }
  }

  #onWelcome(frame: WelcomeFrame): void {
    if (this.#status !== "connecting") return;
    if (protocolMajor(frame.protocol) !== PROTOCOL_MAJOR) {
      this.#end({ code: "protocol_mismatch", message: `server ${frame.protocol}, client ${PROTOCOL_VERSION}`, fatal: true });
      return;
    }
    // A log built under another generation is void: the server sends the newest stretch
    // afresh. So is one that claims more than the room ever handed out.
    if (this.#epoch !== null && (frame.epoch !== this.#epoch || frame.head < this.#lastSeq)) this.#discardLog();
    if (this.#epoch === null || (this.#events.length === 0 && this.#lastSeq === 0)) {
      // A first visit is sent the events numbered above `head - RESUME_LIMIT`: that is the
      // whole log when the room's oldest entry is among them, or when it has none.
      this.#complete = frame.first === 0 || frame.first > frame.head - RESUME_LIMIT;
    } else if (frame.head - this.#lastSeq > RESUME_LIMIT) {
      // Only the newest stretch is replayed: what lies between is missing.
      const before = frame.head - RESUME_LIMIT + 1;
      this.#gap = this.#gap === null ? { after: this.#lastSeq, before } : { after: this.#gap.after, before };
    }
    this.#epoch = frame.epoch;
    this.#head = frame.head;
    this.#welcome = frame;
    this.#status = "online";
    this.#changed();
    if (this.#wanted.size > 0) {
      void this.#subscribe([...this.#wanted], {}).catch(() => undefined);
    }
  }

  #onEvent(frame: EventFrame): void {
    if (frame.kind === "rewind") {
      // Everything numbered `from` or higher no longer happened, except what `kept` names;
      // the room moved to a new generation.
      this.#cut(frame.data.from, frame.data.kept);
      this.#adoptEpoch(frame.data.epoch);
    } else if (frame.kind === "reset") {
      this.#events = [];
      this.#gap = null;
      this.#drafts = [];
      this.#logVersion++;
      // The server's log restarts at the reset: there is nothing older.
      this.#complete = true;
      this.#adoptEpoch(frame.data.epoch);
    }
    this.#insert([frame]);
    if (frame.kind === "narrative" && this.#drafts.some((draft) => draft.id === frame.id)) {
      this.#drafts = this.#drafts.filter((draft) => draft.id !== frame.id);
    }
    if (frame.seq > this.#lastSeq) this.#lastSeq = frame.seq;
    if (frame.seq > this.#head) this.#head = frame.seq;
  }

  #onSignal(frame: SignalFrame): void {
    switch (frame.kind) {
      case "draft":
        this.#onDraft(frame.data);
        break;
      case "turn":
        this.#turn = frame.data;
        // A finished turn's drafts that never became events are dead.
        if (frame.data.status === "idle") this.#drafts = [];
        this.#changed();
        break;
      default:
        break;
    }
    for (const listener of [...this.#signalListeners]) this.#call(() => listener(frame));
  }

  #onDraft(data: SignalPayloads["draft"]): void {
    const index = this.#drafts.findIndex((draft) => draft.id === data.id);
    if ("discard" in data) {
      if (index < 0) return;
      this.#drafts = this.#drafts.filter((draft) => draft.id !== data.id);
    } else if (index >= 0) {
      const held = this.#drafts[index] as Draft;
      if (held.text.length + data.text.length > MAX_TEXT_CHARS) return;
      const drafts = [...this.#drafts];
      drafts[index] = { id: data.id, text: held.text + data.text };
      this.#drafts = drafts;
    } else {
      // A draft whose event already arrived is stale.
      if (this.#hasRecentEvent(data.id)) return;
      this.#drafts = [...this.#drafts, { id: data.id, text: data.text }];
    }
    this.#changed();
  }

  #onView(frame: ViewFrame): void {
    const serial = this.#current?.serial;
    if (serial === undefined || !this.#wanted.has(frame.name)) return;
    const schema = BUILT_IN_SCHEMAS.get(frame.name);
    if (schema !== undefined && !matchesSchema(frame.data, schema)) {
      this.#dropped++;
      this.#lastError = { code: "bad_view", message: frame.name, fatal: false };
      this.#changed();
      return;
    }
    this.#hold({ name: frame.name, rev: frame.rev, at: frame.at, data: frame.data }, serial);
  }

  /** Keep a view value unless one of a higher rev from the same connection is held. */
  #hold(view: HeldView, serial: number): void {
    if (!this.#wanted.has(view.name)) return;
    const held = this.#views.get(view.name);
    if (held !== undefined && this.#viewSerial.get(view.name) === serial && view.rev <= held.rev) return;
    const views = new Map(this.#views);
    views.set(view.name, Object.freeze({ ...view }));
    this.#views = views;
    this.#viewSerial.set(view.name, serial);
    this.#changed();
  }

  #onResult(frame: ResultFrame): void {
    const pending = this.#pending.get(frame.rid);
    if (pending === undefined) return;
    this.#pending.delete(frame.rid);
    if (pending.timer !== undefined) this.#timers.clearTimeout(pending.timer);
    if (frame.ok) {
      const result: { ok: true; data: unknown; text?: string } = { ok: true, data: frame.data };
      if (frame.text !== undefined) result.text = frame.text;
      pending.resolve(result);
    } else {
      pending.resolve({ ok: false, error: frame.error });
    }
  }

  // --- the log -------------------------------------------------------------------------

  /** Merge events in, by seq, without duplicates. */
  #insert(incoming: readonly EventFrame[]): void {
    let events: EventFrame[] | null = null;
    for (const event of incoming) {
      const list: readonly EventFrame[] = events ?? this.#events;
      const last = list.at(-1);
      if (last === undefined || event.seq > last.seq) {
        events ??= [...this.#events];
        events.push(event);
        continue;
      }
      const at = lowerBound(list, event.seq);
      if (list[at]?.seq === event.seq) continue;
      events ??= [...this.#events];
      events.splice(at, 0, event);
    }
    if (events !== null) this.#events = events;
  }

  /** Drop every event after `to`. */
  #cut(from: number, kept: readonly number[]): void {
    const at = lowerBound(this.#events, from);
    if (at < this.#events.length) {
      const survivors = new Set(kept);
      this.#events = [...this.#events.slice(0, at), ...this.#events.slice(at).filter((event) => survivors.has(event.seq))];
    }
    // A hole in what this client holds: past the cut there is nothing left to fetch but
    // what `kept` names, and those are few; the hole is trimmed to the part before the cut.
    if (this.#gap !== null) {
      if (this.#gap.after >= from - 1) this.#gap = null;
      else if (this.#gap.before > from) this.#gap = { after: this.#gap.after, before: from };
    }
    this.#logVersion++;
  }

  #adoptEpoch(epoch: number): void {
    // A replayed rewind or reset names a generation the welcome already moved past.
    if (this.#epoch === null || epoch > this.#epoch) this.#epoch = epoch;
  }

  #discardLog(): void {
    this.#events = [];
    this.#gap = null;
    this.#lastSeq = 0;
    this.#drafts = [];
    this.#complete = false;
    this.#logVersion++;
  }

  /** Keep the window to its cap: the oldest events go. */
  #trim(): void {
    const over = this.#events.length - this.#maxEvents;
    if (over <= 0) return;
    this.#events = this.#events.slice(over);
    this.#complete = false;
    const oldest = this.#events[0];
    // Everything before the gap is gone: what is missing is now plain history.
    if (this.#gap !== null && oldest !== undefined && oldest.seq > this.#gap.after) this.#gap = null;
  }

  #hasRecentEvent(id: string): boolean {
    const events = this.#events;
    for (let index = events.length - 1; index >= 0 && index >= events.length - 64; index--) {
      if ((events[index] as EventFrame).id === id) return true;
    }
    return false;
  }

  async #loadOlder(options: RequestOptions): Promise<number> {
    const version = this.#logVersion;
    const gap = this.#gap;
    let before: number;
    if (gap !== null) before = gap.before;
    else {
      if (this.#complete || this.#events.length >= this.#maxEvents) return 0;
      before = this.#events[0]?.seq ?? this.#lastSeq + 1;
    }
    const page = await this.logPage(before, PAGE_LIMIT, options);
    if (!page.ok) {
      this.#lastError = { code: page.error.code, message: page.error.message, fatal: false };
      this.#changed();
      return 0;
    }
    // The log was cut, cleared or replaced while the page was on its way: it is void.
    if (version !== this.#logVersion || this.#gap !== gap) return 0;
    const events = page.data.events;
    const exhausted = events.length < PAGE_LIMIT;
    const oldest = events[0]?.seq;
    const before0 = this.#events.length;
    if (gap !== null) {
      this.#insert(events.filter((event) => event.seq > gap.after && event.seq < gap.before));
      if (exhausted || oldest === undefined || oldest <= gap.after + 1) this.#gap = null;
      else this.#gap = { after: gap.after, before: oldest };
      this.#trim();
    } else {
      const room = this.#maxEvents - this.#events.length;
      const taken = events.filter((event) => event.seq < before).slice(-room);
      this.#insert(taken);
      if (exhausted && taken.length === events.length) this.#complete = true;
    }
    const added = this.#events.length - before0;
    this.#changed();
    return Math.max(0, added);
  }

  // --- views ---------------------------------------------------------------------------

  async #subscribe(names: readonly string[], options: RequestOptions): Promise<Result<{ problems: { name: string; code: string }[] }>> {
    const problems: { name: string; code: string }[] = [];
    for (const chunk of chunks(names, MAX_VIEW_NAMES)) {
      const result = await this.call("view.subscribe", { names: chunk }, options);
      if (!result.ok) return result;
      const list = isRecord(result.data) ? result.data.problems : undefined;
      const map = new Map(this.#viewProblems);
      for (const name of chunk) map.delete(name);
      if (Array.isArray(list)) {
        for (const problem of list) {
          if (isRecord(problem) && typeof problem.name === "string" && isShort(problem.code)) {
            problems.push({ name: problem.name, code: problem.code });
            map.set(problem.name, problem.code);
          }
        }
      }
      this.#viewProblems = map;
      this.#changed();
    }
    return { ok: true, data: { problems } };
  }

  // --- plumbing ------------------------------------------------------------------------

  #request(build: (rid: string) => ClientFrame, options: RequestOptions): Promise<Result> {
    if (this.#status === "ended") return Promise.reject(new SessionError("session_ended", this.#lastError?.message ?? "session_ended", true));
    const current = this.#current;
    if (current === null) return Promise.reject(this.#notConnected());
    const rid = `r${++this.#rid}`;
    return new Promise<Result>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
      const timer =
        timeoutMs === undefined
          ? undefined
          : this.#timers.setTimeout(() => {
              if (this.#pending.delete(rid)) reject(new SessionError("timeout"));
            }, timeoutMs);
      this.#pending.set(rid, { resolve, reject, timer });
      this.#send(current, build(rid));
    });
  }

  #send(current: Current, frame: ClientFrame): void {
    try {
      current.link.send(frame);
    } catch {
      // The transport refused: the link is as good as gone.
      if (current.live) this.#drop("link_closed", "send failed");
    }
  }

  #notConnected(): SessionError {
    return new SessionError("not_connected");
  }

  /** The current link is gone; the session may be resumed over another. */
  #drop(code: string, reason: string): void {
    const current = this.#current;
    if (current !== null) current.live = false;
    this.#current = null;
    if (this.#status === "ended") return;
    this.#status = "offline";
    this.#lastError = { code, message: reason, fatal: false };
    this.#drafts = [];
    this.#turn = null;
    this.#rejectAll(new SessionError(code, reason || code));
    this.#changed();
  }

  #end(failure: SessionFailure): void {
    const current = this.#current;
    if (current !== null) current.live = false;
    this.#current = null;
    this.#status = "ended";
    this.#lastError = failure;
    this.#drafts = [];
    this.#turn = null;
    this.#rejectAll(new SessionError(failure.code, failure.message || failure.code, true));
    this.#changed();
  }

  #rejectAll(error: SessionError): void {
    const pending = [...this.#pending.values()];
    const pings = [...this.#pings.values()];
    this.#pending.clear();
    this.#pings.clear();
    for (const entry of [...pending, ...pings]) {
      if (entry.timer !== undefined) this.#timers.clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  #changed(): void {
    this.#snapshot = null;
    for (const listener of [...this.#listeners]) this.#call(listener);
  }

  /** A listener that throws must not break the session: its error is rethrown on its own. */
  #call(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      const report = this.#options.onListenerError;
      if (report !== undefined) report(error);
      else
        queueMicrotask(() => {
          throw error;
        });
    }
  }
}

function badResult<T>(code = "bad_result"): Result<T> {
  return { ok: false, error: { code, message: code } };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** A built-in view out of a snapshot, typed. */
export function builtInView<K extends BuiltInViewName>(snapshot: SessionSnapshot, name: K): HeldView<BuiltInViews[K]> | null {
  return (snapshot.views.get(name) as HeldView<BuiltInViews[K]> | undefined) ?? null;
}
