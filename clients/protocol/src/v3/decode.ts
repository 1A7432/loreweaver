// Decoding what a server sends: structural validation of every 3.0 server frame, every
// event kind's and every signal kind's payload, so nothing malformed reaches a UI.
//
// Forward compatibility (§8.1): an unknown frame type, event kind or signal kind is
// "unknown, ignore" — never an error, never a crash — and unknown FIELDS are dropped (each
// decoded frame is rebuilt from the fields this version knows). A field that gates
// rendering (a speaker, a role, a dice kind) fails closed: a value this version does not
// know makes the frame malformed rather than shown wrongly. Opaque values the protocol
// declares as such (`view.data`, `result.data`, a dice `detail`) pass through as they came.
//
// Every string and list is capped by a named constant; over a cap is malformed, never
// truncated silently.
import {
  charCount,
  type Block,
  type BlocksData,
  type DiceData,
  type ErrorFrame,
  type EventFrame,
  type MediaData,
  type NarrativeData,
  type Outcome,
  type PongFrame,
  type ResetData,
  type ResultFrame,
  type RewindData,
  type Role,
  type ServerFrame,
  type SignalFrame,
  type SignalPayloads,
  type ViewFrame,
  type WelcomeFrame,
} from "./frames.js";

/** An id, a code, a name, a view name, a locale, a hash, a version — any short string. */
export const MAX_SHORT_CHARS = 256;
/** A longer text: a narrative, a draft slice, a notice, a result's text, an error message, a block's body. */
export const MAX_TEXT_CHARS = 200_000;
/** A dice expression, canonical form. */
export const MAX_EXPR_CHARS = 1024;
/** Dice in one roll. */
export const MAX_DICE_ROLLS = 10_000;
/** Blocks in one `blocks` event. */
export const MAX_BLOCKS = 256;
/** Options in one `choices` block. */
export const MAX_CHOICES = 64;
/** Entries in a short list of strings: `features`, `caps`, a dice expression's parts. */
export const MAX_SHORT_LIST = 256;
/** Events in one `log.page` answer the client accepts. */
export const MAX_PAGE_EVENTS = 1000;
/** Surviving events an undo may name past its cut: bounded by the turns an undo can reach. */
export const MAX_REWIND_KEPT = 4096;

/** What decoding one value found. */
export type ServerDecode =
  | { readonly kind: "frame"; readonly frame: ServerFrame }
  /**
   * A type, event kind or signal kind this version does not know: ignore it. `seq` is set
   * for an event of an unknown kind whose envelope is sound — it still occupies a place in
   * the room's log.
   */
  | { readonly kind: "unknown"; readonly type: string; readonly sub?: string; readonly seq?: number }
  | { readonly kind: "malformed"; readonly reason: string };

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number, nonEmpty = false): value is string {
  if (typeof value !== "string") return false;
  if (nonEmpty && value.length === 0) return false;
  // A UTF-16 length under the cap is a code-point count under it too: skip the walk.
  return value.length <= max || charCount(value) <= max;
}

function shortStr(value: unknown, nonEmpty = false): value is string {
  return str(value, MAX_SHORT_CHARS, nonEmpty);
}

function textStr(value: unknown): value is string {
  return str(value, MAX_TEXT_CHARS);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function int(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function shortList(value: unknown, max = MAX_SHORT_LIST): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => shortStr(item));
}

/** Copy `raw[name]` onto `out` when present and valid; false when present and invalid. */
function optional<T>(raw: Raw, out: Record<string, unknown>, name: string, valid: (value: unknown) => value is T): boolean {
  const value = raw[name];
  if (value === undefined) return true;
  if (!valid(value)) return false;
  out[name] = value;
  return true;
}

const ROLES: readonly Role[] = ["player", "admin", "observer"];
const SPEAKERS: readonly NarrativeData["speaker"][] = ["player", "kp", "npc", "system"];
const FORMATS: readonly NarrativeData["format"][] = ["markdown", "plain"];
const DICE_KINDS: readonly DiceData["kind"][] = ["roll", "check", "subsystem", "opposed", "init"];
const RESET_SCOPES: readonly ResetData["scope"][] = ["story", "chars", "all"];
const ACTIVITIES = ["reading", "dice", "cast", "bookkeeping"] as const;
const AUDIO_ACTIONS: readonly SignalPayloads["audio"]["action"][] = ["play", "stop", "pause", "resume", "volume"];
const AUDIO_LAYERS: readonly SignalPayloads["audio"]["layer"][] = ["bgm", "ambience", "sfx"];

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

function narrative(raw: Raw): NarrativeData | null {
  if (!oneOf(raw.speaker, SPEAKERS) || !textStr(raw.text) || !oneOf(raw.format, FORMATS)) return null;
  const out: NarrativeData = { speaker: raw.speaker, text: raw.text, format: raw.format };
  const extra = out as unknown as Record<string, unknown>;
  if (!optional(raw, extra, "name", shortStr) || !optional(raw, extra, "member", shortStr)) return null;
  return out;
}

function outcome(raw: unknown): Outcome | null {
  if (!isRecord(raw)) return null;
  if (!shortStr(raw.id) || !shortStr(raw.label) || typeof raw.success !== "boolean" || typeof raw.critical !== "boolean" || typeof raw.fumble !== "boolean" || !finite(raw.tier)) return null;
  const out: Outcome = { id: raw.id, label: raw.label, success: raw.success, critical: raw.critical, fumble: raw.fumble, tier: raw.tier };
  if (!optional(raw, out as unknown as Record<string, unknown>, "margin", finite)) return null;
  return out;
}

function dice(raw: Raw): DiceData | null {
  if (!shortStr(raw.actor) || !oneOf(raw.kind, DICE_KINDS) || !str(raw.expr, MAX_EXPR_CHARS) || !finite(raw.total)) return null;
  const rolls = raw.rolls;
  if (!Array.isArray(rolls) || rolls.length > MAX_DICE_ROLLS || !rolls.every(finite)) return null;
  const out: DiceData = { actor: raw.actor, kind: raw.kind, expr: raw.expr, rolls: [...rolls], total: raw.total };
  const extra = out as unknown as Record<string, unknown>;
  if (
    !optional(raw, extra, "target", finite) ||
    !optional(raw, extra, "effectiveTarget", finite) ||
    !optional(raw, extra, "subsystem", shortStr) ||
    !optional(raw, extra, "subsystemLabel", shortStr) ||
    !optional(raw, extra, "detail", isRecord)
  ) {
    return null;
  }
  if (raw.outcome !== undefined) {
    const decoded = outcome(raw.outcome);
    if (decoded === null) return null;
    out.outcome = decoded;
  }
  return out;
}

/** One block; null when malformed. An unknown block kind is `undefined`: skipped, not fatal. */
function block(raw: unknown): Block | null | undefined {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  const out: Record<string, unknown> = { kind: raw.kind };
  const need = (name: string, valid: (value: unknown) => boolean): boolean => {
    if (!valid(raw[name])) return false;
    out[name] = raw[name];
    return true;
  };
  const media = (): boolean => need("hash", (v) => shortStr(v, true)) && optional(raw, out, "mime", shortStr) && optional(raw, out, "size", count);
  let ok: boolean;
  switch (raw.kind) {
    case "meter":
      ok = need("label", shortStr) && need("value", finite) && need("min", finite) && need("max", finite);
      break;
    case "stat":
      ok = need("label", shortStr) && need("value", (v) => finite(v) || typeof v === "boolean" || textStr(v));
      break;
    case "badge":
      ok = need("label", shortStr) && optional(raw, out, "tone", (v): v is string => oneOf(v, ["info", "warn", "danger"]));
      break;
    case "text":
      ok = need("text", textStr) && optional(raw, out, "style", (v): v is string => oneOf(v, ["quote", "warning"]));
      break;
    case "divider":
      ok = true;
      break;
    case "choices": {
      ok = optional(raw, out, "prompt", textStr);
      const options = raw.options;
      if (!ok || !Array.isArray(options) || options.length > MAX_CHOICES) return null;
      const decoded: unknown[] = [];
      for (const option of options) {
        if (!isRecord(option) || !shortStr(option.id) || !shortStr(option.label) || !shortStr(option.command, true)) return null;
        const entry: Record<string, unknown> = { id: option.id, label: option.label, command: option.command };
        if (!optional(option, entry, "args", isRecord)) return null;
        decoded.push(entry);
      }
      out.options = decoded;
      break;
    }
    case "image":
      ok = media() && optional(raw, out, "caption", textStr) && optional(raw, out, "alt", textStr);
      break;
    case "letter":
      ok = need("body", textStr) && optional(raw, out, "from", shortStr) && optional(raw, out, "to", shortStr) && optional(raw, out, "date", shortStr);
      break;
    case "clipping":
      ok = need("headline", textStr) && need("body", textStr) && optional(raw, out, "source", shortStr) && optional(raw, out, "date", shortStr);
      break;
    case "map_pin":
      ok = media() && need("label", shortStr) && need("x", finite) && need("y", finite) && optional(raw, out, "note", textStr);
      break;
    case "title_card":
      ok = need("title", textStr) && optional(raw, out, "subtitle", textStr) && optional(raw, out, "act", shortStr);
      break;
    default:
      return undefined;
  }
  return ok ? (out as unknown as Block) : null;
}

function blocks(raw: Raw): BlocksData | null {
  const list = raw.blocks;
  if (!Array.isArray(list) || list.length > MAX_BLOCKS) return null;
  const out: Block[] = [];
  for (const item of list) {
    const decoded = block(item);
    if (decoded === null) return null;
    if (decoded !== undefined) out.push(decoded);
  }
  const data: BlocksData = { blocks: out };
  if (raw.replace !== undefined) {
    if (typeof raw.replace !== "boolean") return null;
    data.replace = raw.replace;
  }
  return data;
}

function media(raw: Raw): MediaData | null {
  if (!shortStr(raw.hash, true) || !shortStr(raw.mime) || !count(raw.size) || !shortStr(raw.name) || !shortStr(raw.from)) return null;
  return { hash: raw.hash, mime: raw.mime, size: raw.size, name: raw.name, from: raw.from };
}

function rewind(raw: Raw): RewindData | null {
  if (!count(raw.from) || !int(raw.epoch) || !Array.isArray(raw.kept) || raw.kept.length > MAX_REWIND_KEPT) return null;
  const kept: number[] = [];
  for (const seq of raw.kept) {
    if (!count(seq)) return null;
    kept.push(seq);
  }
  return { from: raw.from, kept, epoch: raw.epoch };
}

function reset(raw: Raw): ResetData | null {
  return oneOf(raw.scope, RESET_SCOPES) && int(raw.epoch) ? { scope: raw.scope, epoch: raw.epoch } : null;
}

const EVENT_DECODERS: ReadonlyMap<string, (raw: Raw) => unknown> = new Map<string, (raw: Raw) => unknown>([
  ["narrative", narrative],
  ["dice", dice],
  ["blocks", blocks],
  ["media", media],
  ["rewind", rewind],
  ["reset", reset],
]);

function event(raw: Raw): ServerDecode {
  if (!count(raw.seq) || (raw.seq as number) < 1 || !shortStr(raw.id) || !finite(raw.ts) || !shortStr(raw.kind, true)) return { kind: "malformed", reason: "event" };
  if (raw.turn !== undefined && !count(raw.turn)) return { kind: "malformed", reason: "event.turn" };
  const decode = EVENT_DECODERS.get(raw.kind);
  if (decode === undefined) return { kind: "unknown", type: "event", sub: raw.kind, seq: raw.seq as number };
  if (!isRecord(raw.data)) return { kind: "malformed", reason: `event.${raw.kind}` };
  const data = decode(raw.data);
  if (data === null) return { kind: "malformed", reason: `event.${raw.kind}` };
  const frame: Record<string, unknown> = { type: "event", seq: raw.seq, id: raw.id, ts: raw.ts, kind: raw.kind, data };
  if (raw.turn !== undefined) frame.turn = raw.turn;
  return { kind: "frame", frame: frame as EventFrame };
}

// ---------------------------------------------------------------------------
// Signal payloads
// ---------------------------------------------------------------------------

function draft(raw: Raw): SignalPayloads["draft"] | null {
  if (!shortStr(raw.id, true)) return null;
  if (raw.discard === true) return { id: raw.id, discard: true };
  return textStr(raw.text) ? { id: raw.id, text: raw.text } : null;
}

function turn(raw: Raw): SignalPayloads["turn"] | null {
  if (raw.status === "idle") return { status: "idle" };
  if (raw.status !== "busy" || !shortStr(raw.actor)) return null;
  const out: { status: "busy"; actor: string; activity?: (typeof ACTIVITIES)[number]; round?: number } = { status: "busy", actor: raw.actor };
  // An activity this version does not know is presentation only: left out, not refused.
  if (oneOf(raw.activity, ACTIVITIES)) out.activity = raw.activity;
  if (raw.round !== undefined) {
    if (!count(raw.round)) return null;
    out.round = raw.round;
  }
  return out;
}

function audio(raw: Raw): SignalPayloads["audio"] | null {
  if (!shortStr(raw.id, true) || !oneOf(raw.action, AUDIO_ACTIONS) || !oneOf(raw.layer, AUDIO_LAYERS)) return null;
  const out: SignalPayloads["audio"] = { id: raw.id, action: raw.action, layer: raw.layer };
  const extra = out as unknown as Record<string, unknown>;
  const flag = (value: unknown): value is boolean => typeof value === "boolean";
  if (
    !optional(raw, extra, "sound", shortStr) ||
    !optional(raw, extra, "hash", shortStr) ||
    !optional(raw, extra, "mime", shortStr) ||
    !optional(raw, extra, "size", count) ||
    !optional(raw, extra, "title", shortStr) ||
    !optional(raw, extra, "loop", flag) ||
    !optional(raw, extra, "volume", finite) ||
    !optional(raw, extra, "fadeMs", finite)
  ) {
    return null;
  }
  return out;
}

function notice(raw: Raw): SignalPayloads["notice"] | null {
  if (!oneOf(raw.level, ["info", "warn"] as const) || !textStr(raw.text)) return null;
  const out: SignalPayloads["notice"] = { level: raw.level, text: raw.text };
  const extra = out as unknown as Record<string, unknown>;
  if (!optional(raw, extra, "code", shortStr) || !optional(raw, extra, "spinner", (v): v is boolean => typeof v === "boolean")) return null;
  return out;
}

const SIGNAL_DECODERS: ReadonlyMap<string, (raw: Raw) => unknown> = new Map<string, (raw: Raw) => unknown>([
  ["draft", draft],
  ["turn", turn],
  ["audio", audio],
  ["notice", notice],
]);

function signal(raw: Raw): ServerDecode {
  if (!shortStr(raw.kind, true)) return { kind: "malformed", reason: "signal" };
  const decode = SIGNAL_DECODERS.get(raw.kind);
  if (decode === undefined) return { kind: "unknown", type: "signal", sub: raw.kind };
  const data = isRecord(raw.data) ? decode(raw.data) : null;
  if (data === null) return { kind: "malformed", reason: `signal.${raw.kind}` };
  return { kind: "frame", frame: { type: "signal", kind: raw.kind, data } as SignalFrame };
}

// ---------------------------------------------------------------------------
// The other frames
// ---------------------------------------------------------------------------

function welcome(raw: Raw): WelcomeFrame | null {
  const { server, room, you } = raw;
  if (
    !shortStr(raw.protocol) ||
    !isRecord(server) ||
    !shortStr(server.name) ||
    !shortStr(server.version) ||
    !isRecord(room) ||
    !shortStr(room.id) ||
    !shortStr(room.locale) ||
    !isRecord(you) ||
    !shortStr(you.id) ||
    !shortStr(you.name) ||
    !oneOf(you.role, ROLES) ||
    !shortList(raw.features) ||
    !int(raw.epoch) ||
    !count(raw.head) ||
    !count(raw.first)
  ) {
    return null;
  }
  return {
    type: "welcome",
    protocol: raw.protocol,
    server: { name: server.name, version: server.version },
    room: { id: room.id, locale: room.locale },
    you: { id: you.id, name: you.name, role: you.role },
    features: [...raw.features],
    epoch: raw.epoch,
    head: raw.head,
    first: raw.first,
  };
}

function view(raw: Raw): ViewFrame | null {
  if (!shortStr(raw.name, true) || !count(raw.rev) || !count(raw.at) || !("data" in raw) || raw.data === undefined) return null;
  return { type: "view", name: raw.name, rev: raw.rev, at: raw.at, data: raw.data };
}

function result(raw: Raw): ResultFrame | null {
  if (!shortStr(raw.rid, true) || typeof raw.ok !== "boolean") return null;
  if (raw.ok) {
    const out: { type: "result"; rid: string; ok: true; data?: unknown; text?: string } = { type: "result", rid: raw.rid, ok: true };
    if (raw.data !== undefined) out.data = raw.data;
    if (raw.text !== undefined) {
      if (!textStr(raw.text)) return null;
      out.text = raw.text;
    }
    return out;
  }
  const error = raw.error;
  if (!isRecord(error) || !shortStr(error.code, true) || !textStr(error.message)) return null;
  return { type: "result", rid: raw.rid, ok: false, error: { code: error.code, message: error.message } };
}

function error(raw: Raw): ErrorFrame | null {
  if (!shortStr(raw.code, true) || !textStr(raw.message) || typeof raw.fatal !== "boolean") return null;
  return { type: "error", code: raw.code, message: raw.message, fatal: raw.fatal };
}

function pong(raw: Raw): PongFrame | null {
  return finite(raw.t) ? { type: "pong", t: raw.t } : null;
}

const FRAME_DECODERS: ReadonlyMap<string, (raw: Raw) => ServerFrame | null> = new Map<string, (raw: Raw) => ServerFrame | null>([
  ["welcome", welcome],
  ["view", view],
  ["result", result],
  ["error", error],
  ["pong", pong],
]);

/** Decode one parsed JSON value, telling a frame, an unknown kind and a malformed value apart. */
export function inspectServerFrame(value: unknown): ServerDecode {
  if (!isRecord(value) || !shortStr(value.type, true)) return { kind: "malformed", reason: "frame" };
  if (value.type === "event") return event(value);
  if (value.type === "signal") return signal(value);
  const decode = FRAME_DECODERS.get(value.type);
  if (decode === undefined) return { kind: "unknown", type: value.type };
  const frame = decode(value);
  return frame === null ? { kind: "malformed", reason: value.type } : { kind: "frame", frame };
}

/**
 * The counterpart of `decodeClientFrame`: one parsed JSON value as a server frame, or null
 * when it is to be dropped — malformed, or of a type or kind this version does not know.
 * `inspectServerFrame` tells those two apart.
 */
export function decodeServerFrame(value: unknown): ServerFrame | null {
  const decoded = inspectServerFrame(value);
  return decoded.kind === "frame" ? decoded.frame : null;
}

/** An event frame alone (a `log.page` entry): null when it is anything else or malformed. */
export function decodeEventFrame(value: unknown): EventFrame | null {
  const decoded = isRecord(value) && value.type === "event" ? event(value) : null;
  return decoded !== null && decoded.kind === "frame" ? (decoded.frame as EventFrame) : null;
}
