// The worldbook's per-room activation timers as one `lore_timers` document: which entries
// are inside a sticky or cooldown window, and the last turn counted. The state itself is
// the worldbook's `TimerState`; `activate` reads and returns it, this module stores it.
//
// Keeper-only: a timer names an entry id and when it last fired, which for a secret entry
// is a trace of keeper-side lore. Nobody else needs it — the effect of a timer is visible
// only through the lore the Keeper is given.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { MAX_ACTIVATION_ENTRIES } from "../worldbook/activation.ts";
import { EMPTY_TIMERS, type EntryTimer, type TimerState } from "../worldbook/types.ts";

export const LORE_TIMERS_TYPE = "lore_timers";
export const LORE_TIMERS_ID = "timers";
/** One timer per entry at most, and a room holds at most this many entries. */
export const MAX_TIMERS = MAX_ACTIVATION_ENTRIES;
export const MAX_TIMER_ID_CHARS = 200;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function turnNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The payload for a timer state. */
export function timerStateData(state: TimerState): JsonObject {
  return {
    turn: state.turn,
    entries: state.entries.map((timer) => ({
      id: timer.id,
      openedAt: timer.openedAt,
      ...(timer.stickyUntil !== undefined ? { stickyUntil: timer.stickyUntil } : {}),
      ...(timer.cooldownUntil !== undefined ? { cooldownUntil: timer.cooldownUntil } : {}),
    })),
  };
}

export function validateTimerState(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (key !== "turn" && key !== "entries") violations.push({ code: "unknown_field", path: key });
  if (!turnNumber(data.turn)) violations.push({ code: "bad_field", path: "turn" });
  const entries = data.entries;
  if (!Array.isArray(entries)) {
    violations.push({ code: "bad_field", path: "entries" });
    return violations;
  }
  if (entries.length > MAX_TIMERS) violations.push({ code: "too_many", path: "entries" });
  const seen = new Set<string>();
  entries.forEach((raw, index) => {
    const at = `entries.${index}`;
    if (!isRecord(raw)) {
      violations.push({ code: "bad_field", path: at });
      return;
    }
    for (const key of Object.keys(raw)) if (!["id", "openedAt", "stickyUntil", "cooldownUntil"].includes(key)) violations.push({ code: "unknown_field", path: `${at}.${key}` });
    if (typeof raw.id !== "string" || raw.id === "" || raw.id.length > MAX_TIMER_ID_CHARS) violations.push({ code: "bad_field", path: `${at}.id` });
    else if (seen.has(raw.id)) violations.push({ code: "duplicate", path: `${at}.id` });
    else seen.add(raw.id);
    if (!turnNumber(raw.openedAt)) violations.push({ code: "bad_field", path: `${at}.openedAt` });
    for (const window of ["stickyUntil", "cooldownUntil"] as const) {
      if (raw[window] !== undefined && !turnNumber(raw[window])) violations.push({ code: "bad_field", path: `${at}.${window}` });
    }
  });
  return violations;
}

/**
 * A stored timer state read back; an invalid one reads as fresh timers. Losing a window
 * means an entry may fire a few turns early — the mildest failure available, and better
 * than refusing to assemble lore at all.
 */
export function readTimerState(data: JsonObject): TimerState {
  if (validateTimerState(data).length > 0) return EMPTY_TIMERS;
  const entries = (data.entries as readonly JsonObject[]).map((raw): EntryTimer => ({
    id: raw.id as string,
    openedAt: raw.openedAt as number,
    ...(raw.stickyUntil !== undefined ? { stickyUntil: raw.stickyUntil as number } : {}),
    ...(raw.cooldownUntil !== undefined ? { cooldownUntil: raw.cooldownUntil as number } : {}),
  }));
  return { turn: data.turn as number, entries };
}

/** The state without the timers of removed entries (a removed entry's window is meaningless). */
export function dropTimers(state: TimerState, removedIds: Iterable<string>): TimerState {
  const removed = new Set(removedIds);
  const entries = state.entries.filter((timer) => !removed.has(timer.id));
  return entries.length === state.entries.length ? state : { turn: state.turn, entries };
}

function projectTimers(document: Document, viewer: Viewer): TimerState | null {
  return viewer.grade === "keeper" ? readTimerState(document.data) : null;
}

export const loreTimersDocumentType: DocumentType<TimerState> = {
  name: LORE_TIMERS_TYPE,
  // Produced by play: a story reset starts the windows over with the story.
  lifecycle: { reset: "story" },
  version: 1,
  project: projectTimers,
  validate: validateTimerState,
};
