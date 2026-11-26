// The game clock, and who owns it.
//
// `game_clock` (one per room): `{ now, events: [{ at, what }] }`. `now` is the clock's
// text ("" while unset); `events` are what the Keeper scheduled to happen ("the ship
// docks" at "D4 06:00"), in the order scheduled.
//   - keeper: the time and every scheduled event;
//   - everyone else (admin, player, observer, NPC actors): the time only. A scheduled
//     event is a plan the table has not met yet — knowing the ship docks at dawn is
//     knowing the plot.
//
// `clock_owner` (one per room): `{ owner: { kind: "keeper" } | { kind: "module", id } }`.
// A room's clock has exactly one owner. A module that keeps its own time (a calendar its
// hooks advance) takes the clock; while it holds it the Keeper's clock tool is not
// offered (`keeperMayAdvance`), so two hands never move one clock. No document means the
// Keeper owns it.
//   - every viewer: the owner.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { cleanOptionalText, cleanText, isRecord, onlyKeys } from "./text.ts";
import { advanceTime } from "./time.ts";

export const GAME_CLOCK_TYPE = "game_clock";
export const GAME_CLOCK_ID = "clock";
export const CLOCK_OWNER_TYPE = "clock_owner";
export const CLOCK_OWNER_ID = "owner";

/** The clock's text, and an event's time, in code points. */
export const MAX_CLOCK_TEXT_CHARS = 80;
export const MAX_SCHEDULED_EVENTS = 32;
/** One scheduled event's description, in code points. */
export const MAX_EVENT_CHARS = 280;
/** A module id. */
export const MAX_MODULE_ID_CHARS = 128;

// ---------------------------------------------------------------------------
// game_clock
// ---------------------------------------------------------------------------

export type ScheduledEvent = { readonly at: string; readonly what: string };
export type GameClock = { readonly now: string; readonly events: readonly ScheduledEvent[] };

export const UNSET_CLOCK: GameClock = Object.freeze({ now: "", events: Object.freeze([]) });

export type ClockRefusal =
  | "bad_time"
  | "bad_event"
  | "events_full"
  | "unknown_event"
  /** The clock is unset: there is nothing to advance from. */
  | "unset"
  | "bad_delta"
  | "before_start"
  | "out_of_range";

export type ClockChange = { readonly ok: true; readonly data: GameClock } | { readonly ok: false; readonly code: ClockRefusal };

/** What one advance did, for the room's `clock_advanced` hooks (which consume the delta, not the text). */
export interface ClockAdvance {
  readonly from: string;
  readonly to: string;
  readonly minutes: number;
  /** False when the clock's text is a family the engine cannot move: it is kept as written. */
  readonly moved: boolean;
}

export type ClockAdvanceResult =
  | { readonly ok: true; readonly data: GameClock; readonly advance: ClockAdvance }
  | { readonly ok: false; readonly code: ClockRefusal };

/** Set the clock to `text` (any text the table keeps time in). */
export function setTime(clock: GameClock, text: string): ClockChange {
  const now = cleanText(text, MAX_CLOCK_TEXT_CHARS);
  if (now === null) return { ok: false, code: "bad_time" };
  return { ok: true, data: Object.freeze({ ...clock, now }) };
}

/**
 * Move the clock by `delta` (see `time.ts`). On a clock text the engine cannot read the
 * text stays as written — the advance still happened (`moved: false`), and a module's
 * calendar hooks still count it.
 */
export function advanceClock(clock: GameClock, delta: string): ClockAdvanceResult {
  if (clock.now === "") return { ok: false, code: "unset" };
  const result = advanceTime(clock.now, delta);
  if (!result.ok) return { ok: false, code: result.code };
  if (cleanText(result.now, MAX_CLOCK_TEXT_CHARS) !== result.now) return { ok: false, code: "out_of_range" };
  return {
    ok: true,
    data: Object.freeze({ ...clock, now: result.now }),
    advance: { from: clock.now, to: result.now, minutes: result.minutes, moved: result.moved },
  };
}

/** Schedule `what` to happen at `at`; the same event scheduled twice is kept once. */
export function scheduleEvent(clock: GameClock, at: string, what: string): ClockChange {
  const when = cleanText(at, MAX_CLOCK_TEXT_CHARS);
  if (when === null) return { ok: false, code: "bad_time" };
  const description = cleanText(what, MAX_EVENT_CHARS);
  if (description === null) return { ok: false, code: "bad_event" };
  if (clock.events.some((event) => event.at === when && event.what === description)) return { ok: true, data: clock };
  if (clock.events.length >= MAX_SCHEDULED_EVENTS) return { ok: false, code: "events_full" };
  return { ok: true, data: Object.freeze({ ...clock, events: Object.freeze([...clock.events, Object.freeze({ at: when, what: description })]) }) };
}

/** Drop the scheduled event at `index` (it happened, or will not). */
export function cancelEvent(clock: GameClock, index: number): ClockChange {
  if (!Number.isSafeInteger(index) || index < 0 || index >= clock.events.length) return { ok: false, code: "unknown_event" };
  return { ok: true, data: Object.freeze({ ...clock, events: Object.freeze(clock.events.filter((_, at) => at !== index)) }) };
}

export function gameClockData(clock: GameClock): JsonObject {
  return { now: clock.now, events: clock.events.map((event) => ({ at: event.at, what: event.what })) };
}

/** A stored clock read back; null when malformed. */
export function readGameClock(data: JsonObject): GameClock | null {
  if (typeof data.now !== "string" || !Array.isArray(data.events)) return null;
  const events: ScheduledEvent[] = [];
  for (const item of data.events) {
    if (!isRecord(item) || typeof item.at !== "string" || typeof item.what !== "string") return null;
    events.push(Object.freeze({ at: item.at, what: item.what }));
  }
  return Object.freeze({ now: data.now, events: Object.freeze(events) });
}

export interface GameClockTableView {
  readonly now: string;
}

export interface GameClockKeeperView extends GameClockTableView {
  readonly events: readonly ScheduledEvent[];
}

export type GameClockView = GameClockTableView | GameClockKeeperView;

function projectGameClock(document: Document, viewer: Viewer): GameClockView | null {
  const clock = readGameClock(document.data);
  if (clock === null) return null;
  if (viewer.grade !== "keeper") return { now: clock.now };
  return { now: clock.now, events: clock.events.map((event) => ({ at: event.at, what: event.what })) };
}

function validateGameClock(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["now", "events"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  const violations: WriteViolation[] = [];
  if (typeof data.now !== "string" || cleanOptionalText(data.now, MAX_CLOCK_TEXT_CHARS) !== data.now) violations.push({ code: "bad_time", path: "now" });
  if (!Array.isArray(data.events)) {
    violations.push({ code: "bad_events", path: "events" });
    return violations;
  }
  if (data.events.length > MAX_SCHEDULED_EVENTS) violations.push({ code: "events_full", path: "events" });
  data.events.forEach((item, index) => {
    const path = `events.${index}`;
    if (!isRecord(item) || onlyKeys(item, ["at", "what"]) !== null) {
      violations.push({ code: "bad_event", path });
      return;
    }
    if (typeof item.at !== "string" || cleanText(item.at, MAX_CLOCK_TEXT_CHARS) !== item.at) violations.push({ code: "bad_time", path: `${path}.at` });
    if (typeof item.what !== "string" || cleanText(item.what, MAX_EVENT_CHARS) !== item.what) violations.push({ code: "bad_event", path: `${path}.what` });
  });
  return violations;
}

export const gameClockDocument: DocumentType<GameClockView> = {
  name: GAME_CLOCK_TYPE,
  lifecycle: { reset: "story" },
  version: 1,
  project: projectGameClock,
  validate: validateGameClock,
};

// ---------------------------------------------------------------------------
// clock_owner
// ---------------------------------------------------------------------------

export type ClockOwner = { readonly kind: "keeper" } | { readonly kind: "module"; readonly id: string };
export type ClockOwnership = { readonly owner: ClockOwner };

/** The default: the Keeper keeps time. */
export const KEEPER_OWNS_CLOCK: ClockOwnership = Object.freeze({ owner: Object.freeze({ kind: "keeper" as const }) });

export type OwnershipRefusal = "bad_module" | "owned_by_other" | "not_owner";

export type OwnershipChange = { readonly ok: true; readonly data: ClockOwnership } | { readonly ok: false; readonly code: OwnershipRefusal };

/** Whether the Keeper may move the clock — and so whether its clock tool is offered. */
export function keeperMayAdvance(ownership: ClockOwnership): boolean {
  return ownership.owner.kind === "keeper";
}

/** Whether `actor` is the clock's owner. */
export function mayChangeClock(ownership: ClockOwnership, actor: ClockOwner): boolean {
  const owner = ownership.owner;
  return owner.kind === "keeper" ? actor.kind === "keeper" : actor.kind === "module" && actor.id === owner.id;
}

/**
 * Module `moduleId` takes the clock. Refused while another module holds it: one clock,
 * one owner, and the second module must not silently take over the first one's calendar.
 */
export function moduleTakesClock(ownership: ClockOwnership, moduleId: string): OwnershipChange {
  if (cleanText(moduleId, MAX_MODULE_ID_CHARS) !== moduleId) return { ok: false, code: "bad_module" };
  const owner = ownership.owner;
  if (owner.kind === "module" && owner.id !== moduleId) return { ok: false, code: "owned_by_other" };
  return { ok: true, data: Object.freeze({ owner: Object.freeze({ kind: "module" as const, id: moduleId }) }) };
}

/** Module `moduleId` hands the clock back to the Keeper. */
export function moduleReleasesClock(ownership: ClockOwnership, moduleId: string): OwnershipChange {
  const owner = ownership.owner;
  if (owner.kind !== "module" || owner.id !== moduleId) return { ok: false, code: "not_owner" };
  return { ok: true, data: KEEPER_OWNS_CLOCK };
}

export function clockOwnershipData(ownership: ClockOwnership): JsonObject {
  const owner = ownership.owner;
  return { owner: owner.kind === "keeper" ? { kind: "keeper" } : { kind: "module", id: owner.id } };
}

/** A stored ownership read back; null when malformed. */
export function readClockOwnership(data: JsonObject): ClockOwnership | null {
  const owner = data.owner;
  if (!isRecord(owner)) return null;
  if (owner.kind === "keeper") return KEEPER_OWNS_CLOCK;
  if (owner.kind === "module" && typeof owner.id === "string") return Object.freeze({ owner: Object.freeze({ kind: "module" as const, id: owner.id }) });
  return null;
}

export type ClockOwnerView = ClockOwnership;

function projectClockOwner(document: Document, _viewer: Viewer): ClockOwnerView | null {
  const ownership = readClockOwnership(document.data);
  if (ownership === null) return null;
  const owner = ownership.owner;
  return { owner: owner.kind === "keeper" ? { kind: "keeper" } : { kind: "module", id: owner.id } };
}

function validateClockOwner(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["owner"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  const owner = data.owner;
  if (!isRecord(owner)) return [{ code: "bad_owner", path: "owner" }];
  if (owner.kind === "keeper") return onlyKeys(owner, ["kind"]) === null ? [] : [{ code: "bad_owner", path: "owner" }];
  if (owner.kind !== "module" || onlyKeys(owner, ["kind", "id"]) !== null) return [{ code: "bad_owner", path: "owner" }];
  return typeof owner.id === "string" && cleanText(owner.id, MAX_MODULE_ID_CHARS) === owner.id ? [] : [{ code: "bad_module", path: "owner.id" }];
}

export const clockOwnerDocument: DocumentType<ClockOwnerView> = {
  name: CLOCK_OWNER_TYPE,
  // The owning module is part of the installed world: a story reset replays the same
  // module, which must still be the one keeping time. Only removing the world (or the
  // module releasing it) hands the clock back to the Keeper.
  lifecycle: { reset: "all" },
  version: 1,
  project: projectClockOwner,
  validate: validateClockOwner,
};
