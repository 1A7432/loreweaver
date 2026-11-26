import { describe, expect, test } from "bun:test";

import {
  applyFold,
  checkFoldSettings,
  contextReading,
  DEFAULT_FOLD_SETTINGS,
  estimatedReading,
  estimateTokens,
  FOLD_BATCH_MAX_RECORDS,
  FOLD_EMERGENCY,
  FOLD_FLOOR,
  FOLD_LAG_TURNS,
  FOLD_MAX_BATCHES_PER_TURN,
  FOLD_REARM_GROWTH,
  FOLD_TRIGGER,
  foldableRecords,
  foldLevel,
  foldWatermark,
  fullness,
  historyTokensThrough,
  mayReplay,
  measuredReading,
  overflowReading,
  planFold,
  rearm,
  replayable,
  replayCosts,
  validateFoldInput,
  type CampaignSummary,
  type ContextReading,
  type FoldInput,
  type FoldRecord,
  type TurnCost,
} from "../../../src/core/chronicle/index.ts";

const id = (turn: number): string => `c${String(turn).padStart(6, "0")}`;
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function records(turns: readonly number[], folded = false): FoldRecord[] {
  return turns.map((turn) => ({ id: id(turn), turn, folded }));
}

/**
 * Two replayed messages per turn, each of an EXACT token size: a 4N-character ASCII message
 * estimates at exactly N tokens, so folding through turn T frees 2N per seeded turn <= T.
 */
function history(turns: readonly number[], tokensPerMessage: number): TurnCost[] {
  const text = "x".repeat(4 * tokensPerMessage);
  return replayCosts(turns.flatMap((turn) => [{ turn, content: text }, { turn, content: text }]));
}

function input(overrides: Partial<FoldInput>): FoldInput {
  return {
    mode: "routine",
    reading: null,
    currentTurn: 0,
    records: [],
    replayed: [],
    stamp: null,
    batchesSpent: 0,
    settings: DEFAULT_FOLD_SETTINGS,
    ...overrides,
  };
}

const measured = (tokens: number, window: number): ContextReading => measuredReading({ inputTokens: tokens }, window);

describe("the numbers", () => {
  test("the documented policy constants", () => {
    expect([FOLD_TRIGGER, FOLD_FLOOR, FOLD_EMERGENCY, FOLD_LAG_TURNS, FOLD_BATCH_MAX_RECORDS, FOLD_MAX_BATCHES_PER_TURN, FOLD_REARM_GROWTH]).toEqual([
      0.6, 0.4, 0.85, 4, 12, 3, 0.05,
    ]);
    expect(DEFAULT_FOLD_SETTINGS).toEqual({ trigger: 0.6, floor: 0.4, emergency: 0.85, lagTurns: 4, summaryMaxChars: 4000 });
    expect(checkFoldSettings(DEFAULT_FOLD_SETTINGS)).toEqual([]);
  });

  test.each([
    [{ floor: 0.6 }, "bad_order:floor"],
    [{ emergency: 0.5 }, "bad_order:emergency"],
    [{ trigger: 1.2 }, "bad_field:trigger"],
    [{ floor: Number.NaN }, "bad_field:floor"],
    [{ lagTurns: -1 }, "bad_field:lagTurns"],
    [{ summaryMaxChars: 16_001 }, "bad_field:summaryMaxChars"],
  ])("settings %p are refused (%s)", (patch, expected) => {
    expect(checkFoldSettings({ ...DEFAULT_FOLD_SETTINGS, ...patch }).map((v) => `${v.code}:${v.path}`)).toEqual([expected]);
  });

  test.each([
    ["", 0],
    ["abcd", 1],
    ["abcde", 2],
    ["x".repeat(80), 20],
    ["你好", 2],
    ["你好ab", 3],
    ["「戦い」", 4],
    ["ＡＢ", 2],
    ["😀", 1],
    ["😀😀😀😀😀", 2],
    ["한국", 1],
  ])("estimateTokens(%p) = %p", (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });

  test("CJK prose is not under-counted by a Latin characters/4 rule", () => {
    const cjk = "城门在黄昏时关闭了";
    expect(estimateTokens(cjk)).toBe(9);
    expect(estimateTokens(cjk)).toBeGreaterThan(Math.ceil(Array.from(cjk).length / 4));
  });

  test.each([
    [0.59, "none"],
    [0.6, "fold"],
    [0.84, "fold"],
    [0.85, "emergency"],
    [0.99, "emergency"],
    [1, "emergency"],
  ])("fullness %p is level %p", (level, expected) => {
    expect(foldLevel(level, DEFAULT_FOLD_SETTINGS)).toBe(expected as "none");
  });

  test("the watermark keeps the trailing lag window raw", () => {
    expect(foldWatermark(40, 4)).toBe(36);
    expect(foldWatermark(3, 4)).toBe(-1);
    expect(foldableRecords(records(range(1, 10)), foldWatermark(10, 4)).map((r) => r.turn)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("the meter", () => {
  test("no usage reported: the engine's estimate, flagged as such", () => {
    expect(contextReading(undefined, 700, 1000)).toEqual({ tokens: 700, window: 1000, estimated: true });
    expect(contextReading(null, 700, 1000)).toEqual({ tokens: 700, window: 1000, estimated: true });
    expect(contextReading({ inputTokens: 0 }, 700, 1000)).toEqual({ tokens: 700, window: 1000, estimated: true });
  });

  test("a reading that includes cached tokens counts them: a cache changes the cost, not the window", () => {
    const usage = { inputTokens: 700, outputTokens: 10, cachedInputTokens: 650, cacheWriteTokens: 40 };
    const reading = contextReading(usage, 0, 1000);
    expect(reading).toEqual({ tokens: 700, window: 1000, estimated: false });
    expect(fullness(reading)).toBe(0.7);
    expect(foldLevel(fullness(reading), DEFAULT_FOLD_SETTINGS)).toBe("fold");
  });

  test("an overflow reads as the whole window, estimated; no window reads as empty", () => {
    expect(overflowReading(128_000)).toEqual({ tokens: 128_000, window: 128_000, estimated: true });
    expect(fullness(overflowReading(128_000))).toBe(1);
    expect(fullness(measured(500, 0))).toBe(0);
    expect(estimatedReading(-5, Number.NaN)).toEqual({ tokens: 0, window: 0, estimated: true });
  });

  test.each([
    ["no stamp: armed", null, measured(1900, 2000), true, null],
    ["other source: retired, armed", { tokens: 1900, estimated: true }, measured(1950, 2000), true, null],
    ["came down: retired, armed", { tokens: 1900, estimated: false }, measured(1899, 2000), true, null],
    ["unmoved: disarmed, kept", { tokens: 1900, estimated: false }, measured(1900, 2000), false, { tokens: 1900, estimated: false }],
    ["grew 4.95%: disarmed", { tokens: 1900, estimated: false }, measured(1999, 2000), false, { tokens: 1900, estimated: false }],
    ["grew 5%: re-armed, kept", { tokens: 1900, estimated: false }, measured(2000, 2000), true, { tokens: 1900, estimated: false }],
  ] as const)("rearm: %s", (_name, stamp, reading, armed, kept) => {
    expect(rearm(stamp, reading)).toEqual({ armed, stamp: kept });
  });
});

describe("replayed history", () => {
  const messages = [
    { turn: 0, content: "preamble" },
    { turn: 13, content: "a" },
    { turn: 14, content: "b" },
    { turn: 15, content: "c" },
  ];

  test("everything after the summary's through-turn may be replayed; everything when nothing folded", () => {
    expect(replayable(messages, 0).map((m) => m.turn)).toEqual([0, 13, 14, 15]);
    expect(replayable(messages, 14).map((m) => m.turn)).toEqual([15]);
    expect(mayReplay(0, 1)).toBe(false);
    expect(mayReplay(15, 14)).toBe(true);
    expect(mayReplay(14, 14)).toBe(false);
  });

  test("a fold through T frees exactly what replayable then drops", () => {
    const costs = replayCosts(messages.map((m) => ({ ...m, content: m.content.repeat(9) })));
    for (const through of [0, 1, 13, 14, 15, 99]) {
      const kept = replayable(costs, through).reduce((sum, cost) => sum + cost.tokens, 0);
      const all = costs.reduce((sum, cost) => sum + cost.tokens, 0);
      expect(historyTokensThrough(costs, through)).toBe(through <= 0 ? 0 : all - kept);
    }
  });
});

describe("planFold: the reference's hand-derived cases", () => {
  test("at exactly the 0.60 trigger, one batch reaches the 0.40 floor", () => {
    // deficit = 600 - 400 = 200; folding through turn t frees 40*(t-9): t=14 -> 200.
    const plan = planFold(input({ reading: measured(600, 1000), currentTurn: 40, records: records(range(10, 23)), replayed: history(range(10, 23), 20) }));
    expect(plan.level).toBe("fold");
    expect(plan.skipped).toBeNull();
    expect(plan.watermark).toBe(36);
    expect(plan.batches).toEqual([{ ids: range(10, 14).map(id), throughTurn: 14 }]);
    expect(plan.before).toBe(0.6);
    expect(plan.after).toBe(0.4);
    expect(plan.stamp).toEqual({ tokens: 600, estimated: false });
  });

  test("when the history cannot cover the deficit, the fold gives everything, in batches of 12, within 3 per turn", () => {
    // deficit = 1200, whole replayed transcript = 30*10 = 300 < 1200 -> all 30: 12 + 12 + 6.
    const plan = planFold(input({ reading: measured(2000, 2000), currentTurn: 60, records: records(range(10, 39)), replayed: history(range(10, 39), 5) }));
    expect(plan.level).toBe("emergency");
    expect(plan.batches.map((batch) => batch.ids.length)).toEqual([12, 12, 6]);
    expect(plan.batches.map((batch) => batch.throughTurn)).toEqual([21, 33, 39]);
    expect(plan.after).toBe(0.85);
  });

  test("pressure elsewhere: the backlog drains once, then an unmoved meter buys nothing until it grows 5%", () => {
    const first = planFold(input({ reading: measured(1900, 2000), currentTurn: 60, records: records(range(10, 33)), replayed: history(range(10, 33), 5) }));
    expect(first.batches.map((batch) => batch.ids.length)).toEqual([12, 12]);
    expect(first.after).toBe(0.83);
    expect(first.stamp).toEqual({ tokens: 1900, estimated: false });

    const later = { currentTurn: 70, records: [...records(range(10, 33), true), ...records(range(34, 43))], replayed: history(range(34, 43), 5), stamp: first.stamp };
    const second = planFold(input({ ...later, reading: measured(1900, 2000) }));
    expect(second.skipped).toBe("disarmed");
    expect(second.batches).toEqual([]);
    expect(second.stamp).toEqual({ tokens: 1900, estimated: false });

    const grown = planFold(input({ ...later, reading: measured(2000, 2000) }));
    expect(grown.skipped).toBeNull();
    expect(grown.batches.flatMap((batch) => batch.ids)).toEqual(range(34, 43).map(id));
    expect(grown.stamp).toEqual({ tokens: 2000, estimated: false });
  });

  test("sizing tracks replayed history, not record count: a verbose turn alone covers the deficit", () => {
    const replayed = [...history([10], 200), ...history(range(11, 20), 5)];
    const plan = planFold(input({ reading: measured(700, 1000), currentTurn: 30, records: records(range(10, 20)), replayed }));
    // deficit 300; turn 10 alone frees 400.
    expect(plan.batches).toEqual([{ ids: [id(10)], throughTurn: 10 }]);
    expect(plan.after).toBe(0.3);
  });

  test("records sharing a turn fold together: the step is the turn, not the record", () => {
    const shared: FoldRecord[] = [
      { id: "c000002", turn: 5, folded: false },
      { id: "c000001", turn: 5, folded: false },
      { id: "c000003", turn: 6, folded: false },
    ];
    const plan = planFold(input({ reading: measured(650, 1000), currentTurn: 20, records: shared, replayed: history([5, 6], 100) }));
    // deficit 250: through 5 frees 200 (< 250), through 6 frees 400.
    expect(plan.batches).toEqual([{ ids: ["c000001", "c000002", "c000003"], throughTurn: 6 }]);
  });
});

describe("planFold: the edges", () => {
  const busy = { currentTurn: 40, records: records(range(10, 23)), replayed: history(range(10, 23), 20) };

  test("no reading, or no window: a routine fold has no meter and does nothing", () => {
    expect(planFold(input({ ...busy, reading: null })).skipped).toBe("no_meter");
    expect(planFold(input({ ...busy, reading: measured(600, 0) })).skipped).toBe("no_meter");
  });

  test("below the trigger nothing folds, and a stamp whose fold worked is retired there", () => {
    const plan = planFold(input({ ...busy, reading: measured(590, 1000), stamp: { tokens: 800, estimated: false } }));
    expect(plan).toMatchObject({ level: "none", skipped: "below_trigger", batches: [], stamp: null, before: 0.59, after: 0.59 });
  });

  test("an estimated reading folds like a measured one, and stamps itself as estimated", () => {
    const plan = planFold(input({ ...busy, reading: contextReading(undefined, 600, 1000) }));
    expect(plan.batches.length).toBe(1);
    expect(plan.stamp).toEqual({ tokens: 600, estimated: true });
    // The next turn is measured: the estimated stamp is not comparable, so it is retired.
    const next = planFold(input({ ...busy, reading: measured(650, 1000), stamp: plan.stamp }));
    expect(next.skipped).toBeNull();
  });

  test("nothing older than the lag window: nothing folds, even in an emergency or a manual drain", () => {
    for (const mode of ["routine", "manual", "recovery"] as const) {
      const plan = planFold(input({ mode, reading: measured(950, 1000), currentTurn: 10, records: records(range(7, 10)), replayed: history(range(7, 10), 50) }));
      expect(plan.skipped).toBe("nothing_foldable");
    }
  });

  test("a batch never crosses the lag window, and a fold input that does is refused engine-side", () => {
    const plan = planFold(input({ mode: "manual", currentTurn: 10, records: records(range(1, 20)), replayed: history(range(1, 20), 5) }));
    expect(plan.batches.flatMap((batch) => batch.ids)).toEqual(range(1, 6).map(id));
    expect(validateFoldInput(records([4, 5, 6]), 6)).toEqual([]);
    expect(validateFoldInput(records([5, 6, 7]), 6)).toEqual([{ code: "beyond_watermark", path: id(7) }]);
    expect(validateFoldInput(records([5], true), 6)).toEqual([{ code: "already_folded", path: id(5) }]);
    expect(validateFoldInput([], 6)).toEqual([{ code: "empty", path: "" }]);
    expect(validateFoldInput(records(range(1, 13)), 99)).toEqual([{ code: "too_many", path: "" }]);
  });

  test("already-folded records are never planned again", () => {
    const plan = planFold(input({ ...busy, reading: measured(600, 1000), records: [...records(range(10, 12), true), ...records(range(13, 23))] }));
    expect(plan.batches[0]?.ids[0]).toBe(id(13));
  });

  test("nothing replayed left to free: a routine or recovery fold spends no call; a manual one still drains", () => {
    const quiet = { reading: measured(900, 1000), currentTurn: 40, records: records(range(10, 23)), replayed: history(range(30, 36), 20) };
    expect(planFold(input({ ...quiet })).skipped).toBe("nothing_to_free");
    expect(planFold(input({ ...quiet, mode: "recovery" })).skipped).toBe("nothing_to_free");
    expect(planFold(input({ ...quiet, mode: "manual" })).batches.map((batch) => batch.ids.length)).toEqual([12, 2]);
  });

  test("recovery: no meter needed, the backlog up to what this turn's budget has left, the stamp untouched", () => {
    const backlog = { currentTurn: 80, records: records(range(1, 60)), replayed: history(range(1, 60), 5), stamp: { tokens: 123, estimated: false } };
    const fresh = planFold(input({ ...backlog, mode: "recovery" }));
    expect(fresh.level).toBe("recovery");
    expect(fresh.batches.map((batch) => batch.ids.length)).toEqual([12, 12, 12]);
    expect(fresh.stamp).toEqual({ tokens: 123, estimated: false });
    expect(planFold(input({ ...backlog, mode: "recovery", batchesSpent: 1 })).batches.length).toBe(2);
    expect(planFold(input({ ...backlog, mode: "recovery", batchesSpent: 3 })).skipped).toBe("budget_spent");
    expect(planFold(input({ ...backlog, mode: "routine", reading: measured(950, 1000), batchesSpent: 3 })).skipped).toBe("budget_spent");
  });

  test("manual: every foldable record, no batch budget, no meter", () => {
    const plan = planFold(input({ mode: "manual", currentTurn: 80, records: records(range(1, 50)), replayed: history(range(1, 50), 5) }));
    expect(plan.level).toBe("manual");
    expect(plan.batches.map((batch) => batch.ids.length)).toEqual([12, 12, 12, 12, 2]);
    expect(plan.stamp).toBeNull();
  });

  test("the plan is a pure function of its input", () => {
    const given = input({ ...busy, reading: measured(600, 1000) });
    const snapshot = JSON.stringify(given);
    expect(planFold(given)).toEqual(planFold(given));
    expect(JSON.stringify(given)).toBe(snapshot);
  });
});

describe("applying a fold's result", () => {
  const previous: CampaignSummary = { text: "Before.", throughTurn: 14, foldCount: 1, keeper: "margin", foldMeter: { tokens: 600, estimated: false } };

  test("the margin and stamp carry over, the count advances, the through-turn moves forward", () => {
    const result = applyFold({ previous, batch: [{ turn: 15 }, { turn: 18 }], text: "  After. ", settings: DEFAULT_FOLD_SETTINGS });
    expect(result).toEqual({ ok: true, data: { text: "After.", throughTurn: 18, foldCount: 2, keeper: "margin", foldMeter: { tokens: 600, estimated: false } } });
    const first = applyFold({ previous: null, batch: [{ turn: 3 }], text: "First.", settings: DEFAULT_FOLD_SETTINGS });
    expect(first).toEqual({ ok: true, data: { text: "First.", throughTurn: 3, foldCount: 1, keeper: "", foldMeter: null } });
  });

  test("a late-stamped old record never moves the through-turn backwards", () => {
    const result = applyFold({ previous, batch: [{ turn: 9 }], text: "Amended.", settings: DEFAULT_FOLD_SETTINGS });
    expect(result.ok && result.data.throughTurn).toBe(14);
  });

  test("nothing written, or more than the room's limit in code points, is refused", () => {
    expect(applyFold({ previous, batch: [{ turn: 15 }], text: " \n", settings: DEFAULT_FOLD_SETTINGS })).toEqual({ ok: false, code: "empty" });
    expect(applyFold({ previous, batch: [], text: "x", settings: DEFAULT_FOLD_SETTINGS })).toEqual({ ok: false, code: "empty_batch" });
    expect(applyFold({ previous, batch: [{ turn: 15 }], text: "城".repeat(4000), settings: DEFAULT_FOLD_SETTINGS }).ok).toBe(true);
    expect(applyFold({ previous, batch: [{ turn: 15 }], text: "城".repeat(4001), settings: DEFAULT_FOLD_SETTINGS })).toEqual({ ok: false, code: "too_long" });
    expect(applyFold({ previous, batch: [{ turn: 15 }], text: "😀".repeat(4000), settings: DEFAULT_FOLD_SETTINGS }).ok).toBe(true);
  });
});
