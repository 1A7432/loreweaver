// Table habits: the engine's procedural memory of how THIS table plays — pacing
// preferences, patience with long combats, what landed and what fell flat, a Keeper
// technique that misfired. The worldbook says what the world is, the chronicle what
// happened, skills how to run a thing as authored; this is how to run it for these people,
// as learned.
//
// One `table_habits` document per room: `{ habits: [...], pending: [...] }`, each item
// `{ summary, detail, seen }`. An observation is a pending candidate until it has been
// seen `PROMOTION_THRESHOLD` (3) times — two is a coincidence, three is how the table
// plays — and then a durable habit. The count lives here because the observer (the
// Scribe) has no memory across turns of its own. Only the summaries stay resident in the
// Keeper's prompt (`habitIndex`); details are read on demand.
//
// Keeper-only. Every field describes the players themselves; handing that back to the
// people it describes is a metagaming leak and simply rude, and a redacted view would still
// tell them a record about them exists. The admin is one of those people.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";

export const TABLE_HABITS_TYPE = "table_habits";
export const TABLE_HABITS_ID = "habits";

export const PROMOTION_THRESHOLD = 3;
/** Written by a model every turn and read into the prompt every turn: the index must stay small. */
export const MAX_HABITS = 24;
export const MAX_PENDING = 24;
export const MAX_HABIT_SUMMARY_CHARS = 120;
export const MAX_HABIT_DETAIL_CHARS = 600;
/** A sighting count is bounded so a stored document cannot carry an absurd number. */
export const MAX_SEEN = 1_000_000;

export interface Habit {
  readonly summary: string;
  readonly detail: string;
  readonly seen: number;
}

export interface TableHabits {
  readonly habits: readonly Habit[];
  /** Candidates, oldest first. */
  readonly pending: readonly Habit[];
}

export const NO_HABITS: TableHabits = Object.freeze({ habits: Object.freeze([]), pending: Object.freeze([]) });

export type HabitRefusalCode = "empty" | "too_long" | "habits_full" | "not_found";

export type HabitChange<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: HabitRefusalCode; readonly path: string };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What two summaries must share to be the same observation: their letters and digits,
 * case-folded. Coarse on purpose — the observer words each sighting itself, and an exact
 * match would mean a candidate could never accumulate. A near miss starts its own
 * candidate; being wrong costs one unpromoted line, not a wrong habit.
 */
export function habitKey(summary: string): string {
  return Array.from(summary.toLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

export interface Observation {
  readonly habits: TableHabits;
  readonly promoted: boolean;
}

/**
 * Record one sighting of `summary`. A known habit does not get louder by repetition. A
 * candidate reaching the threshold is promoted; promotion into a full index is refused
 * (the candidate keeps its count, so nothing learned is lost — a habit can be forgotten to
 * make room). When the candidates are full, the OLDEST candidate ages out: candidates are
 * unconfirmed sightings, and the newest is the one with evidence still arriving.
 */
export function observeHabit(state: TableHabits, summaryText: string, detailText = ""): HabitChange<Observation> {
  const summary = summaryText.trim();
  const detail = detailText.trim();
  const key = habitKey(summary);
  if (key === "") return { ok: false, code: "empty", path: "summary" };
  if (codePoints(summary) > MAX_HABIT_SUMMARY_CHARS) return { ok: false, code: "too_long", path: "summary" };
  if (codePoints(detail) > MAX_HABIT_DETAIL_CHARS) return { ok: false, code: "too_long", path: "detail" };
  if (state.habits.some((habit) => habitKey(habit.summary) === key)) return { ok: true, data: { habits: state, promoted: false } };

  const prior = state.pending.find((candidate) => habitKey(candidate.summary) === key);
  const others = state.pending.filter((candidate) => habitKey(candidate.summary) !== key);
  const candidate: Habit = { summary, detail: detail !== "" ? detail : (prior?.detail ?? ""), seen: Math.min(MAX_SEEN, (prior?.seen ?? 0) + 1) };
  if (candidate.seen >= PROMOTION_THRESHOLD) {
    if (state.habits.length >= MAX_HABITS) return { ok: false, code: "habits_full", path: "habits" };
    return { ok: true, data: { habits: { habits: [...state.habits, candidate], pending: others }, promoted: true } };
  }
  const pending = [...others, candidate];
  return { ok: true, data: { habits: { habits: state.habits, pending: pending.slice(Math.max(0, pending.length - MAX_PENDING)) }, promoted: false } };
}

/** Drop a habit (or candidate) by its summary. */
export function forgetHabit(state: TableHabits, summary: string): HabitChange<TableHabits> {
  const key = habitKey(summary);
  const habits = state.habits.filter((habit) => habitKey(habit.summary) !== key);
  const pending = state.pending.filter((candidate) => habitKey(candidate.summary) !== key);
  if (key === "" || (habits.length === state.habits.length && pending.length === state.pending.length)) return { ok: false, code: "not_found", path: "summary" };
  return { ok: true, data: { habits, pending } };
}

/** The one-line summaries that stay resident in the Keeper's prompt. */
export function habitIndex(state: TableHabits): string[] {
  return state.habits.map((habit) => habit.summary);
}

export function tableHabitsData(state: TableHabits): JsonObject {
  const item = (habit: Habit): JsonObject => ({ summary: habit.summary, detail: habit.detail, seen: habit.seen });
  return { habits: state.habits.map(item), pending: state.pending.map(item) };
}

function validateList(violations: WriteViolation[], value: unknown, field: "habits" | "pending", max: number): void {
  if (!Array.isArray(value)) {
    violations.push({ code: "bad_field", path: field });
    return;
  }
  if (value.length > max) violations.push({ code: "too_many", path: field });
  value.forEach((raw, index) => {
    const at = `${field}.${index}`;
    if (!isRecord(raw)) {
      violations.push({ code: "bad_field", path: at });
      return;
    }
    for (const key of Object.keys(raw)) if (!["summary", "detail", "seen"].includes(key)) violations.push({ code: "unknown_field", path: `${at}.${key}` });
    if (typeof raw.summary !== "string" || habitKey(raw.summary) === "") violations.push({ code: "empty", path: `${at}.summary` });
    else if (codePoints(raw.summary) > MAX_HABIT_SUMMARY_CHARS) violations.push({ code: "too_long", path: `${at}.summary` });
    if (typeof raw.detail !== "string") violations.push({ code: "bad_field", path: `${at}.detail` });
    else if (codePoints(raw.detail) > MAX_HABIT_DETAIL_CHARS) violations.push({ code: "too_long", path: `${at}.detail` });
    if (typeof raw.seen !== "number" || !Number.isSafeInteger(raw.seen) || raw.seen < 1 || raw.seen > MAX_SEEN) violations.push({ code: "bad_field", path: `${at}.seen` });
  });
}

export function validateTableHabits(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (key !== "habits" && key !== "pending") violations.push({ code: "unknown_field", path: key });
  validateList(violations, data.habits, "habits", MAX_HABITS);
  validateList(violations, data.pending, "pending", MAX_PENDING);
  return violations;
}

/** A stored document read back; an invalid one reads as nothing learned yet. */
export function readTableHabits(data: JsonObject): TableHabits {
  if (validateTableHabits(data).length > 0) return NO_HABITS;
  const read = (raw: JsonObject): Habit => ({ summary: raw.summary as string, detail: raw.detail as string, seen: raw.seen as number });
  return { habits: (data.habits as readonly JsonObject[]).map(read), pending: (data.pending as readonly JsonObject[]).map(read) };
}

function projectHabits(document: Document, viewer: Viewer): TableHabits | null {
  return viewer.grade === "keeper" ? readTableHabits(document.data) : null;
}

export const tableHabitsDocumentType: DocumentType<TableHabits> = {
  name: TABLE_HABITS_TYPE,
  lifecycle: {
    reset: "never",
    because:
      "it describes the people at this table, not the story they played: the players who start a fresh campaign are the same players, so what was learned about how they play is still true",
  },
  version: 1,
  project: projectHabits,
  validate: validateTableHabits,
};
