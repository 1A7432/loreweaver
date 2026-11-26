// The lore step of a prompt assembly, the engine's side (§12 3.2 steps 4, 6 and 7).
//
// 1. Build the request from stored data, synchronously: the room's lore entries with the
//    admin's overlay applied (`applyOverlay`, the one definition of effective state), the
//    activation timers, the caller's transcript window and variable snapshot, the semantic
//    hits recall found, and a seed derived from persisted inputs (room, generation, turn),
//    so a retry of the same turn draws the same randomness.
// 2. Ask the room's worker once (`RoomWorker.assembleLore`): the worldbook scan and the
//    template rendering run there as one job, because templates are content code.
// 3. Check the answer as untrusted plain data — it crossed a thread that ran content code —
//    and return the injected text plus the changes for the caller to commit: the timer
//    state only when this assembly counted a new turn, and the templates' variable writes
//    as write requests (`commitLore` commits both, through `agent/effects.ts` for the writes).
//
// Failure is never a failed turn: an exchange that throws or times out yields no lore for
// this turn and a reported problem (a timeout also costs the worker, which the next call
// rebuilds from the checkpoints). Nothing about the room is held across the exchange.
//
// Which rooms need a worker: one whose lore has at least one ENABLED entry. The step reads
// the entries anyway, so the test costs nothing; a room with no enabled lore never asks for
// a worker, and its timer turn still advances here, on the main thread, so `delay` keeps
// counting turns.
import type { Json } from "loreweaver/module";

import { DocumentRefused } from "../core/documents/raw.ts";
import {
  applyOverlay,
  EMPTY_OVERLAY,
  LORE_ENTRY_TYPE,
  LORE_OVERLAY_ID,
  LORE_OVERLAY_TYPE,
  LORE_TIMERS_ID,
  LORE_TIMERS_TYPE,
  readLoreEntry,
  readOverlay,
  readTimerState,
  timerStateData,
  validateTimerState,
} from "../core/lore/index.ts";
import {
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  normalizeModuleVariables,
  readVariableTree,
  toJson,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
} from "../core/variables/index.ts";
import {
  EMPTY_TIMERS,
  type GameClock,
  type InjectedEntry,
  type LoreEntry,
  MAX_ENTRIES_CEILING,
  type TimerState,
  type VariableSnapshot,
  type ViewerGrade,
} from "../core/worldbook/index.ts";
import type { RoomWorker } from "../infra/room_worker.ts";
import { WorkerTimeout } from "../infra/room_worker.ts";
import type { LoreRequest } from "../infra/worker_protocol.ts";
import type { RoomContext, Services } from "./context.ts";
import { commitVariableWrites, type ContentWrite, MAX_WRITE_PATH_CHARS, type WriteCommit } from "./effects.ts";

/** Injected entries an answer may carry: the selected ones plus as many pulled in. */
export const MAX_INJECTED = 2 * MAX_ENTRIES_CEILING;
/** One rendered entry, in code points (the template session's output bound). */
export const MAX_INJECTED_CHARS = 100_000;
/** All rendered lore of one assembly, in code points. */
export const MAX_LORE_TEXT_CHARS = 200_000;
/** Template writes kept per assembly (the template session's cap). */
export const MAX_LORE_WRITES = 64;
/** One template write's value, as JSON text in UTF-16 units (the session's bound). */
export const MAX_LORE_WRITE_CHARS = 16_384;
/** Template failures reported per assembly. */
export const MAX_LORE_FAILURES = 64;
/** The template engine's own failure codes are short identifiers. */
const MAX_CODE_CHARS = 40;
/** Who writes the template writes, in the content-writes record. */
export const TEMPLATE_WRITER = "template";

/** The lore exchange's request: the shape `worker/templates` reads as `LoreAssemblyRequest`. */
export interface LoreExchangeRequest {
  readonly entries: readonly LoreEntry[];
  readonly viewer: ViewerGrade;
  readonly transcript: readonly string[];
  readonly timers: TimerState;
  readonly advanceTimers: boolean;
  readonly variables: VariableSnapshot;
  readonly seed: string;
  readonly nowMs: number;
  readonly pickSeed?: string;
  readonly names?: { readonly user?: string; readonly char?: string };
  readonly clock?: GameClock;
  readonly character?: Readonly<Record<string, unknown>>;
  readonly chat?: Readonly<Record<string, unknown>>;
  readonly maxEntries?: number;
  readonly budgetChars?: number;
  readonly includeConstant?: boolean;
  readonly semanticHits?: readonly string[];
  readonly limits?: { readonly perTemplateMs?: number; readonly perAssemblyMs?: number };
}

/** What the caller decides for one assembly. */
export interface LoreStepInput {
  /** `keeper` for the Keeper's prompt; `player` for anything player-grade (no secret entry, ever). */
  readonly viewer: ViewerGrade;
  /** The transcript window, oldest first. */
  readonly transcript: readonly string[];
  /** true for the turn's first assembly; false for an overflow retry or a browse. */
  readonly advanceTimers: boolean;
  /** The room's variables as templates and conditions read them (`loreVariables`). */
  readonly variables: VariableSnapshot;
  /** What `Date.now()` is inside templates: a persisted time (the player line's), for replay. */
  readonly nowMs: number;
  /** Lore entry ids semantic recall found (`agent/recall.ts`). */
  readonly semanticHits?: readonly string[];
  readonly names?: { readonly user?: string; readonly char?: string };
  readonly clock?: GameClock;
  readonly character?: Readonly<Record<string, unknown>>;
  readonly chat?: Readonly<Record<string, unknown>>;
  readonly maxEntries?: number;
  readonly budgetChars?: number;
  readonly includeConstant?: boolean;
  /** Template time limits; keep them under the worker's timeout so a runaway template costs its entry, not the worker. */
  readonly limits?: { readonly perTemplateMs?: number; readonly perAssemblyMs?: number };
}

export type LoreProblemCode =
  /** The exchange ran past the worker's timeout: the worker was ended. */
  | "lore_timeout"
  /** The exchange failed (a module did not load, the worker crashed…). */
  | "lore_failed"
  /** The answer is not an object of the expected shape. */
  | "bad_answer"
  /** An injected entry that names no entry of the request, or has a bad field, was dropped. */
  | "injected_dropped"
  /** A player-grade answer named a secret or disabled entry: dropped. */
  | "secret_dropped"
  /** The rendered lore passed `MAX_LORE_TEXT_CHARS`: the entries after it were dropped. */
  | "text_too_long"
  /** The answer's timer state is not a valid advance of the request's: timers stay as they were. */
  | "bad_timers"
  /** A template write that is malformed or over a cap was dropped. */
  | "write_dropped"
  /** A stored entry could not be read and was left out. */
  | "entry_unreadable";

/** For the operator's log; never shown at the table. */
export interface LoreProblem {
  readonly code: LoreProblemCode;
  readonly detail?: string;
}

export interface LoreTemplateFailure {
  readonly kind: "render" | "condition";
  readonly code: string;
  readonly entryId?: string;
}

export interface LoreStepOutcome {
  /** Whether the worker was asked (false: no enabled entries, or the exchange failed). */
  readonly ran: boolean;
  /** The rendered entries joined by line breaks; "" for none. The section header is the assembler's. */
  readonly text: string;
  readonly injected: readonly InjectedEntry[];
  /** Titles activation selected, in final order (for the keeper's `.lore show` receipt). */
  readonly activatedTitles: readonly string[];
  /** The timer state to store, or null to leave it as it is (a retry, a browse, a failure). */
  readonly timers: TimerState | null;
  /** Template variable writes, in call order, for the caller to commit. */
  readonly writes: readonly ContentWrite[];
  readonly failures: readonly LoreTemplateFailure[];
  readonly problems: readonly LoreProblem[];
}

export interface LoreStepDeps {
  /** The room's worker, created on demand (`Hub.workerForLore`). Called only when there is lore to scan. */
  readonly worker: () => RoomWorker;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJson(item, depth + 1));
}

// ---------------------------------------------------------------- building the request

/** The room's entries as the room sees them (overlay applied), and how many were unreadable. */
export function loreEntries(services: Services, room: string): { readonly entries: readonly LoreEntry[]; readonly unreadable: number } {
  const overlayDocument = services.documents.get(room, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID);
  const overlay = overlayDocument === null || overlayDocument.corrupt ? EMPTY_OVERLAY : readOverlay(overlayDocument.data);
  const entries: LoreEntry[] = [];
  let unreadable = 0;
  for (const document of services.documents.list(room, LORE_ENTRY_TYPE)) {
    const entry = readLoreEntry(document);
    if (entry === null) unreadable += 1;
    else entries.push(applyOverlay(entry, overlay));
  }
  return { entries, unreadable };
}

/** The stored timer state, or fresh timers. */
export function loreTimers(services: Services, room: string): TimerState {
  const document = services.documents.get(room, LORE_TIMERS_TYPE, LORE_TIMERS_ID);
  return document === null || document.corrupt ? EMPTY_TIMERS : readTimerState(document.data);
}

/** The room's variables as entries and templates read them: module variables, then the tree. */
export function loreVariables(services: Services, room: string): VariableSnapshot {
  const flat: Record<string, unknown> = {};
  const variables = services.documents.get(room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  if (variables !== null && !variables.corrupt) {
    for (const variable of normalizeModuleVariables(variables.data).variables) flat[variable.spec.id] = variable.value;
  }
  const treeDocument = services.documents.get(room, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  const tree = treeDocument === null || treeDocument.corrupt ? {} : (toJson(readVariableTree(treeDocument.data).tree) as Record<string, unknown>);
  return { flat, tree };
}

/** The assembly's seed: room, generation and turn — persisted inputs, so a retry draws the same. */
export function loreSeed(context: Pick<RoomContext, "room" | "writer" | "turn">): string {
  return `lore\u0000${context.room}\u0000${context.writer.epoch}\u0000${context.turn}`;
}

function optional<T extends Record<string, unknown>>(fields: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out as Partial<T>;
}

/** The request for this assembly, built from the store as it is now. */
export function buildLoreRequest(
  context: RoomContext,
  input: LoreStepInput,
): { readonly request: LoreExchangeRequest; readonly enabled: number; readonly problems: readonly LoreProblem[] } {
  const { entries, unreadable } = loreEntries(context.services, context.room);
  const request: LoreExchangeRequest = {
    entries,
    viewer: input.viewer,
    transcript: [...input.transcript],
    timers: loreTimers(context.services, context.room),
    advanceTimers: input.advanceTimers,
    variables: input.variables,
    seed: loreSeed(context),
    nowMs: input.nowMs,
    pickSeed: context.room,
    ...optional({
      names: input.names,
      clock: input.clock,
      character: input.character,
      chat: input.chat,
      maxEntries: input.maxEntries,
      budgetChars: input.budgetChars,
      includeConstant: input.includeConstant,
      semanticHits: input.semanticHits === undefined ? undefined : [...input.semanticHits],
      limits: input.limits,
    }),
  };
  return {
    request,
    enabled: entries.filter((entry) => entry.enabled).length,
    problems: unreadable > 0 ? [{ code: "entry_unreadable", detail: String(unreadable) }] : [],
  };
}

// ---------------------------------------------------------------- the exchange

function empty(timers: TimerState | null, problems: readonly LoreProblem[]): LoreStepOutcome {
  return { ran: false, text: "", injected: [], activatedTitles: [], timers, writes: [], failures: [], problems };
}

/**
 * Timers advanced without the worker: a room with no enabled entry selects nothing, so
 * the only change is the turn count (and timers of entries no longer enabled lapse).
 */
function advanceWithoutLore(timers: TimerState): TimerState {
  return { turn: timers.turn + 1, entries: [] };
}

/** Run the lore step for one assembly. Never throws for a content or worker failure. */
export async function runLoreStep(context: RoomContext, input: LoreStepInput, deps: LoreStepDeps): Promise<LoreStepOutcome> {
  const built = buildLoreRequest(context, input);
  if (built.enabled === 0) return empty(input.advanceTimers ? advanceWithoutLore(built.request.timers) : null, built.problems);
  let raw: unknown;
  try {
    raw = await deps.worker().assembleLore(built.request as unknown as LoreRequest);
  } catch (error) {
    return empty(null, [...built.problems, { code: error instanceof WorkerTimeout ? "lore_timeout" : "lore_failed" }]);
  }
  const checked = validateLoreAnswer(raw, built.request);
  return { ...checked, problems: [...built.problems, ...checked.problems] };
}

// ---------------------------------------------------------------- checking the answer

function checkTimers(raw: unknown, request: LoreExchangeRequest, problems: LoreProblem[]): TimerState | null {
  if (!request.advanceTimers) return null;
  const bad = (): null => {
    problems.push({ code: "bad_timers" });
    return null;
  };
  if (!isRecord(raw) || validateTimerState(raw as never).length > 0) return bad();
  const timers = readTimerState(raw as never);
  if (timers.turn !== request.timers.turn + 1) return bad();
  const live = new Set(request.entries.filter((entry) => entry.enabled).map((entry) => entry.id));
  if (timers.entries.some((timer) => !live.has(timer.id))) return bad();
  return timers;
}

function checkWrites(raw: unknown, problems: LoreProblem[]): ContentWrite[] {
  const writes: ContentWrite[] = [];
  if (!Array.isArray(raw)) {
    if (raw !== undefined) problems.push({ code: "write_dropped" });
    return writes;
  }
  for (const item of raw) {
    const path = isRecord(item) ? get(item, "path") : undefined;
    const value = isRecord(item) ? get(item, "value") : undefined;
    const ok =
      writes.length < MAX_LORE_WRITES &&
      typeof path === "string" &&
      path !== "" &&
      codePoints(path) <= MAX_WRITE_PATH_CHARS &&
      isJson(value) &&
      JSON.stringify(value).length <= MAX_LORE_WRITE_CHARS;
    if (ok) writes.push({ path, value, by: TEMPLATE_WRITER });
    else problems.push({ code: "write_dropped" });
  }
  return writes;
}

function checkFailures(raw: unknown, known: ReadonlyMap<string, LoreEntry>): LoreTemplateFailure[] {
  const failures: LoreTemplateFailure[] = [];
  if (!Array.isArray(raw)) return failures;
  for (const item of raw.slice(0, MAX_LORE_FAILURES)) {
    if (!isRecord(item)) continue;
    const kind = get(item, "kind");
    const code = get(item, "code");
    const entryId = get(item, "entryId");
    if ((kind !== "render" && kind !== "condition") || typeof code !== "string" || code === "" || code.length > MAX_CODE_CHARS) continue;
    // The template's own error message (`detail`) is content: it is not carried.
    failures.push(typeof entryId === "string" && known.has(entryId) ? { kind, code, entryId } : { kind, code });
  }
  return failures;
}

/**
 * Check a worker's lore answer against the request it answers. The text is rebuilt from
 * the injected entries that survive; placement and depth come from the stored entry, not
 * from the answer; for a player-grade request an entry that is secret or disabled is
 * dropped whatever the worker says.
 */
export function validateLoreAnswer(raw: unknown, request: LoreExchangeRequest): LoreStepOutcome {
  const problems: LoreProblem[] = [];
  if (!isRecord(raw)) return empty(null, [{ code: "bad_answer" }]);
  const known = new Map(request.entries.map((entry) => [entry.id, entry]));
  const visible = (entry: LoreEntry): boolean => entry.enabled && (request.viewer === "keeper" || !entry.secret);

  const injected: InjectedEntry[] = [];
  let total = 0;
  const items = get(raw, "injected");
  if (!Array.isArray(items)) return empty(null, [{ code: "bad_answer" }]);
  for (const item of items.slice(0, MAX_INJECTED)) {
    const id = isRecord(item) ? get(item, "id") : undefined;
    const text = isRecord(item) ? get(item, "text") : undefined;
    const via = isRecord(item) ? get(item, "via") : undefined;
    const entry = typeof id === "string" ? known.get(id) : undefined;
    if (entry === undefined || typeof text !== "string" || (via !== "match" && via !== "activewi") || codePoints(text) > MAX_INJECTED_CHARS) {
      problems.push({ code: "injected_dropped" });
      continue;
    }
    if (!visible(entry)) {
      problems.push({ code: "secret_dropped" });
      continue;
    }
    if (injected.some((done) => done.id === entry.id)) {
      problems.push({ code: "injected_dropped" });
      continue;
    }
    const size = codePoints(text);
    if (total + size > MAX_LORE_TEXT_CHARS) {
      problems.push({ code: "text_too_long" });
      break;
    }
    total += size;
    injected.push({ id: entry.id, title: entry.title, text, placement: entry.placement, depth: entry.depth, via });
  }
  if (items.length > MAX_INJECTED) problems.push({ code: "injected_dropped" });

  const titles = new Set(request.entries.filter(visible).map((entry) => entry.title));
  const rawTitles = get(raw, "activatedTitles");
  const activatedTitles = Array.isArray(rawTitles) ? rawTitles.filter((title): title is string => typeof title === "string" && titles.has(title)).slice(0, MAX_INJECTED) : [];

  return {
    ran: true,
    text: injected.map((entry) => entry.text).join("\n"),
    injected,
    activatedTitles,
    timers: checkTimers(get(raw, "timers"), request, problems),
    writes: checkWrites(get(raw, "writes"), problems),
    failures: checkFailures(get(raw, "failures"), known),
    problems,
  };
}

// ---------------------------------------------------------------- committing

export interface LoreCommit {
  /** The writer is no longer current: nothing was written. */
  readonly stale: boolean;
  readonly timersStored: boolean;
  readonly writes: WriteCommit;
}

/**
 * Commit what an assembly changed, in one synchronous block: the timer state (only when
 * the assembly advanced it) and the template writes. Call it with the context the turn
 * runs under, after the exchange returned.
 */
export function commitLore(context: RoomContext, outcome: LoreStepOutcome): LoreCommit {
  if (!context.writer.current()) return { stale: true, timersStored: false, writes: { applied: [], refused: [] } };
  let timersStored = false;
  if (outcome.timers !== null) {
    try {
      context.services.documents.put(context.writer, LORE_TIMERS_TYPE, LORE_TIMERS_ID, timerStateData(outcome.timers));
      timersStored = true;
    } catch (error) {
      if (!(error instanceof DocumentRefused)) throw error;
    }
  }
  return { stale: false, timersStored, writes: commitVariableWrites(context, outcome.writes) };
}
