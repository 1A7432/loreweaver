import { describe, expect, test } from "bun:test";

import { parseDice } from "../../../src/core/dice/index.ts";
import { ScriptedRandom } from "../../../src/core/random.ts";
import { builtInPacks, compileRulePack, type RulePack } from "../../../src/core/rulepacks/index.ts";
import { newSheet, type Sheet, sheetValue, tableGet, tableWith, tableWithout } from "../../../src/core/sheets/index.ts";
import {
  lossMaximum,
  runImprovementCheck,
  runLossCheck,
  runOpposedCheck,
  runResourceSpend,
  runSubsystem,
  runTableDraw,
  SubsystemCallError,
} from "../../../src/core/subsystems/index.ts";
import { vectorPack } from "../rulepacks/adapter.ts";

const coc: RulePack = builtInPacks()[0]!;
const synth: RulePack = vectorPack("oraclesynth");

/** Draws as `[lo, hi, value]` (step 1). */
function draws(...list: [number, number, number][]): ScriptedRandom {
  return new ScriptedRandom(list.map(([lo, hi, value]) => ({ lo, hi, value, step: 1 })));
}

function vera(pack: RulePack = coc): Sheet {
  return newSheet(pack.sheet, "Vera", pack.id).sheet;
}

function withAttribute(sheet: Sheet, key: string, value: number | null): Sheet {
  return Object.freeze({ ...sheet, attributes: value === null ? tableWithout(sheet.attributes, key) : tableWith(sheet.attributes, key, value) });
}

function withSkill(sheet: Sheet, key: string, value: number): Sheet {
  return Object.freeze({ ...sheet, skills: tableWith(sheet.skills, key, value) });
}

describe("check_with_loss", () => {
  test("a failed check rolls the failure loss and deducts it; the input sheet is untouched", () => {
    const sheet = vera();
    const random = draws([1, 100, 57], [1, 6, 4]);
    const result = runLossCheck(coc, "sanity_check", { sheet, successLoss: "0", failureLoss: "1d6" }, random);
    if (!result.ok) throw new Error(result.refusal);
    expect([result.outcome.rank.id, result.lossFor, result.rolledLoss, result.loss, result.statBefore, result.statAfter, result.statMax]).toEqual(["fail", "failure", 4, 4, 50, 46, 99]);
    expect([result.fumbleRule, result.ceiling, result.writeRefused, random.remaining]).toEqual([null, null, null, 0]);
    expect(tableGet(result.sheet.attributes, "SAN")).toBe(46);
    expect(tableGet(sheet.attributes, "SAN")).toBe(50);
  });

  test("fumble_loss all drains the whole stat (after rolling the loss dice)", () => {
    const result = runLossCheck(coc, "sanity_check", { sheet: vera(), successLoss: "0", failureLoss: "1d6" }, draws([1, 100, 100], [1, 6, 2]));
    if (!result.ok) throw new Error(result.refusal);
    expect([result.outcome.rank.fumble, result.fumbleRule, result.rolledLoss, result.loss, result.statAfter]).toEqual([true, "all", 2, 50, 0]);
  });

  test("fumble_loss max takes the notation's maximum; the ceiling, when its condition holds, caps it last", () => {
    const sheet = vera(synth);
    const plain = runLossCheck(synth, "stress_check", { sheet, successLoss: "0", failureLoss: "2d4+1" }, draws([1, 20, 1], [1, 4, 1], [1, 4, 1]));
    if (!plain.ok) throw new Error(plain.refusal);
    expect([plain.fumbleRule, plain.rolledLoss, plain.loss, plain.ceiling, plain.statBefore, plain.statAfter]).toEqual(["max", 3, 9, null, 3, 0]);
    const safe = runLossCheck(synth, "stress_check", { sheet, successLoss: "0", failureLoss: "2d4+1", tag: "safe" }, draws([1, 20, 1], [1, 4, 1], [1, 4, 1]));
    if (!safe.ok) throw new Error(safe.refusal);
    expect([safe.loss, safe.ceiling, safe.statAfter]).toEqual([2, 2, 1]);
    // The condition also reads the sheet: level 5 caps whatever the tag.
    const veteran = Object.freeze({ ...sheet, fields: tableWith(sheet.fields, "level", 5) });
    const capped = runLossCheck(synth, "stress_check", { sheet: veteran, successLoss: "0", failureLoss: "1d6" }, draws([1, 20, 2], [1, 6, 6]));
    if (!capped.ok) throw new Error(capped.refusal);
    expect([capped.rolledLoss, capped.ceiling, capped.loss]).toEqual([6, 2, 2]);
  });

  test("a ceiling condition that fails to evaluate never caps", () => {
    const pack = compileRulePack(
      "ceil",
      [
        "resolution: {roll: 1d20, ranks: [{id: ok, when: 'roll <= target', success: true}, {id: no}]}",
        "subsystems:",
        "  stress: {template: check_with_loss, stat: S, loss_ceiling: {when: 'stat_data.missing >= 5', value: 0}}",
      ].join("\n"),
    );
    const sheet = Object.freeze({ ...newSheet(pack.sheet, "A", "ceil").sheet, attributes: [["S", 10] as const] });
    const result = runLossCheck(pack, "stress", { sheet, successLoss: "0", failureLoss: "3" }, draws([1, 20, 15]));
    if (!result.ok) throw new Error(result.refusal);
    expect([result.ceiling, result.loss, result.statAfter]).toEqual([null, 3, 7]);
  });

  test("a loss never becomes a gain", () => {
    const result = runLossCheck(coc, "sanity_check", { sheet: vera(), successLoss: "0", failureLoss: "1d4-3" }, draws([1, 100, 70], [1, 4, 1]));
    if (!result.ok) throw new Error(result.refusal);
    expect([result.lossRoll.total, result.rolledLoss, result.statAfter]).toEqual([-2, 0, 50]);
  });

  test("refusals consume no dice", () => {
    const random = draws();
    expect(runLossCheck(coc, "sanity_check", { sheet: vera(), successLoss: "abc", failureLoss: "1d6" }, random)).toMatchObject({ ok: false, refusal: "bad_loss", which: "success" });
    expect(runLossCheck(coc, "sanity_check", { sheet: withAttribute(vera(), "SAN", null), successLoss: "0", failureLoss: "1d6" }, random)).toMatchObject({ refusal: "stat_unset", stat: "SAN" });
    expect(random.consumed).toBe(0);
  });

  test("lossMaximum: plain NdM, NdM + K and constants only", () => {
    const max = (text: string) => lossMaximum(parseDice(text));
    expect([max("2d4+1"), max("d6"), max("3"), max("1D10"), max("1d6+1d6"), max("4d6kh3"), max("1d6-1")]).toEqual([9, 6, 3, 10, null, null, null]);
  });
});

describe("improvement_check", () => {
  test("a skill stored under its storage key is read and written there (信用评级 → 信用)", () => {
    const sheet = withSkill(vera(), "信用", 30);
    const result = runImprovementCheck(coc, "skill_growth", { sheet, skill: "信用评级" }, draws([1, 100, 57], [1, 10, 8]));
    if (!result.ok) throw new Error(result.refusal);
    expect([result.skill, result.before, result.grew, result.after]).toEqual(["信用评级", 30, true, 38]);
    expect(tableGet(result.sheet.skills, "信用")).toBe(38);
    expect(tableGet(result.sheet.skills, "信用评级")).toBeUndefined();
  });

  test("a derived skill grows from its derivation and is kept as a trained value", () => {
    const result = runImprovementCheck(coc, "skill_growth", { sheet: vera(), skill: "闪避" }, draws([1, 100, 57], [1, 10, 8]));
    if (!result.ok) throw new Error(result.refusal);
    expect([result.before, result.after]).toEqual([25, 33]);
    expect(sheetValue(coc.sheet, result.sheet, "闪避")).toEqual({ kind: "value", value: 33, from: "sheet" });
  });

  test("auto_success_above grows even a high skill; growth stops at the cap", () => {
    const sheet = withSkill(vera(), "侦查", 98);
    const result = runImprovementCheck(coc, "skill_growth", { sheet, skill: "spot hidden" }, draws([1, 100, 97], [1, 10, 10]));
    if (!result.ok) throw new Error(result.refusal);
    expect([result.grew, result.after]).toEqual([true, 100]);
    const miss = runImprovementCheck(coc, "skill_growth", { sheet, skill: "侦查" }, draws([1, 100, 95]));
    expect(miss).toMatchObject({ ok: true, grew: false, after: 98, growthRoll: null });
    if (miss.ok) expect(miss.sheet).toBe(sheet);
  });

  test("refusals: at the cap, unknown names, text stats — no dice consumed", () => {
    const random = draws();
    expect(runImprovementCheck(coc, "skill_growth", { sheet: withSkill(vera(), "侦查", 100), skill: "侦查" }, random)).toMatchObject({ refusal: "at_cap", value: 100, cap: 100 });
    expect(runImprovementCheck(coc, "skill_growth", { sheet: vera(), skill: "祖传菜刀" }, random)).toMatchObject({ refusal: "unknown_skill" });
    expect(runImprovementCheck(coc, "skill_growth", { sheet: vera(), skill: "  " }, random)).toMatchObject({ refusal: "unknown_skill" });
    expect(runImprovementCheck(coc, "skill_growth", { sheet: vera(), skill: "职业" }, random)).toMatchObject({ refusal: "not_numeric" });
    expect(random.consumed).toBe(0);
    // A custom skill the sheet itself holds is known.
    const custom = runImprovementCheck(coc, "skill_growth", { sheet: withSkill(vera(), "祖传菜刀", 10), skill: "祖传菜刀" }, draws([1, 100, 50], [1, 10, 2]));
    expect(custom).toMatchObject({ ok: true, before: 10, after: 12 });
  });
});

describe("resource_spend_adjust", () => {
  const check = { skill: "侦查", target: 50, roll: 30 };

  test("lowers the roll, re-grades it, and pays from the stat", () => {
    const result = runResourceSpend(coc, "spend_luck", { sheet: vera(), points: 6, check });
    if (!result.ok) throw new Error(result.refusal);
    expect([result.spend.before.id, result.spend.after.id, result.outcome.margin, result.statBefore, result.statAfter]).toEqual(["regular", "hard", 26, 50, 44]);
    expect(result.check).toEqual({ roll: 24, rawRoll: 30, spent: 6 });
    expect(tableGet(result.sheet.attributes, "LUC")).toBe(44);
  });

  test("a second spend accumulates and keeps the original roll", () => {
    const result = runResourceSpend(coc, "spend_luck", { sheet: vera(), points: 2, check: { ...check, roll: 24, rawRoll: 30, spent: 6 } });
    expect(result).toMatchObject({ ok: true, check: { roll: 22, rawRoll: 30, spent: 8 } });
  });

  test("the house-rule variant and difficulty of the recorded check grade it", () => {
    const result = runResourceSpend(coc, "spend_luck", { sheet: vera(), points: 3, check: { skill: "侦查", target: 60, roll: 5, variant: "dg", difficulty: "hard" } });
    expect(result).toMatchObject({ ok: true, outcome: { rank: { id: "regular" }, effectiveTarget: 30, variant: "dg" } });
  });

  test("the resource's own check and the loss-check stat are ineligible, in any spelling", () => {
    for (const skill of ["luck", "LUC", "幸运", "SAN", "理智", "Sanity"]) {
      expect(runResourceSpend(coc, "spend_luck", { sheet: vera(), points: 1, check: { ...check, skill } })).toMatchObject({ refusal: "ineligible", skill });
    }
  });

  test("refusals, in the order the rules check them", () => {
    const sheet = vera();
    expect(runResourceSpend(coc, "spend_luck", { sheet, points: 0, check })).toMatchObject({ refusal: "invalid_points" });
    expect(runResourceSpend(coc, "spend_luck", { sheet, points: 1.5, check })).toMatchObject({ refusal: "invalid_points" });
    expect(runResourceSpend(coc, "spend_luck", { sheet, points: 51, check: null })).toMatchObject({ refusal: "insufficient", points: 51, available: 50 });
    expect(runResourceSpend(coc, "spend_luck", { sheet, points: 1, check: null })).toMatchObject({ refusal: "no_check" });
    expect(runResourceSpend(coc, "spend_luck", { sheet, points: 1, check: { ...check, roll: 100 } })).toMatchObject({ refusal: "fumble", roll: 100 });
    expect(runResourceSpend(coc, "spend_luck", { sheet, points: 5, check: { ...check, roll: 5 } })).toMatchObject({ refusal: "exceeds_roll", maxPoints: 4 });
    expect(runResourceSpend(coc, "spend_luck", { sheet: withAttribute(sheet, "LUC", null), points: 1, check })).toMatchObject({ refusal: "stat_unset" });
  });
});

describe("opposed", () => {
  test("each side reads its own sheet; equal tiers go to the higher value", () => {
    const npc = withSkill(vera(), "聆听", 60);
    const result = runOpposedCheck(coc, "opposed_check", { active: { skill: "spot hidden", sheet: vera() }, passive: { skill: "listen", sheet: npc } }, draws([1, 100, 20], [1, 100, 50]));
    if (!result.ok) throw new Error(result.refusal);
    expect([result.active.canonical, result.active.value, result.passive.canonical, result.passive.value]).toEqual(["侦查", 25, "聆听", 60]);
    expect([result.active.outcome.rank.tier, result.passive.outcome.rank.tier, result.winner, result.decidedBy]).toEqual([2, 2, "passive", "value"]);
  });

  test("a tie in tier and value is a tie; a better tier wins outright", () => {
    const tie = runOpposedCheck(coc, "opposed_check", { active: { skill: "a", value: 50 }, passive: { skill: "b", value: 50 } }, draws([1, 100, 70], [1, 100, 80]));
    expect(tie).toMatchObject({ ok: true, winner: "tie", decidedBy: null });
    const crit = runOpposedCheck(coc, "opposed_check", { active: { skill: "a", value: 10 }, passive: { skill: "b", value: 90 } }, draws([1, 100, 1], [1, 100, 40]));
    expect(crit).toMatchObject({ ok: true, winner: "active", decidedBy: "tier" });
  });

  test("refusals settle before any roll", () => {
    const random = draws();
    expect(runOpposedCheck(coc, "opposed_check", { active: { skill: "侦查", sheet: vera() }, passive: { skill: "nonesuch", sheet: vera() } }, random)).toMatchObject({ refusal: "unknown_skill", side: "passive" });
    expect(runOpposedCheck(coc, "opposed_check", { active: { skill: "a" }, passive: { skill: "b", value: 1 } }, random)).toMatchObject({ refusal: "unknown_skill", side: "active" });
    expect(runOpposedCheck(coc, "opposed_check", { active: { skill: "a", value: 1.5 }, passive: { skill: "b", value: 1 } }, random)).toMatchObject({ refusal: "invalid_value" });
    expect(random.consumed).toBe(0);
  });
});

describe("table_draw", () => {
  test("by id or alias, the default when none is named, an unknown table refused", () => {
    const temp = runTableDraw(coc, "random_madness", { table: " TEMPORARY " }, draws([1, 8, 3]));
    expect(temp).toMatchObject({ ok: true, table: "temp", index: 2 });
    if (temp.ok) expect(temp.entry.startsWith("暴力倾向")).toBe(true);
    expect(runTableDraw(coc, "random_madness", {}, draws([1, 8, 1]))).toMatchObject({ table: "temp", index: 0 });
    expect(runTableDraw(coc, "random_madness", { table: "总结" }, draws([1, 8, 8]))).toMatchObject({ table: "long", index: 7 });
    expect(runTableDraw(coc, "random_madness", { table: "nope" }, draws())).toEqual({ ok: false, subsystem: "random_madness", refusal: "unknown_table", table: "nope", known: ["temp", "long", "indefinite"] });
  });
});

describe("runSubsystem", () => {
  test("dispatches by the declared template; a wrong id or template is a caller error", () => {
    expect(runSubsystem(coc, "random_madness", { template: "table_draw", table: "long" }, draws([1, 8, 2]))).toMatchObject({ ok: true, table: "long", index: 1 });
    expect(() => runSubsystem(coc, "nope", { template: "table_draw" }, draws())).toThrow(SubsystemCallError);
    expect(() => runSubsystem(coc, "random_madness", { template: "opposed", active: { skill: "a", value: 1 }, passive: { skill: "b", value: 1 } }, draws())).toThrow(
      expect.objectContaining({ code: "WRONG_TEMPLATE" }),
    );
    expect(() => runLossCheck(coc, "spend_luck", { sheet: vera(), successLoss: "0", failureLoss: "0" }, draws())).toThrow(SubsystemCallError);
  });

  test("results are frozen", () => {
    const result = runTableDraw(coc, "random_madness", {}, draws([1, 8, 1]));
    expect(Object.isFrozen(result)).toBe(true);
  });
});
