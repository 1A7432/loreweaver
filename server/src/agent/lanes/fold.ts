// The chronicle fold lane: the model call that rewrites the campaign's rolling summary
// when the context fills, built around the finished policy in `core/chronicle`.
//
// Two entry points share ONE per-turn budget of model calls (`FoldBudget`, at most
// `FOLD_MAX_BATCHES_PER_TURN`):
//   - `routineFold`, before the Keeper's prompt is assembled, driven by the meter;
//   - `recoveryFold`, after a provider refused the Keeper's prompt as too long
//     (`isContextOverflow`). It spends what the routine fold left, so a turn that already
//     folded and still overflowed does not get a fresh allowance — the per-turn call count
//     stays where AGENTS.md says it is.
// Each batch is one model call; a failed call ends folding for this turn, and nothing is
// ever thrown into the turn.
//
// The prompt holds the previous summary and, per record, its turn and its public line
// (`foldInputLines`) — never a record's Keeper annotation, which a summarizer could copy
// into the player-facing summary. Text: the 2.6 prompt, verbatim, `server/locales/*/fold.json`.
//
// Over-long summaries. `applyFold` refuses a summary over the room's cap instead of
// cutting it (the 2.6 server cut at a paragraph boundary — silently losing whatever came
// last, typically the newest events). This lane keeps the refusal and asks the model ONCE
// more, telling it by how many characters it was over; that second call is charged to the
// same budget. If it is still over (or no budget is left), folding stops for this turn and
// the outcome says so; the records stay unfolded and the previous summary stays. The
// policy's re-arm is the safety net: a routine fold that planned batches stamps the meter
// whether or not the generation landed, so a room cannot buy a failing fold every turn.
//
// Everything is returned as DATA. The caller, in one synchronous stretch inside the turn,
// re-reads the summary and the records and runs `prepareFoldCommit`, writes what it
// returns through its writer, and only afterwards embeds `index` (the folded records'
// public lines) into the chronicle's vector collection.
import type { JsonObject } from "../../core/documents/model.ts";
import {
  applyFold,
  CAMPAIGN_SUMMARY_ID,
  CAMPAIGN_SUMMARY_TYPE,
  type CampaignSummary,
  campaignSummaryData,
  CHRONICLE_RECORD_TYPE,
  type ChronicleRecord,
  chronicleRecordData,
  type ContextReading,
  FOLD_MAX_BATCHES_PER_TURN,
  foldInputLines,
  type FoldMeterStamp,
  type FoldPlan,
  type FoldRecord,
  type FoldSettings,
  markRecordFolded,
  MAX_SUMMARY_CHARS,
  planFold,
  stampFoldMeter,
  type TurnCost,
  validateFoldInput,
} from "../../core/chronicle/index.ts";
import { translate } from "../../infra/i18n.ts";
import { type ChatMessage, type ChatResult, LLMError, type LLMErrorCode, withLane } from "../../infra/llm/index.ts";
import type { Services } from "../context.ts";
import { FOLD_CATALOG } from "./fold_catalog.ts";

export const FOLD_LANE = "memory";

/**
 * This turn's fold calls. Make ONE per turn and hand the same one to both entry points:
 * that is what makes the recovery fold spend what the routine fold left.
 */
export class FoldBudget {
  #spent = 0;

  /** Model calls made this turn by either entry point. */
  get spent(): number {
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, FOLD_MAX_BATCHES_PER_TURN - this.#spent);
  }

  /** Takes one call from the budget; false (and nothing taken) when none is left. */
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.#spent++;
    return true;
  }
}

/**
 * Whether a Keeper call ended because the prompt did not fit: a provider error classified
 * `context_overflow`, or a reply that stopped at the context window (defensive pattern 6 —
 * the output cap is NOT this, and folding would not help it).
 */
export function isContextOverflow(outcome: unknown): boolean {
  if (outcome instanceof LLMError) return outcome.code === "context_overflow";
  if (typeof outcome === "object" && outcome !== null && "stopReason" in outcome) {
    return (outcome as Pick<ChatResult, "stopReason">).stopReason === "context_window";
  }
  return false;
}

/** A stored chronicle record with its document id. */
export interface FoldSource {
  readonly id: string;
  readonly record: ChronicleRecord;
}

export interface FoldRequest {
  /** For the call's accounting. */
  readonly room: string;
  /** The room's locale: the fold prompt is written in it. */
  readonly locale: string;
  /** The stored summary, or null when the room has none yet. */
  readonly previous: CampaignSummary | null;
  /** The room's chronicle records (folded ones included; the policy skips them). */
  readonly records: readonly FoldSource[];
  /** The room's count of completed turns. */
  readonly currentTurn: number;
  /** The history being replayed now, already without what the summary covers. */
  readonly replayed: readonly TurnCost[];
  readonly settings: FoldSettings;
  readonly budget: FoldBudget;
  readonly signal?: AbortSignal;
}

export interface RoutineFoldRequest extends FoldRequest {
  /** The last completed turn's reading; null in a fresh room. */
  readonly reading: ContextReading | null;
}

export type FoldStop =
  /** The plan's batches did not all fit what is left of this turn's budget. */
  | "budget_spent"
  /** The engine-side no-future guard refused a batch (or a planned id was missing). */
  | "refused_input"
  /** The model call failed; `llm` holds the error's code. */
  | "model_failed"
  | "aborted"
  /** The fold call itself did not fit the memory model's window. */
  | "context_overflow"
  | "model_refused"
  /** The reply stopped at the output cap: an incomplete summary is not landed. */
  | "output_cap"
  | "empty"
  /** Over the cap twice (or once with no budget left for the re-ask): see `length`/`limit`. */
  | "too_long"
  /** A defect in this lane; nothing is written. */
  | "internal";

/** A folded record's public line, for the caller to embed for recall by meaning. */
export interface FoldIndexText {
  readonly id: string;
  readonly text: string;
  readonly turn: number;
}

export interface FoldOutcome {
  readonly mode: "routine" | "recovery";
  readonly plan: FoldPlan | null;
  /** Model calls made by this pass (already taken from the budget). */
  readonly calls: number;
  /** The summary this pass built on, to check at commit that nobody else folded meanwhile. */
  readonly base: { readonly throughTurn: number; readonly foldCount: number } | null;
  /** The new summary when at least one batch landed (its `foldMeter` is the plan's stamp). */
  readonly summary: CampaignSummary | null;
  /** Ids of the records to mark folded, oldest first. */
  readonly folded: readonly string[];
  readonly index: readonly FoldIndexText[];
  /** What the summary's re-arm stamp should hold after this pass. */
  readonly meter: FoldMeterStamp | null;
  /** Whether `meter` differs from the stamp the pass started from. */
  readonly meterChanged: boolean;
  /** Why folding stopped before the plan's end; null when it ran to the end (or planned nothing). */
  readonly stopped: {
    readonly code: FoldStop;
    readonly llm?: LLMErrorCode | "thrown";
    /** For `too_long`: the last reply's length and the cap, in code points. */
    readonly length?: number;
    readonly limit?: number;
  } | null;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function sameStamp(left: FoldMeterStamp | null, right: FoldMeterStamp | null): boolean {
  if (left === null || right === null) return left === right;
  return left.tokens === right.tokens && left.estimated === right.estimated;
}

/** The share of the summary cap the model is asked to stay within; the cap itself is what is refused. */
export const SUMMARY_TARGET_RATIO = 0.85;

/** The re-ask after an over-long summary. Text for the model: English, kept with the code. */
function tooLongMessage(length: number, limit: number): string {
  return (
    `Your summary is ${length} characters, ${length - limit} over the limit of ${limit}. ` +
    `Rewrite it in at most ${limit} characters, keeping every pivotal fact. Output only the summary text.`
  );
}

function foldMessages(locale: string, previous: CampaignSummary | null, batch: readonly ChronicleRecord[], limit: number): ChatMessage[] {
  const t = (key: string, params: Readonly<Record<string, string | number>> = {}): string => translate(FOLD_CATALOG, locale, key, params);
  const records = foldInputLines(batch)
    .map((line) => t("prompt.chronicle.record_line", { turn: line.turn, text: line.text.trim() }))
    .join("\n");
  const previousText = previous?.text.trim() ?? "";
  return [
    { role: "system", content: t("prompt.chronicle.fold_instruction", { limit }) },
    { role: "user", content: t("prompt.chronicle.fold_user_template", { previous: previousText || t("prompt.chronicle.none_yet"), records }) },
  ];
}

type Call = { ok: true; result: ChatResult } | { ok: false; code: FoldStop; llm?: LLMErrorCode | "thrown" };

async function call(services: Pick<Services, "models">, request: FoldRequest, mode: string, messages: readonly ChatMessage[]): Promise<Call> {
  try {
    const result = await withLane(
      FOLD_LANE,
      () => services.models.memory.chat(messages, request.signal === undefined ? {} : { signal: request.signal }),
      { room: request.room, mode },
    );
    if (result.stopReason === "context_window") return { ok: false, code: "context_overflow" };
    if (result.stopReason === "refused") return { ok: false, code: "model_refused" };
    if (result.stopReason === "output_cap") return { ok: false, code: "output_cap" };
    return { ok: true, result };
  } catch (error) {
    if (request.signal?.aborted === true || (error instanceof LLMError && error.code === "aborted")) return { ok: false, code: "aborted" };
    if (error instanceof LLMError) return { ok: false, code: error.code === "context_overflow" ? "context_overflow" : "model_failed", llm: error.code };
    return { ok: false, code: "model_failed", llm: "thrown" };
  }
}

type BatchResult = { ok: true; summary: CampaignSummary } | { ok: false; stop: NonNullable<FoldOutcome["stopped"]> };

/** One batch: one call, and at most one re-ask when the summary came back too long. */
async function foldBatch(
  services: Pick<Services, "models">,
  request: FoldRequest,
  mode: string,
  previous: CampaignSummary | null,
  batch: readonly ChronicleRecord[],
  counter: { calls: number },
): Promise<BatchResult> {
  const limit = Math.min(request.settings.summaryMaxChars, MAX_SUMMARY_CHARS);
  // The model is ASKED for less than is accepted. A model does not count characters; told
  // "at most 4,000" a live one wrote 4,060-4,550, and re-asked it landed on 4,002 and 4,031
  // - refused by a hair, turn after turn, so the fold stopped landing and the context grew
  // again. Asking for the target and accepting up to the cap gives it room to miss.
  const target = Math.max(1, Math.floor(limit * SUMMARY_TARGET_RATIO));
  const messages = foldMessages(request.locale, previous, batch, target);
  let asked = false;
  for (;;) {
    if (!request.budget.take()) return { ok: false, stop: { code: "budget_spent" } };
    counter.calls++;
    const reply = await call(services, request, mode, messages);
    if (!reply.ok) return { ok: false, stop: reply.llm === undefined ? { code: reply.code } : { code: reply.code, llm: reply.llm } };
    const applied = applyFold({ previous, batch, text: reply.result.content, settings: request.settings });
    if (applied.ok) return { ok: true, summary: applied.data };
    if (applied.code !== "too_long") return { ok: false, stop: { code: "empty" } };
    const length = codePoints(reply.result.content.trim());
    if (asked || request.budget.remaining <= 0) return { ok: false, stop: { code: "too_long", length, limit } };
    asked = true;
    messages.push({ role: "assistant", content: reply.result.content }, { role: "user", content: tooLongMessage(length, target) });
  }
}

async function runFold(services: Pick<Services, "models">, request: FoldRequest, mode: "routine" | "recovery", reading: ContextReading | null): Promise<FoldOutcome> {
  const startStamp = request.previous?.foldMeter ?? null;
  const base = request.previous === null ? null : { throughTurn: request.previous.throughTurn, foldCount: request.previous.foldCount };
  const counter = { calls: 0 };
  const empty = (plan: FoldPlan | null, stopped: FoldOutcome["stopped"]): FoldOutcome => ({
    mode,
    plan,
    calls: counter.calls,
    base,
    summary: null,
    folded: [],
    index: [],
    meter: plan?.stamp ?? startStamp,
    meterChanged: plan !== null && !sameStamp(plan.stamp, startStamp),
    stopped,
  });
  try {
    const byId = new Map<string, ChronicleRecord>();
    for (const source of request.records) byId.set(source.id, source.record);
    const plan = planFold({
      mode,
      reading,
      currentTurn: request.currentTurn,
      records: request.records.map((source): FoldRecord => ({ id: source.id, turn: source.record.turn, folded: source.record.folded })),
      replayed: request.replayed,
      stamp: startStamp,
      batchesSpent: request.budget.spent,
      settings: request.settings,
    });

    let summary = request.previous;
    let landed = false;
    const folded: string[] = [];
    const index: FoldIndexText[] = [];
    let stopped: FoldOutcome["stopped"] = null;
    for (const batch of plan.batches) {
      const records: ChronicleRecord[] = [];
      const policyView: FoldRecord[] = [];
      for (const id of batch.ids) {
        const record = byId.get(id);
        if (record === undefined) break;
        records.push(record);
        policyView.push({ id, turn: record.turn, folded: record.folded });
      }
      if (records.length !== batch.ids.length || validateFoldInput(policyView, plan.watermark).length > 0) {
        stopped = { code: "refused_input" };
        break;
      }
      const result = await foldBatch(services, request, mode, summary, records, counter);
      if (!result.ok) {
        stopped = result.stop;
        break;
      }
      summary = result.summary;
      landed = true;
      batch.ids.forEach((id, position) => {
        const record = records[position] as ChronicleRecord;
        folded.push(id);
        index.push({ id, text: record.text, turn: record.turn });
      });
    }
    if (!landed || summary === null) return empty(plan, stopped);
    return {
      mode,
      plan,
      calls: counter.calls,
      base,
      summary: stampFoldMeter(summary, plan.stamp),
      folded,
      index,
      meter: plan.stamp,
      meterChanged: !sameStamp(plan.stamp, startStamp),
      stopped,
    };
  } catch {
    // The policy and the prompt builders are total; reaching here is a defect, and a
    // defect in the fold must not cost the turn.
    return empty(null, { code: "internal" });
  }
}

/** The per-turn fold, before the Keeper's prompt is assembled. Never throws. */
export function routineFold(services: Pick<Services, "models">, request: RoutineFoldRequest): Promise<FoldOutcome> {
  return runFold(services, request, "routine", request.reading);
}

/**
 * The fold after the provider refused the Keeper's prompt as too long. Takes no meter (it
 * was just proven wrong) and leaves the re-arm stamp alone; spends only what is left of
 * `request.budget`. No folded record means no progress: the caller must not re-send then.
 * Never throws.
 */
export function recoveryFold(services: Pick<Services, "models">, request: FoldRequest, reading: ContextReading | null = null): Promise<FoldOutcome> {
  return runFold(services, request, "recovery", reading);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/** One document write for the caller's writer, in order. */
export interface FoldWrite {
  readonly type: string;
  readonly id: string;
  readonly data: JsonObject;
}

export type FoldCommit =
  | { readonly ok: true; readonly writes: readonly FoldWrite[] }
  /**
   * `summary_moved`: the stored summary is no longer the one the fold built on.
   * `record_moved`: a record to mark is gone or already folded. Nothing is written then.
   */
  | { readonly ok: false; readonly code: "summary_moved" | "record_moved" };

/**
 * The writes that land a fold, computed against the state read NOW, in the caller's
 * synchronous commit stretch (the lane held nothing across its model calls). The Keeper's
 * margin is taken from the current summary, so an edit made while the call ran survives.
 * The summary is written first, then each record marked folded. With no new summary, a
 * changed re-arm stamp is written onto the existing summary, if there is one (a pass that
 * produced no summary never conjures one).
 */
export function prepareFoldCommit(
  outcome: FoldOutcome,
  current: { readonly summary: CampaignSummary | null; readonly records: ReadonlyMap<string, ChronicleRecord> },
): FoldCommit {
  if (outcome.summary === null) {
    if (!outcome.meterChanged || current.summary === null) return { ok: true, writes: [] };
    const stamped = stampFoldMeter(current.summary, outcome.meter);
    return { ok: true, writes: [{ type: CAMPAIGN_SUMMARY_TYPE, id: CAMPAIGN_SUMMARY_ID, data: campaignSummaryData(stamped) }] };
  }
  const now = current.summary;
  const base = outcome.base;
  const unchanged = base === null ? now === null : now !== null && now.throughTurn === base.throughTurn && now.foldCount === base.foldCount;
  if (!unchanged) return { ok: false, code: "summary_moved" };
  const writes: FoldWrite[] = [
    {
      type: CAMPAIGN_SUMMARY_TYPE,
      id: CAMPAIGN_SUMMARY_ID,
      data: campaignSummaryData({ ...outcome.summary, keeper: now?.keeper ?? outcome.summary.keeper }),
    },
  ];
  for (const id of outcome.folded) {
    const record = current.records.get(id);
    if (record === undefined || record.folded) return { ok: false, code: "record_moved" };
    writes.push({ type: CHRONICLE_RECORD_TYPE, id, data: chronicleRecordData(markRecordFolded(record)) });
  }
  return { ok: true, writes };
}
