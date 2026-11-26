// The fold policy: when old chronicle records are folded into the campaign summary, and
// which ones. Pure and total; the model call that writes the summary is the memory lane's
// business, and so is reading the meter and the history from wherever they are kept.
//
// What a fold FREES is replayed history. Writing the summary's `throughTurn` is what lets
// the engine stop replaying every message of a turn at or below it (`mayReplay`), and that
// is the whole of a fold's effect on the prompt: the summary is bounded and no raw records
// are rendered. So the gate and the batch sizing are both measured in the tokens of the
// replayed messages a fold would drop (`historyTokensThrough`) — not in the records' own
// size, which measures text that was never in the prompt twice.
//
// The levels, as ratios of the room model's context window (so every window behaves alike):
//   - trigger 0.60: fold, oldest first, until the replayed history it drops covers the
//     distance down to the floor;
//   - floor 0.40: the target — batch folding, never one record per turn;
//   - emergency 0.85: the same fold, and the caller runs it before the next model call so
//     the fold's own generation always has headroom.
// The no-future guard: records of the last `lagTurns` (4) turns are never folded — a scene
// still in play is not history yet — and a fold input naming a later turn is refused.
// Bounds: at most 12 records per fold call and 3 fold calls per turn (shared with the
// overflow recovery fold); a longer backlog drains over later turns. These are constants,
// not settings, so no configuration can lengthen a turn.
// Re-arm: a routine fold stamps the reading it acted on. If the next reading came down,
// the stamp is retired (the fold worked); if not, routine folds stay disarmed until the
// meter grows by 5% of the window past it — a room over the trigger for reasons the
// chronicle cannot touch must not buy a wasted fold call every turn.
import type { Usage } from "../../infra/llm/types.ts";
import type { WriteViolation } from "../documents/model.ts";
import { estimateTokens } from "./estimate.ts";
import type { ChronicleRecord } from "./records.ts";
import { type CampaignSummary, MAX_SUMMARY_CHARS } from "./summary.ts";

export const FOLD_TRIGGER = 0.6;
export const FOLD_FLOOR = 0.4;
export const FOLD_EMERGENCY = 0.85;
export const FOLD_LAG_TURNS = 4;
export const FOLD_BATCH_MAX_RECORDS = 12;
export const FOLD_MAX_BATCHES_PER_TURN = 3;
export const FOLD_REARM_GROWTH = 0.05;
export const DEFAULT_SUMMARY_MAX_CHARS = 4_000;
export const MAX_LAG_TURNS = 1_000;

export interface FoldSettings {
  readonly trigger: number;
  readonly floor: number;
  readonly emergency: number;
  readonly lagTurns: number;
  /** The room's ceiling on summary text, in code points (at most `MAX_SUMMARY_CHARS`). */
  readonly summaryMaxChars: number;
}

export const DEFAULT_FOLD_SETTINGS: FoldSettings = Object.freeze({
  trigger: FOLD_TRIGGER,
  floor: FOLD_FLOOR,
  emergency: FOLD_EMERGENCY,
  lagTurns: FOLD_LAG_TURNS,
  summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
});

/** Problems with fold settings: `0 <= floor < trigger <= emergency <= 1`, and bounded integers. */
export function checkFoldSettings(settings: FoldSettings): WriteViolation[] {
  const violations: WriteViolation[] = [];
  const { trigger, floor, emergency } = settings;
  for (const [name, value] of [
    ["trigger", trigger],
    ["floor", floor],
    ["emergency", emergency],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) violations.push({ code: "bad_field", path: name });
  }
  if (violations.length === 0) {
    if (!(floor < trigger)) violations.push({ code: "bad_order", path: "floor" });
    if (!(trigger <= emergency)) violations.push({ code: "bad_order", path: "emergency" });
  }
  if (!Number.isSafeInteger(settings.lagTurns) || settings.lagTurns < 0 || settings.lagTurns > MAX_LAG_TURNS) violations.push({ code: "bad_field", path: "lagTurns" });
  if (!Number.isSafeInteger(settings.summaryMaxChars) || settings.summaryMaxChars < 1 || settings.summaryMaxChars > MAX_SUMMARY_CHARS) {
    violations.push({ code: "bad_field", path: "summaryMaxChars" });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The meter
// ---------------------------------------------------------------------------

/**
 * One reading of the room's context fullness: the last completed turn's prompt size and
 * the room model's window. `estimated` says nobody measured it — the provider reported no
 * usage, so the engine sized the prompt itself. The flag travels with the number because
 * the two sources do not share a scale (a provider counts framing and tool schemas an
 * estimate can only approximate); only the re-arm check compares readings, and it refuses
 * to compare across sources.
 */
export interface ContextReading {
  readonly tokens: number;
  readonly window: number;
  readonly estimated: boolean;
}

function wholeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * A measured reading. `inputTokens` already counts every prompt token, cached or not —
 * what occupies the window — so cached tokens are never subtracted: a cache changes what
 * a prompt costs, not how much of the window it fills.
 */
export function measuredReading(usage: Pick<Usage, "inputTokens">, window: number): ContextReading {
  return { tokens: wholeTokens(usage.inputTokens), window: wholeTokens(window), estimated: false };
}

/** A reading the engine estimated (e.g. `estimateTokens` over the prompt it sent). */
export function estimatedReading(tokens: number, window: number): ContextReading {
  return { tokens: wholeTokens(tokens), window: wholeTokens(window), estimated: true };
}

/**
 * The provider refused the prompt as too long: at least the whole window. Flagged as an
 * estimate (nobody counted it), so the next turn's fold sees the pressure the meter missed.
 */
export function overflowReading(window: number): ContextReading {
  const size = wholeTokens(window);
  return { tokens: size, window: size, estimated: true };
}

/**
 * The reading for a completed turn: the provider's usage when it reported any, otherwise
 * the engine's estimate of the same prompt, flagged as such. A meter that is merely absent
 * would read as "no pressure" and leave the fold — emergency level included — inert.
 */
export function contextReading(usage: Pick<Usage, "inputTokens"> | null | undefined, estimatedPromptTokens: number, window: number): ContextReading {
  if (usage !== null && usage !== undefined && wholeTokens(usage.inputTokens) > 0) return measuredReading(usage, window);
  return estimatedReading(estimatedPromptTokens, window);
}

/** The reading as a fraction of the window; 0 without a window. */
export function fullness(reading: ContextReading): number {
  return reading.window > 0 ? reading.tokens / reading.window : 0;
}

export type FoldLevel = "none" | "fold" | "emergency";

export function foldLevel(level: number, settings: Pick<FoldSettings, "trigger" | "emergency">): FoldLevel {
  if (level >= settings.emergency) return "emergency";
  if (level >= settings.trigger) return "fold";
  return "none";
}

/** The no-future watermark: only records with `turn <= watermark` may fold. */
export function foldWatermark(currentTurn: number, lagTurns: number): number {
  return currentTurn - lagTurns;
}

/** The meter reading a routine fold acted on (stored on the summary as `foldMeter`). */
export interface FoldMeterStamp {
  readonly tokens: number;
  readonly estimated: boolean;
}

/**
 * Is a routine fold armed, judged by what the last one achieved? Returns the stamp to keep.
 * - no stamp: armed;
 * - a stamp from the other source (measured vs estimated): not comparable, so retired —
 *   armed. Believing it could leave a room that switched providers disarmed forever;
 * - the reading came down since: the fold worked, the stamp is retired — armed. (Without
 *   this every fold would raise the bar for the next until a long campaign stopped folding);
 * - otherwise: disarmed until the reading reaches the stamp plus 5% of the window.
 */
export function rearm(stamp: FoldMeterStamp | null, reading: ContextReading): { readonly armed: boolean; readonly stamp: FoldMeterStamp | null } {
  if (stamp === null) return { armed: true, stamp: null };
  if (stamp.estimated !== reading.estimated) return { armed: true, stamp: null };
  if (reading.tokens < stamp.tokens) return { armed: true, stamp: null };
  return { armed: reading.tokens >= stamp.tokens + FOLD_REARM_GROWTH * reading.window, stamp };
}

// ---------------------------------------------------------------------------
// Replayed history
// ---------------------------------------------------------------------------

/** One replayed message's turn and estimated size. */
export interface TurnCost {
  readonly turn: number;
  readonly tokens: number;
}

/** Each replayed message priced once (`estimateTokens` over its content). */
export function replayCosts(messages: readonly { readonly turn: number; readonly content: string }[]): TurnCost[] {
  return messages.map((message) => ({ turn: message.turn, tokens: estimateTokens(message.content) }));
}

/**
 * Whether a message of `turn` may still be replayed when the summary runs through
 * `throughTurn`: everything after it, and everything when nothing has folded. A message
 * with no turn (0) is dropped once anything has folded, like any turn the summary covers.
 */
export function mayReplay(turn: number, throughTurn: number): boolean {
  return throughTurn <= 0 || turn > throughTurn;
}

/** The messages that may still be replayed, in order. */
export function replayable<M extends { readonly turn: number }>(messages: readonly M[], throughTurn: number): M[] {
  return messages.filter((message) => mayReplay(message.turn, throughTurn));
}

/**
 * The replayed-history tokens a fold through `throughTurn` frees: exactly the messages
 * `mayReplay` would then drop. It steps rather than slopes — several records can share a
 * turn, and a turn with no record still costs history.
 */
export function historyTokensThrough(costs: readonly TurnCost[], throughTurn: number): number {
  if (throughTurn <= 0) return 0;
  let total = 0;
  for (const cost of costs) if (cost.turn <= throughTurn) total += cost.tokens;
  return total;
}

// ---------------------------------------------------------------------------
// Choosing what to fold
// ---------------------------------------------------------------------------

/** A chronicle record reduced to what the policy needs. */
export interface FoldRecord {
  readonly id: string;
  readonly turn: number;
  readonly folded: boolean;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * Every unfolded record at or below the watermark, oldest first (by turn, then id). Order
 * matters: the summary's through-turn only moves forward, so only folding from the oldest
 * end frees history, and the lag window must stay raw.
 */
export function foldableRecords(records: readonly FoldRecord[], watermark: number): FoldRecord[] {
  return records
    .filter((record) => !record.folded && record.turn <= watermark)
    .sort((left, right) => left.turn - right.turn || compareCodePoints(left.id, right.id));
}

export type FoldMode =
  /** The per-turn check, driven by the meter. */
  | "routine"
  /** The admin's explicit drain: every foldable record, no meter, no batch budget. */
  | "manual"
  /** The provider refused the prompt as too long: no meter (it was just proven wrong). */
  | "recovery";

export interface FoldInput {
  readonly mode: FoldMode;
  /** The last completed turn's reading; null when there is none yet (a fresh room). */
  readonly reading: ContextReading | null;
  /** The room's count of completed turns. */
  readonly currentTurn: number;
  readonly records: readonly FoldRecord[];
  /** The history being replayed now — already without what the summary covers. */
  readonly replayed: readonly TurnCost[];
  /** The summary's `foldMeter`. */
  readonly stamp: FoldMeterStamp | null;
  /** Fold calls this turn has already made (the routine fold's, for a recovery fold). */
  readonly batchesSpent: number;
  readonly settings: FoldSettings;
}

export type FoldSkip =
  /** Routine, and no reading with a window yet. */
  | "no_meter"
  | "below_trigger"
  /** Over the trigger, but the last fold freed nothing the meter saw. */
  | "disarmed"
  /** This turn already made its fold calls. */
  | "budget_spent"
  /** No unfolded record is older than the lag window. */
  | "nothing_foldable"
  /** Folding everything foldable would drop no replayed history: the pressure is elsewhere. */
  | "nothing_to_free";

/** One fold call: at most `FOLD_BATCH_MAX_RECORDS` record ids, oldest first. */
export interface FoldBatch {
  readonly ids: readonly string[];
  /** The newest turn in the batch. */
  readonly throughTurn: number;
}

export interface FoldPlan {
  readonly level: FoldLevel | "manual" | "recovery";
  /** Why nothing is planned; null when batches are. */
  readonly skipped: FoldSkip | null;
  readonly watermark: number;
  /** In order; the caller stops at the first that fails and leaves the rest for later. */
  readonly batches: readonly FoldBatch[];
  /**
   * What the summary's `foldMeter` should hold after this pass. A routine pass that plans
   * batches stamps its reading, whether or not the generation then succeeds; a recovery
   * or manual pass leaves the stamp alone (a recovery acted on the provider's refusal, and
   * stamping the failed meter would disarm the routine fold with it). A routine pass may
   * also retire a stamp without folding. The stamp is only ever written onto a summary
   * that exists — a pass that produced none must not conjure one.
   */
  readonly stamp: FoldMeterStamp | null;
  /** The reading's fullness (0 without one). */
  readonly before: number;
  /** The fullness predicted once every planned batch lands; `before` when nothing is planned. */
  readonly after: number;
}

function chunk(records: readonly FoldRecord[], limit: number): FoldBatch[] {
  const batches: FoldBatch[] = [];
  for (let start = 0; start < records.length && batches.length < limit; start += FOLD_BATCH_MAX_RECORDS) {
    const slice = records.slice(start, start + FOLD_BATCH_MAX_RECORDS);
    batches.push({ ids: slice.map((record) => record.id), throughTurn: Math.max(...slice.map((record) => record.turn)) });
  }
  return batches;
}

/**
 * The oldest-first prefix of `foldable` whose folding frees at least `deficit` replayed
 * tokens — or all of it when even folding everything cannot (the small-window edge: the
 * pressure is somewhere the chronicle cannot reach, so it gives everything it has).
 */
function foldPrefix(costs: readonly TurnCost[], foldable: readonly FoldRecord[], deficit: number, reducible: number): FoldRecord[] {
  if (deficit >= reducible) return [...foldable];
  for (let count = 1; count <= foldable.length; count++) {
    const record = foldable[count - 1];
    if (record !== undefined && historyTokensThrough(costs, record.turn) >= deficit) return foldable.slice(0, count);
  }
  return [...foldable];
}

/** What one fold pass should do. */
export function planFold(input: FoldInput): FoldPlan {
  const { mode, reading, settings } = input;
  const before = reading === null ? 0 : fullness(reading);
  const watermark = foldWatermark(input.currentTurn, settings.lagTurns);
  const skip = (level: FoldPlan["level"], skipped: FoldSkip, stamp: FoldMeterStamp | null = input.stamp): FoldPlan => ({
    level,
    skipped,
    watermark,
    batches: [],
    stamp,
    before,
    after: before,
  });

  let level: FoldPlan["level"];
  let stamp = input.stamp;
  if (mode === "manual") level = "manual";
  else if (mode === "recovery") level = "recovery";
  else {
    if (reading === null || reading.window <= 0) return skip("none", "no_meter");
    level = foldLevel(before, settings);
    // Runs below the trigger too: that is where a fold's effect becomes visible and a
    // stamp that did its job is retired.
    const armed = rearm(input.stamp, reading);
    stamp = armed.stamp;
    if (level === "none") return skip(level, "below_trigger", stamp);
    if (!armed.armed) return skip(level, "disarmed", stamp);
  }

  const remaining = mode === "manual" ? Number.POSITIVE_INFINITY : FOLD_MAX_BATCHES_PER_TURN - Math.max(0, input.batchesSpent);
  if (remaining <= 0) return skip(level, "budget_spent", stamp);

  const foldable = foldableRecords(input.records, watermark);
  if (foldable.length === 0) return skip(level, "nothing_foldable", stamp);
  const reducible = historyTokensThrough(input.replayed, foldable[foldable.length - 1]?.turn ?? 0);
  if (mode !== "manual" && reducible <= 0) return skip(level, "nothing_to_free", stamp);

  // A routine fold folds just enough to reach the floor; a recovery fold has no meter to
  // size against, so it takes the backlog and lets the batch budget decide how much of it
  // this turn pays for; a manual fold takes everything.
  let pending: FoldRecord[];
  if (mode === "routine" && reading !== null) {
    const deficit = Math.max(0, Math.trunc(reading.tokens - settings.floor * reading.window));
    pending = foldPrefix(input.replayed, foldable, deficit, reducible);
  } else {
    pending = foldable;
  }
  const batches = chunk(pending, remaining);
  const through = Math.max(...batches.map((batch) => batch.throughTurn));
  const after = reading !== null && reading.window > 0 ? (reading.tokens - historyTokensThrough(input.replayed, through)) / reading.window : before;
  return {
    level,
    skipped: null,
    watermark,
    batches,
    stamp: mode === "routine" && reading !== null ? { tokens: reading.tokens, estimated: reading.estimated } : stamp,
    before,
    after,
  };
}

// ---------------------------------------------------------------------------
// The fold call's input and result
// ---------------------------------------------------------------------------

/**
 * The engine-side no-future guard, run on the actual fold input right before the
 * generation call: a record beyond the watermark, or one already folded, refuses the whole
 * fold. Batch selection is already past-only; this is the check that does not trust it.
 */
export function validateFoldInput(batch: readonly FoldRecord[], watermark: number): WriteViolation[] {
  const violations: WriteViolation[] = [];
  if (batch.length === 0) violations.push({ code: "empty", path: "" });
  if (batch.length > FOLD_BATCH_MAX_RECORDS) violations.push({ code: "too_many", path: "" });
  for (const record of batch) {
    if (record.turn > watermark) violations.push({ code: "beyond_watermark", path: record.id });
    if (record.folded) violations.push({ code: "already_folded", path: record.id });
  }
  return violations;
}

/**
 * What the fold prompt may contain of each record: its turn and its public line. Never the
 * keeper annotation — a summarizer could copy it into the player-facing summary.
 */
export function foldInputLines(records: readonly ChronicleRecord[]): { readonly turn: number; readonly text: string }[] {
  return records.map((record) => ({ turn: record.turn, text: record.text }));
}

export type FoldResultCode = "empty_batch" | "empty" | "too_long";

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * The summary after a fold call returned `text` for `batch`. Refused when the model wrote
 * nothing or more than the room's `summaryMaxChars` (the previous summary then stays, and
 * the records stay unfolded). The margin and the re-arm stamp carry over untouched; the
 * through-turn never moves backwards — a late-stamped old record folded after newer ones
 * must not make the engine replay turns the summary already covers.
 */
export function applyFold(input: {
  readonly previous: CampaignSummary | null;
  readonly batch: readonly { readonly turn: number }[];
  readonly text: string;
  readonly settings: Pick<FoldSettings, "summaryMaxChars">;
}): { readonly ok: true; readonly data: CampaignSummary } | { readonly ok: false; readonly code: FoldResultCode } {
  if (input.batch.length === 0) return { ok: false, code: "empty_batch" };
  const text = input.text.trim();
  if (text === "") return { ok: false, code: "empty" };
  if (codePoints(text) > Math.min(input.settings.summaryMaxChars, MAX_SUMMARY_CHARS)) return { ok: false, code: "too_long" };
  const previous = input.previous;
  return {
    ok: true,
    data: {
      text,
      throughTurn: Math.max(previous?.throughTurn ?? 0, ...input.batch.map((record) => record.turn)),
      foldCount: (previous?.foldCount ?? 0) + 1,
      keeper: previous?.keeper ?? "",
      foldMeter: previous?.foldMeter ?? null,
    },
  };
}
