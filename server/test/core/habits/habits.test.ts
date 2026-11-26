import { describe, expect, test } from "bun:test";

import { actorViewer, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import {
  forgetHabit,
  habitIndex,
  habitKey,
  MAX_HABITS,
  MAX_PENDING,
  NO_HABITS,
  observeHabit,
  PROMOTION_THRESHOLD,
  readTableHabits,
  tableHabitsData,
  tableHabitsDocumentType,
  validateTableHabits,
  type TableHabits,
} from "../../../src/core/habits/index.ts";

function observe(state: TableHabits, summary: string, detail = ""): { habits: TableHabits; promoted: boolean } {
  const change = observeHabit(state, summary, detail);
  if (!change.ok) throw new Error(`refused: ${change.code}`);
  return change.data;
}

describe("table habits", () => {
  test("a candidate is promoted on its third sighting; wording differences in case and punctuation still match", () => {
    expect(PROMOTION_THRESHOLD).toBe(3);
    let step = observe(NO_HABITS, "They lose patience with long combats.", "turn 4");
    expect(step.promoted).toBe(false);
    step = observe(step.habits, "they lose patience with LONG combats");
    expect(step.habits.pending).toEqual([{ summary: "they lose patience with LONG combats", detail: "turn 4", seen: 2 }]);
    step = observe(step.habits, "They lose patience, with long combats!");
    expect(step.promoted).toBe(true);
    expect(step.habits.pending).toEqual([]);
    expect(habitIndex(step.habits)).toEqual(["They lose patience, with long combats!"]);
    const again = observe(step.habits, "they lose patience with long combats");
    expect(again).toEqual({ habits: step.habits, promoted: false });
    expect(habitKey("玩家 喜欢 解谜！")).toBe("玩家喜欢解谜");
  });

  test("refusals: blank, over-long, or promotion into a full index (the candidate keeps its count)", () => {
    expect(observeHabit(NO_HABITS, " !! ")).toEqual({ ok: false, code: "empty", path: "summary" });
    expect(observeHabit(NO_HABITS, "x".repeat(121))).toEqual({ ok: false, code: "too_long", path: "summary" });
    expect(observeHabit(NO_HABITS, "ok", "d".repeat(601))).toEqual({ ok: false, code: "too_long", path: "detail" });
    const full: TableHabits = {
      habits: Array.from({ length: MAX_HABITS }, (_, i) => ({ summary: `habit ${i}`, detail: "", seen: 3 })),
      pending: [{ summary: "new one", detail: "", seen: 2 }],
    };
    expect(observeHabit(full, "new one")).toEqual({ ok: false, code: "habits_full", path: "habits" });
    const room = forgetHabit(full, "habit 0");
    expect(room.ok).toBe(true);
    if (room.ok) expect(observe(room.data, "new one").promoted).toBe(true);
    expect(forgetHabit(full, "never seen")).toEqual({ ok: false, code: "not_found", path: "summary" });
  });

  test("when candidates are full, the oldest unconfirmed one ages out", () => {
    const pending = Array.from({ length: MAX_PENDING }, (_, i) => ({ summary: `candidate ${i}`, detail: "", seen: 1 }));
    const step = observe({ habits: [], pending }, "fresh sighting");
    expect(step.habits.pending.length).toBe(MAX_PENDING);
    expect(step.habits.pending[0]?.summary).toBe("candidate 1");
    expect(step.habits.pending.at(-1)?.summary).toBe("fresh sighting");
  });

  test("round trip and validation", () => {
    const habits: TableHabits = { habits: [{ summary: "Likes puzzles", detail: "", seen: 3 }], pending: [{ summary: "Hates maps", detail: "x", seen: 1 }] };
    const data = tableHabitsData(habits);
    expect(validateTableHabits(data)).toEqual([]);
    expect(readTableHabits(data)).toEqual(habits);
    expect(validateTableHabits({ ...data, extra: [] }).map((v) => v.code)).toEqual(["unknown_field"]);
    expect(validateTableHabits({ habits: [{ summary: "a", detail: "", seen: 0 }], pending: [] }).map((v) => v.path)).toEqual(["habits.0.seen"]);
    expect(readTableHabits({ habits: "nope", pending: [] } as JsonObject)).toEqual(NO_HABITS);
  });
});

describe("who sees table habits", () => {
  test("the Keeper only: a record about the players is never handed back to them, not even redacted", () => {
    const MARK = "LEAKMARK";
    const document: Document = {
      type: tableHabitsDocumentType.name,
      id: "habits",
      version: 1,
      data: tableHabitsData({ habits: [{ summary: `${MARK} flattery fell flat`, detail: MARK, seen: 3 }], pending: [] }),
      meta: {},
      corrupt: false,
    };
    const viewers: Viewer[] = [{ grade: "admin", locale: "en" }, playerViewer("en", "m"), { grade: "observer", locale: "en" }, actorViewer("npc-1", "en")];
    for (const viewer of viewers) expect(tableHabitsDocumentType.project(document, viewer)).toBeNull();
    expect(JSON.stringify(tableHabitsDocumentType.project(document, KEEPER))).toContain(MARK);
  });

  test("lifecycle: survives every reset, and says why", () => {
    const lifecycle = tableHabitsDocumentType.lifecycle;
    expect(lifecycle.reset).toBe("never");
    if (lifecycle.reset === "never") expect(lifecycle.because).toContain("people at this table");
  });
});
