import { describe, expect, test } from "bun:test";

import type { Services } from "../../../src/agent/context.ts";
import {
  FoldBudget,
  type FoldOutcome,
  type FoldRequest,
  type FoldSource,
  isContextOverflow,
  prepareFoldCommit,
  recoveryFold,
  routineFold,
} from "../../../src/agent/lanes/fold.ts";
import {
  type CampaignSummary,
  type ChronicleRecord,
  DEFAULT_FOLD_SETTINGS,
  measuredReading,
  readCampaignSummary,
  readChronicleRecord,
} from "../../../src/core/chronicle/index.ts";
import { currentLane, LLMError, type Responder, type ScriptedReply, ScriptedLLM } from "../../../src/infra/llm/index.ts";

const WINDOW = 10_000;
const CURRENT_TURN = 40;

function record(turn: number, folded = false): ChronicleRecord {
  return { turn, text: `line ${turn}`, characters: [], scene: "", keeper: `KEEPER-ANNOTATION-MARKER-${turn}`, folded };
}

function sources(count: number): FoldSource[] {
  return Array.from({ length: count }, (_, index) => ({ id: `c${String(index + 1).padStart(6, "0")}`, record: record(index + 1) }));
}

const PREVIOUS: CampaignSummary = { text: "So far: the party met Martha.", throughTurn: 0, foldCount: 2, keeper: "MARGIN-MARKER", foldMeter: null };

function models(llm: ScriptedLLM): Pick<Services, "models"> {
  return { models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm } };
}

/** One message of 100 tokens per turn: folding through turn N frees N*100. */
const REPLAYED = Array.from({ length: CURRENT_TURN }, (_, index) => ({ turn: index + 1, tokens: 100 }));

function base(budget: FoldBudget, overrides: Partial<FoldRequest> = {}): FoldRequest {
  return {
    room: "room-1",
    locale: "en",
    previous: PREVIOUS,
    records: sources(36),
    currentTurn: CURRENT_TURN,
    replayed: REPLAYED,
    settings: DEFAULT_FOLD_SETTINGS,
    budget,
    ...overrides,
  };
}

/** A reading whose distance to the floor (0.40) is `deficit` tokens. */
function reading(deficit: number) {
  return measuredReading({ inputTokens: 4_000 + deficit }, WINDOW);
}

function summaries(count: number): ScriptedReply[] {
  return Array.from({ length: count }, (_, index) => `Summary ${index + 1}.`);
}

function prompt(llm: ScriptedLLM, call = 0): string {
  return (llm.calls[call] ?? []).map((message) => message.content).join("\n");
}

/** Lands an outcome on in-memory state, as the caller would through its writer. */
function commit(outcome: FoldOutcome, summary: CampaignSummary | null, records: FoldSource[]): { summary: CampaignSummary | null; records: FoldSource[] } {
  const prepared = prepareFoldCommit(outcome, { summary, records: new Map(records.map((source) => [source.id, source.record])) });
  if (!prepared.ok) throw new Error(prepared.code);
  let next = summary;
  const byId = new Map(records.map((source) => [source.id, source.record]));
  for (const write of prepared.writes) {
    if (write.type === "campaign_summary") next = readCampaignSummary(write.data);
    else byId.set(write.id, readChronicleRecord(write.data) as ChronicleRecord);
  }
  return { summary: next, records: records.map((source) => ({ id: source.id, record: byId.get(source.id) as ChronicleRecord })) };
}

describe("the prompt", () => {
  test("holds turn-and-text lines and the previous summary, never a Keeper annotation or margin", async () => {
    let lane: unknown;
    const llm = new ScriptedLLM(() => {
      lane = currentLane();
      return "Summary 1.";
    });
    const outcome = await routineFold(models(llm), { ...base(new FoldBudget(), { records: sources(10) }), reading: reading(2_000) });
    expect(outcome.calls).toBe(1);
    const [system, user] = llm.calls[0] ?? [];
    expect(system?.content).toContain("write an UPDATED summary of at most 4000 characters");
    expect(user?.content).toStartWith("Previous summary (carry its pivotal facts forward):\nSo far: the party met Martha.\n\nChronicle records to fold in (oldest first):\n- [turn 1] line 1\n- [turn 2] line 2\n");
    expect(user?.content).toEndWith("- [turn 10] line 10\n\nUpdated campaign summary:");
    expect(prompt(llm)).not.toContain("KEEPER-ANNOTATION-MARKER");
    expect(prompt(llm)).not.toContain("MARGIN-MARKER");
    expect(lane).toEqual({ lane: "memory", fields: { room: "room-1", mode: "routine" } });
  });

  test("in the room's locale, with the 'none yet' placeholder for a first fold", async () => {
    const llm = new ScriptedLLM(["总述。"]);
    await routineFold(models(llm), { ...base(new FoldBudget(), { locale: "zh", previous: null, records: sources(10) }), reading: reading(2_000) });
    expect(prompt(llm)).toContain("上一版总述（其中的关键事实必须延续）：\n（暂无）");
    expect(prompt(llm)).toContain("- [第 1 回合] line 1");
  });
});

describe("a routine fold", () => {
  test("returns the new summary, the ids to mark and the texts to index, as data", async () => {
    const llm = new ScriptedLLM(summaries(2));
    const outcome = await routineFold(models(llm), { ...base(new FoldBudget()), reading: reading(2_000) });
    expect(outcome.calls).toBe(2);
    expect(outcome.stopped).toBeNull();
    expect(outcome.folded).toHaveLength(20);
    expect(outcome.index[0]).toEqual({ id: "c000001", text: "line 1", turn: 1 });
    expect(outcome.summary).toEqual({ text: "Summary 2.", throughTurn: 20, foldCount: 4, keeper: "MARGIN-MARKER", foldMeter: { tokens: 6_000, estimated: false } });
    // The second batch built on the first batch's summary.
    expect(prompt(llm, 1)).toContain("Summary 1.");
  });

  test("below the trigger: no call", async () => {
    const llm = new ScriptedLLM([]);
    const outcome = await routineFold(models(llm), { ...base(new FoldBudget()), reading: measuredReading({ inputTokens: 5_000 }, WINDOW) });
    expect(outcome.plan?.skipped).toBe("below_trigger");
    expect(outcome.calls).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("the shared batch budget", () => {
  test("the recovery fold spends only what the routine fold left this turn", async () => {
    const budget = new FoldBudget();
    const llm = new ScriptedLLM(summaries(3));
    let state = { summary: PREVIOUS as CampaignSummary | null, records: sources(36) };

    const routine = await routineFold(models(llm), { ...base(budget, { previous: state.summary, records: state.records }), reading: reading(2_000) });
    expect(routine.calls).toBe(2);
    expect(budget.spent).toBe(2);
    state = commit(routine, state.summary, state.records);

    const recovery = await recoveryFold(models(llm), base(budget, { previous: state.summary, records: state.records }));
    expect(recovery.calls).toBe(1);
    expect(recovery.folded).toHaveLength(12);
    expect(recovery.folded[0]).toBe("c000021");
    expect(budget.spent).toBe(3);
    state = commit(recovery, state.summary, state.records);
    expect(state.summary?.throughTurn).toBe(32);

    const again = await recoveryFold(models(llm), base(budget, { previous: state.summary, records: state.records }));
    expect(again.plan?.skipped).toBe("budget_spent");
    expect(again.calls).toBe(0);
    expect(again.folded).toEqual([]);
    expect(llm.calls).toHaveLength(3);
  });

  test("a recovery fold takes no meter and leaves the re-arm stamp alone", async () => {
    const stamped = { ...PREVIOUS, foldMeter: { tokens: 9_000, estimated: false } };
    const llm = new ScriptedLLM(summaries(3));
    const outcome = await recoveryFold(models(llm), base(new FoldBudget(), { previous: stamped }));
    expect(outcome.calls).toBe(3);
    expect(outcome.folded).toHaveLength(36);
    expect(outcome.meterChanged).toBe(false);
    expect(outcome.summary?.foldMeter).toEqual({ tokens: 9_000, estimated: false });
    expect((await recoveryFold(models(llm), base(new FoldBudget(), { records: [] }))).plan?.skipped).toBe("nothing_foldable");
  });
});

describe("an over-long summary", () => {
  const LONG = "x".repeat(4_010);

  test("is refused, the model is told by how much, and a fitting rewrite lands", async () => {
    const llm = new ScriptedLLM([LONG, "Short summary."]);
    const budget = new FoldBudget();
    const outcome = await routineFold(models(llm), { ...base(budget, { records: sources(10) }), reading: reading(2_000) });
    expect(outcome.calls).toBe(2);
    expect(budget.spent).toBe(2);
    expect(outcome.summary?.text).toBe("Short summary.");
    const retry = llm.calls[1] ?? [];
    expect(retry.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(retry[3]?.content).toContain("4010 characters, 10 over the limit of 4000");
  });

  test("twice too long: folding stops for this turn, nothing lands, the routine stamp is still written", async () => {
    const llm = new ScriptedLLM([LONG, LONG]);
    const outcome = await routineFold(models(llm), { ...base(new FoldBudget(), { records: sources(10) }), reading: reading(2_000) });
    expect(outcome.calls).toBe(2);
    expect(outcome.stopped).toEqual({ code: "too_long", length: 4_010, limit: 4_000 });
    expect(outcome.summary).toBeNull();
    expect(outcome.folded).toEqual([]);
    expect(outcome.meterChanged).toBe(true);
    const prepared = prepareFoldCommit(outcome, { summary: PREVIOUS, records: new Map() });
    expect(prepared).toEqual({
      ok: true,
      writes: [{ type: "campaign_summary", id: "summary", data: { ...PREVIOUS, foldMeter: { tokens: 6_000, estimated: false } } }],
    });
  });

  test("no re-ask when the budget has nothing left", async () => {
    const budget = new FoldBudget();
    budget.take();
    budget.take();
    const llm = new ScriptedLLM([LONG]);
    const outcome = await recoveryFold(models(llm), base(budget));
    expect(outcome.calls).toBe(1);
    expect(outcome.stopped?.code).toBe("too_long");
  });

  test("a re-ask that uses the last call leaves the plan's next batch to a later turn", async () => {
    const llm = new ScriptedLLM([LONG, "Fits.", "Fits again."]);
    const outcome = await recoveryFold(models(llm), base(new FoldBudget()));
    expect(outcome.calls).toBe(3);
    expect(outcome.folded).toHaveLength(24);
    expect(outcome.stopped).toEqual({ code: "budget_spent" });
  });
});

describe("failures never reach the caller", () => {
  test("a failed call ends folding for the turn; what already landed is kept", async () => {
    const llm = new ScriptedLLM(["Summary 1.", { error: new LLMError({ code: "transient", retryable: true }) }]);
    const outcome = await routineFold(models(llm), { ...base(new FoldBudget()), reading: reading(3_000) });
    expect(outcome.calls).toBe(2);
    expect(outcome.stopped).toEqual({ code: "model_failed", llm: "transient" });
    expect(outcome.folded).toHaveLength(12);
    expect(outcome.summary?.text).toBe("Summary 1.");
  });

  test("errors, odd throws, empty and cut-off replies are codes", async () => {
    const run = (reply: ScriptedReply | Responder) =>
      recoveryFold(models(new ScriptedLLM(typeof reply === "function" ? reply : [reply])), base(new FoldBudget()));
    expect((await run({ error: "not even an Error" })).stopped).toEqual({ code: "model_failed", llm: "thrown" });
    expect((await run({ error: new LLMError({ code: "context_overflow", retryable: false }) })).stopped).toEqual({ code: "context_overflow", llm: "context_overflow" });
    expect((await run({ content: "Half a summ", stopReason: "output_cap" })).stopped).toEqual({ code: "output_cap" });
    expect((await run({ content: "", stopReason: "refused" })).stopped).toEqual({ code: "model_refused" });
    expect((await run("   ")).stopped).toEqual({ code: "empty" });
    const aborted = new AbortController();
    aborted.abort();
    const outcome = await recoveryFold(models(new ScriptedLLM(["never"])), base(new FoldBudget(), { signal: aborted.signal }));
    expect(outcome.stopped).toEqual({ code: "aborted" });
    expect(outcome.summary).toBeNull();
  });

  test("a defect inside the lane is a code, not an exception", async () => {
    const broken = new Proxy([], {
      get() {
        throw new Error("defect");
      },
    }) as FoldSource[];
    const outcome = await recoveryFold(models(new ScriptedLLM([])), base(new FoldBudget(), { records: broken }));
    expect(outcome.stopped).toEqual({ code: "internal" });
    expect(outcome.folded).toEqual([]);
  });

  test("a batch the no-future guard refuses makes no call", async () => {
    // Two records under one id: the plan sees the old one, the guard the newest — beyond
    // the watermark, so the whole fold is refused before the call.
    const llm = new ScriptedLLM([]);
    const records = [{ id: "c000001", record: record(1) }, { id: "c000001", record: record(39) }];
    const outcome = await recoveryFold(models(llm), base(new FoldBudget(), { records }));
    expect(outcome.stopped).toEqual({ code: "refused_input" });
    expect(outcome.calls).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("the commit", () => {
  test("is refused when the summary or a record moved meanwhile; the margin is read at commit", async () => {
    const outcome = await recoveryFold(models(new ScriptedLLM(summaries(3))), base(new FoldBudget(), { records: sources(12) }));
    const records = new Map(sources(12).map((source) => [source.id, source.record]));
    expect(prepareFoldCommit(outcome, { summary: { ...PREVIOUS, foldCount: 3 }, records })).toEqual({ ok: false, code: "summary_moved" });
    expect(prepareFoldCommit(outcome, { summary: null, records })).toEqual({ ok: false, code: "summary_moved" });
    const folded = new Map(records);
    folded.set("c000005", record(5, true));
    expect(prepareFoldCommit(outcome, { summary: PREVIOUS, records: folded })).toEqual({ ok: false, code: "record_moved" });

    const edited = prepareFoldCommit(outcome, { summary: { ...PREVIOUS, keeper: "EDITED-MARGIN" }, records });
    if (!edited.ok) throw new Error(edited.code);
    expect(edited.writes).toHaveLength(13);
    expect(edited.writes[0]?.data).toMatchObject({ text: "Summary 1.", keeper: "EDITED-MARGIN", throughTurn: 12 });
    expect(edited.writes[1]).toEqual({ type: "chronicle_record", id: "c000001", data: { ...record(1, true), characters: [] } });
  });
});

test("isContextOverflow: the provider's refusal or the window, never the output cap", () => {
  expect(isContextOverflow(new LLMError({ code: "context_overflow", retryable: false }))).toBe(true);
  expect(isContextOverflow(new LLMError({ code: "bad_request", retryable: false }))).toBe(false);
  expect(isContextOverflow({ content: "", toolCalls: [], stopReason: "context_window" })).toBe(true);
  expect(isContextOverflow({ content: "", toolCalls: [], stopReason: "output_cap" })).toBe(false);
  expect(isContextOverflow(new Error("x"))).toBe(false);
});
