// Protocol 3.0 frames. Eleven frame types: an event log, calls, views, and the byte
// channel beside them. This file has no imports on purpose — it is the one definition
// the server and every client share.

export const PROTOCOL_VERSION = "3.0";
export const PROTOCOL_MAJOR = 3;

export type Role = "player" | "admin" | "observer";

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export interface HelloFrame {
  type: "hello";
  protocol: string;
  key: string;
  name?: string;
  /** The client's own language: what a `result` or an `error` addressed to it is written in. */
  locale: string;
  client: { name: string; version: string };
  caps: string[];
  /** The room generation and the last log entry this client holds. */
  resume?: { epoch: number; after: number };
}

/** What the player typed: speech, or a text command. */
export interface InputFrame {
  type: "input";
  rid: string;
  text: string;
}

export interface CallFrame {
  type: "call";
  rid: string;
  method: string;
  params: Record<string, unknown>;
}

export interface PingFrame {
  type: "ping";
  t: number;
}

export type ClientFrame = HelloFrame | InputFrame | CallFrame | PingFrame;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export interface WelcomeFrame {
  type: "welcome";
  protocol: string;
  server: { name: string; version: string };
  room: { id: string; locale: string };
  you: { id: string; name: string; role: Role };
  features: string[];
  /** The room's generation: it moves on undo, reset and import. */
  epoch: number;
  /** The newest log entry's `seq` (0 for an empty log). */
  head: number;
}

export interface NarrativeData {
  speaker: "player" | "kp" | "npc" | "system";
  name?: string;
  member?: string;
  text: string;
  format: "markdown" | "plain";
}

/**
 * An undo: the log lost every event numbered `from` or higher, EXCEPT those in `kept`. An
 * undo removes whole turns, and turns interleave in the log (a line is logged when it is
 * accepted, its reply when the Keeper's turn ends), so what is removed is not always a
 * suffix: `kept` lists the events of surviving turns that landed after the first removed one.
 * It is empty in the common case.
 */
export interface RewindData {
  from: number;
  kept: number[];
  epoch: number;
}

/**
 * A graded check's result, neutral to the rule system: `id` is the system's own rank
 * word (presentation only — never branch on it), `label` is already in the room's
 * language, and a client colours by the flags and may shade by `tier` (higher is better).
 */
export interface Outcome {
  id: string;
  label: string;
  success: boolean;
  critical: boolean;
  fumble: boolean;
  tier: number;
  margin?: number;
}

/** One roll or check, as the table saw it. Never carries Keeper-only information. */
export interface DiceData {
  actor: string;
  kind: "roll" | "check" | "subsystem" | "opposed" | "init";
  /** The notation rolled, canonical form. */
  expr: string;
  rolls: number[];
  total: number;
  target?: number;
  effectiveTarget?: number;
  /** A rule subsystem's stable id and its name in the room's language. */
  subsystem?: string;
  subsystemLabel?: string;
  outcome?: Outcome;
  /** System-declared extras a client may show verbatim and never needs to understand. */
  detail?: Record<string, unknown>;
}

export type Block =
  | { kind: "meter"; label: string; value: number; min: number; max: number }
  | { kind: "stat"; label: string; value: number | string | boolean }
  | { kind: "badge"; label: string; tone?: "info" | "warn" | "danger" }
  | { kind: "text"; text: string; style?: "quote" | "warning" }
  | { kind: "divider" }
  | { kind: "choices"; prompt?: string; options: { id: string; label: string; command: string; args?: Record<string, unknown> }[] }
  | { kind: "image"; hash: string; mime?: string; size?: number; caption?: string; alt?: string }
  | { kind: "letter"; body: string; from?: string; to?: string; date?: string }
  | { kind: "clipping"; headline: string; body: string; source?: string; date?: string }
  | { kind: "map_pin"; hash: string; mime?: string; size?: number; label: string; x: number; y: number; note?: string }
  | { kind: "title_card"; title: string; subtitle?: string; act?: string };

/** Declarative blocks set into the story: a module's card, the Stage Director's staging. */
export interface BlocksData {
  blocks: Block[];
  /** May update the earlier `blocks` event with the same id in place. */
  replace?: boolean;
}

export interface MediaData {
  hash: string;
  mime: string;
  size: number;
  name: string;
  /** The member who shared it, or the server. */
  from: string;
}

export interface ResetData {
  scope: "story" | "chars" | "all";
  epoch: number;
}

export interface EventPayloads {
  narrative: NarrativeData;
  dice: DiceData;
  blocks: BlocksData;
  media: MediaData;
  rewind: RewindData;
  reset: ResetData;
}

export type EventKind = keyof EventPayloads;

/** One entry of the room's log: numbered, stored, delivered to every member in order. */
export type EventFrame = {
  [K in EventKind]: {
    type: "event";
    seq: number;
    id: string;
    ts: number;
    kind: K;
    turn?: number;
    data: EventPayloads[K];
  };
}[EventKind];

export interface SignalPayloads {
  /** Streaming text for the bubble the `narrative` event with the same id replaces. */
  draft: { id: string; text: string } | { id: string; discard: true };
  turn:
    | { status: "busy"; actor: string; activity?: "reading" | "dice" | "cast" | "bookkeeping"; round?: number }
    | { status: "idle" };
  /** A playback intent; the bytes are fetched by hash over the byte channel. */
  audio: {
    id: string;
    action: "play" | "stop" | "pause" | "resume" | "volume";
    layer: "bgm" | "ambience" | "sfx";
    hash?: string;
    mime?: string;
    title?: string;
    loop?: boolean;
    volume?: number;
    fadeMs?: number;
  };
  /** An out-of-band line for the table: a turn that failed, a long operation under way. */
  notice: { level: "info" | "warn"; code?: string; text: string; spinner?: boolean };
}

export type SignalKind = keyof SignalPayloads;

/** Ephemeral: never logged, never replayed. */
export type SignalFrame = {
  [K in SignalKind]: { type: "signal"; kind: K; data: SignalPayloads[K] };
}[SignalKind];

export interface ViewFrame {
  type: "view";
  name: string;
  rev: number;
  /** The log position this value reflects. */
  at: number;
  data: unknown;
}

export interface ErrorBody {
  code: string;
  message: string;
}

/** The one answer to an `input` or a `call`, to the caller alone. */
export type ResultFrame =
  | { type: "result"; rid: string; ok: true; data?: unknown; text?: string }
  | { type: "result"; rid: string; ok: false; error: ErrorBody };

/** Connection-level only: there is no `rid` to answer. */
export interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
  fatal: boolean;
}

export interface PongFrame {
  type: "pong";
  t: number;
}

export type ServerFrame =
  | WelcomeFrame
  | EventFrame
  | SignalFrame
  | ViewFrame
  | ResultFrame
  | ErrorFrame
  | PongFrame;

// ---------------------------------------------------------------------------
// Inbound validation (server side of the wire)
// ---------------------------------------------------------------------------

export const MAX_INPUT_CHARS = 8000;
/**
 * The limits of a reconnect and of history paging. They are the PROTOCOL's, not one side's:
 * a client works out whether its log has a hole from them (the server replays the events
 * after `resume.after`, but never more than the newest `RESUME_LIMIT`).
 */
export const RESUME_LIMIT = 200;
/** Events in one `log.page`; asking for more is refused. */
export const PAGE_LIMIT = 100;
/** View names in one `view.subscribe` / `view.unsubscribe`. */
export const MAX_VIEW_NAMES = 64;
const MAX_ID_CHARS = 64;

export type Decoded<T> = { ok: true; frame: T } | { ok: false; code: string; rid?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

/** Number of code points, not UTF-16 units: a cap counts characters. */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The major of a `major.minor` version string, or null when it cannot be read. */
export function protocolMajor(version: string): number | null {
  const match = /^(\d+)\.\d+$/.exec(version);
  return match ? Number(match[1]) : null;
}

/** Validate one parsed JSON value as a client frame. Unknown fields are ignored. */
export function decodeClientFrame(raw: unknown): Decoded<ClientFrame> {
  if (!isRecord(raw) || typeof raw.type !== "string") return { ok: false, code: "bad_frame" };
  const rid = isId(raw.rid) ? raw.rid : undefined;
  switch (raw.type) {
    case "hello": {
      const client = raw.client;
      const resume = raw.resume;
      if (
        typeof raw.protocol !== "string" ||
        typeof raw.key !== "string" ||
        typeof raw.locale !== "string" ||
        !isRecord(client) ||
        typeof client.name !== "string" ||
        typeof client.version !== "string" ||
        !Array.isArray(raw.caps) ||
        !raw.caps.every((cap) => typeof cap === "string") ||
        (raw.name !== undefined && typeof raw.name !== "string") ||
        (resume !== undefined &&
          !(isRecord(resume) && Number.isSafeInteger(resume.epoch) && Number.isSafeInteger(resume.after)))
      ) {
        return { ok: false, code: "bad_frame" };
      }
      const frame: HelloFrame = {
        type: "hello",
        protocol: raw.protocol,
        key: raw.key,
        locale: raw.locale,
        client: { name: client.name, version: client.version },
        caps: raw.caps as string[],
      };
      if (typeof raw.name === "string") frame.name = raw.name;
      if (isRecord(resume)) frame.resume = { epoch: resume.epoch as number, after: resume.after as number };
      return { ok: true, frame };
    }
    case "input": {
      if (rid === undefined || typeof raw.text !== "string") return { ok: false, code: "bad_frame" };
      if (charCount(raw.text) > MAX_INPUT_CHARS) return { ok: false, code: "input_too_long", rid };
      return { ok: true, frame: { type: "input", rid, text: raw.text } };
    }
    case "call": {
      if (rid === undefined || typeof raw.method !== "string") return { ok: false, code: "bad_frame" };
      const params = raw.params === undefined ? {} : raw.params;
      if (!isRecord(params)) return { ok: false, code: "invalid_params", rid };
      return { ok: true, frame: { type: "call", rid, method: raw.method, params } };
    }
    case "ping": {
      if (typeof raw.t !== "number" || !Number.isFinite(raw.t)) return { ok: false, code: "bad_frame" };
      return { ok: true, frame: { type: "ping", t: raw.t } };
    }
    default:
      return { ok: false, code: "bad_frame" };
  }
}

// The built-in views' types and schemas, on the same entry (`loreweaver-protocol/v3`).
export * from "./views.js";
