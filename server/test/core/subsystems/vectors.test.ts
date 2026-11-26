// The `rules_subsystems` reference rows, through the pure subsystem flows.
//
// Each row was recorded through the 2.x Keeper tool (`dispatch_subsystem`), so it holds
// the tool's localized reply TEXT next to the dice, the sheet before and after, the dice
// frames and the session record. The text is not reproduced (results are data); the facts
// in it are compared against the structured result instead: outcome, rolls, values, loss,
// ceiling, remaining value and maximum, winner and tie-break, table and entry, refusal
// kinds and their numbers. Every row replays its recorded draws, and must consume exactly
// those, except where noted below.
//
// Not compared, and why:
// - `player_stats` (the session tally) and the session bookkeeping fields of
//   `skill_checks` (`user_id`, `char_name`, `label`): the caller keeps the session record.
// - `dice_payloads[].expr` / `subsystem_label` and every localized label: callers localize
//   (the rank labels the replies print ARE checked against the pack's labels).
// - The one row per template recorded with no active character: choosing the character
//   is the caller's.
//
// Rows answered differently ON PURPOSE (counted per reason; the counts are pinned):
// - check_with_loss, a loss notation that does not parse (`abc`): refused before anything
//   is rolled, whichever outcome would have needed it. The 2.x tool rolled the check first,
//   then failed on the loss roll (and, when the check succeeded with a valid
//   `success_loss`, never noticed the bad `failure_loss` at all).
// - improvement_check, an unknown skill name (`祖传菜刀`, the empty name): refused. 2.x
//   rolled it as a skill of 0, which always grows, and added a new skill to the sheet.
// - improvement_check, the rows that encode the 2.x storage-bridge bug: 2.x read and
//   wrote `skills[<canonical name>]` past the sheet layer, so growing `信用评级` read 0 and
//   added a second skill next to the real `信用`, growing `lore` ignored `LORE`, and a
//   derived skill (`闪避`, `母语`, `athletics`) read 0 instead of its derivation. The flow
//   reads and writes through the sheet layer; these rows are checked to consume a prefix of
//   the recorded draws and to grow the right slot (the corrected behaviour is pinned in
//   `subsystems.test.ts`).
// - opposed, a side whose value 2.x read differently: the passive side's skill was read
//   from the raw skills table with a default of 50 (`体操=50` on a sheet whose 体操 derives
//   to 1, `unknown skill=50`), and an unknown active skill read 0. The flow resolves both
//   sides through the sheet layer and refuses an unknown skill. Such rows are checked for
//   the refusal or the corrected value, then re-run with the 2.x values stated explicitly
//   and compared in full.
// - opposed in a meet-the-target pack (resolution `compare: ">="`: dnd5e, and the literal
//   `oraclesynth`): settled by TOTAL, as the SRD's contests are ("instead of comparing the
//   total to a DC, they compare the totals of their two checks"; a tie leaves things as
//   they were). 2.x graded each side with its own value as the DC (`运动=3` rolled 17 →
//   success). These rows replay their recorded draws unchanged — one d20 per side, the
//   same faces — and the NEW result is asserted directly: totals = dice + value, no rank,
//   higher total wins; the summary counts how often the winner changed.
import { describe, expect, test } from "bun:test";

import { rankDisplay, tableName } from "../../../src/core/rulepacks/index.ts";
import { evaluateSheet, resolveName, type Sheet, sheetValue, type SheetSpec, tableGet } from "../../../src/core/sheets/index.ts";
import {
  lookupStat,
  runImprovementCheck,
  runLossCheck,
  runOpposedCheck,
  runResourceSpend,
  runTableDraw,
  type SubsystemTemplate,
} from "../../../src/core/subsystems/index.ts";
import { readReference } from "../../reference.ts";
import { vectorPack } from "../rulepacks/adapter.ts";
import type { Json } from "../sheets/adapter.ts";
import { type FlowRow, legacyOf, numbersIn, pyInt, scripted, sheetOf, skip, tally } from "./adapter.ts";

const rows = readReference<FlowRow>("rules_subsystems");

function rowsOf(template: SubsystemTemplate): FlowRow[] {
  return rows.filter((row) => vectorPack(row.pack).subsystems.get(row.subsystem)?.template === template);
}

function outcomeDict(outcome: { rank: { id: string; tier: number; success: boolean; critical: boolean; fumble: boolean }; margin: number | null }) {
  const { id, tier, success, critical, fumble } = outcome.rank;
  return { id, tier, success, critical, fumble, margin: outcome.margin };
}

test("every row is a flow the dispatcher completed", () => {
  expect(rows.length).toBe(1337);
  expect(rows.every((row) => row.kind === "flow" && row.error === null)).toBe(true);
  expect(rows.every((row) => vectorPack(row.pack).subsystems.has(row.subsystem))).toBe(true);
});

describe("check_with_loss (sanity_check, stress_check)", () => {
  test("every row", () => {
    const t = tally();
    for (const row of rowsOf("check_with_loss")) {
      const pack = vectorPack(row.pack);
      if (row.sheet_before === null) {
        skip(t, "no active character");
        continue;
      }
      const sheet = sheetOf(pack.sheet, row.sheet_before);
      expect(legacyOf(pack.sheet, sheet)).toEqual(row.sheet_before);
      const args = row.arguments;
      const random = scripted(row.draws);
      const result = runLossCheck(
        pack,
        row.subsystem,
        { sheet, successLoss: String(args.success_loss ?? "0"), failureLoss: String(args.failure_loss ?? "0"), tag: String(args.tag ?? ""), variant: row.variant },
        random,
      );
      const label = `${row.subsystem} ${JSON.stringify(args)} ${JSON.stringify(row.draws)}`;
      if (!result.ok) {
        expect([label, result.refusal, random.consumed]).toEqual([label, "bad_loss", 0]);
        expect(row.sheet_after).toEqual(row.sheet_before);
        skip(t, /Invalid dice expression/.test(row.reply) ? "bad loss notation (2.x rolled, then failed)" : "bad loss notation (2.x never rolled it)");
        continue;
      }
      expect([label, random.remaining]).toEqual([label, 0]);
      const payload = row.dice_payloads[0] as Record<string, Json>;
      const detail = payload.detail as Record<string, Json>;
      const record = (row.skill_checks ?? [])[0] as Record<string, Json>;
      expect<unknown[]>([label, result.check.total, result.statBefore, result.outcome.effectiveTarget]).toEqual([label, payload.total, payload.target, payload.effective_target]);
      const { label: _shown, ...outcome } = payload.outcome as Record<string, Json>;
      expect(outcomeDict(result.outcome)).toEqual(outcome as ReturnType<typeof outcomeDict>);
      const expectedDetail: Record<string, Json> = { loss: result.loss, loss_expr: result.lossNotation, remaining: result.statAfter };
      if (result.ceiling !== null) expectedDetail.loss_ceiling = result.ceiling;
      if (result.statMax) expectedDetail.resource_max = result.statMax;
      expect([label, detail]).toEqual([label, expectedDetail]);
      expect({
        skill: record.skill,
        roll: record.roll,
        target: record.target,
        rank_id: record.rank_id,
        tier: record.tier,
        success: record.success,
        loss: record.loss,
        loss_expr: record.loss_expr,
        stat_before: record.stat_before,
        stat_after: record.stat_after,
        loss_ceiling: record.loss_ceiling ?? null,
        variant: record.variant ?? null,
      }).toEqual({
        skill: result.stat,
        roll: result.check.total,
        target: result.statBefore,
        rank_id: result.outcome.rank.id,
        tier: result.outcome.rank.tier,
        success: result.outcome.rank.success,
        loss: result.loss,
        loss_expr: result.lossNotation,
        stat_before: result.statBefore,
        stat_after: result.statAfter,
        loss_ceiling: result.ceiling,
        variant: row.variant,
      });
      // The facts the reply printed: the result line's rank label, the no-cost line (a
      // failure that cost nothing, no ceiling involved), the loss roll's total, the
      // remaining value over the maximum.
      const lines = row.reply.split("\n");
      expect(lines[2]!.endsWith(rankDisplay(pack, result.outcome.rank.id, row.locale))).toBe(true);
      const noCost = !result.outcome.rank.success && result.loss === 0 && result.ceiling === null;
      const lossLine = lines[3]!;
      expect([label, /declared failure cost|声明的失败代价/.test(lossLine)]).toEqual([label, noCost]);
      if (!noCost) expect(numbersIn(lossLine).at(-1)).toBe(result.lossRoll.total);
      expect(numbersIn(lines.at(-1)!).slice(-2)).toEqual([result.statAfter, result.statMax ?? 0]);
      expect(legacyOf(pack.sheet, result.sheet)).toEqual(row.sheet_after as Record<string, Json>);
      t.compared++;
    }
    expect(t).toEqual({
      compared: 804,
      skipped: { "no active character": 1, "bad loss notation (2.x rolled, then failed)": 37, "bad loss notation (2.x never rolled it)": 11 },
    });
  });
});

/** How the 2.x tool read the skill: canonical name (or the raw text) straight from the skills table, 0 when absent. */
function legacySkillRead(spec: SheetSpec, sheet: Sheet, typed: string): { name: string; value: number } {
  const name = resolveName(spec, typed) ?? typed;
  return { name, value: tableGet(sheet.skills, name) ?? 0 };
}

describe("improvement_check (skill_growth, grow)", () => {
  test("every row", () => {
    const t = tally();
    for (const row of rowsOf("improvement_check")) {
      const pack = vectorPack(row.pack);
      if (row.sheet_before === null) {
        skip(t, "no active character");
        continue;
      }
      const sheet = sheetOf(pack.sheet, row.sheet_before);
      const typed = String(row.arguments.skill_name ?? "");
      const random = scripted(row.draws);
      const result = runImprovementCheck(pack, row.subsystem, { sheet, skill: typed }, random);
      const label = `${row.subsystem} ${JSON.stringify(typed)} ${JSON.stringify(row.draws)}`;
      const legacy = legacySkillRead(pack.sheet, sheet, typed);
      const found = lookupStat(pack.sheet, sheet, typed, false);

      if (!found.ok) {
        expect([label, result.ok ? null : result.refusal, random.consumed]).toEqual([label, "unknown_skill", 0]);
        // 2.x grew it from 0 into a new skill entry.
        expect((row.sheet_after!.skills as Record<string, Json>)[legacy.name]).toBeGreaterThan(0);
        skip(t, "unknown skill refused (2.x grew it from 0)");
        continue;
      }
      const slot = pack.sheet.shape?.skillKeys.get(found.canonical);
      if (found.value !== legacy.value || (slot !== undefined && slot !== legacy.name)) {
        // The 2.x storage-bridge bug: see the header. The flow consumed a prefix of the
        // recorded draws and wrote the canonical name's own slot.
        if (!result.ok) {
          // The real slot is at the cap already (`LORE` 20 of 20), where 2.x read 0.
          expect([label, result.refusal, random.consumed]).toEqual([label, "at_cap", 0]);
          skip(t, "2.x storage-bridge bug (read/wrote past the sheet layer)");
          continue;
        }
        expect([label, result.before]).toEqual([label, found.value]);
        if (result.grew) expect(sheetValue(pack.sheet, result.sheet, found.canonical)).toEqual({ kind: "value", value: result.after, from: "sheet" });
        else expect(result.sheet).toBe(sheet);
        skip(t, "2.x storage-bridge bug (read/wrote past the sheet layer)");
        continue;
      }

      expect([label, random.remaining]).toEqual([label, 0]);
      const lines = row.reply.split("\n");
      if (!result.ok) {
        expect(result.refusal).toBe("at_cap");
        if (result.refusal !== "at_cap") continue;
        expect(numbersIn(lines[0]!)).toEqual([result.value]);
        expect(row.sheet_after).toEqual(row.sheet_before);
        t.compared++;
        continue;
      }
      // "Rolled: 57 > 1 → Success!" / "✨ 侦查: 1 → 9 (+8)"
      expect([label, numbersIn(lines[1]!)]).toEqual([label, [result.roll.total, result.before]]);
      expect([label, lines.length === 3]).toEqual([label, result.grew]);
      if (result.grew) expect(numbersIn(lines[2]!).slice(-3)).toEqual([result.before, result.after, result.after - result.before]);
      expect([label, legacyOf(pack.sheet, result.sheet)]).toEqual([label, row.sheet_after as Record<string, Json>]);
      t.compared++;
    }
    expect(t).toEqual({
      compared: 76,
      skipped: {
        "no active character": 1,
        "unknown skill refused (2.x grew it from 0)": 9,
        "2.x storage-bridge bug (read/wrote past the sheet layer)": 42,
      },
    });
  });
});

describe("resource_spend_adjust (spend_luck, spend_fate)", () => {
  const REFUSALS: [string, RegExp][] = [
    ["invalid_points", /positive whole number|正整数/],
    ["insufficient", /Cannot spend|无法消耗/],
    ["exceeds_roll", /push the roll below|使骰值低于/],
    ["fumble", /fumble cannot|大失败无法/],
    ["ineligible", /cannot adjust the most recent|无法调整/],
    ["no_check", /no active session|没有/],
  ];

  test("every row", () => {
    const t = tally();
    for (const row of rowsOf("resource_spend_adjust")) {
      const pack = vectorPack(row.pack);
      if (row.sheet_before === null) {
        skip(t, "no active character");
        continue;
      }
      const sheet = sheetOf(pack.sheet, row.sheet_before);
      const prior = row.prior_check;
      const check =
        prior === null
          ? null
          : {
              skill: prior.skill,
              target: prior.target,
              roll: prior.roll,
              variant: (prior.details.variant as string | undefined) ?? null,
              difficulty: (prior.details.difficulty as string | undefined) ?? null,
            };
      const points = typeof row.arguments.points === "boolean" ? Number.NaN : pyInt(row.arguments.points);
      const result = runResourceSpend(pack, row.subsystem, { sheet, points, check });
      const label = `${row.subsystem} ${JSON.stringify(row.arguments)} ${JSON.stringify(prior)}`;
      expect(row.draws).toEqual([]);
      if (!result.ok) {
        const expected = REFUSALS.find(([, pattern]) => pattern.test(row.reply))?.[0];
        expect([label, result.refusal]).toEqual([label, expected as typeof result.refusal]);
        if (result.refusal === "insufficient") expect(numbersIn(row.reply)).toEqual([result.points, result.available]);
        if (result.refusal === "exceeds_roll") expect(numbersIn(row.reply)).toEqual([result.points, 1, result.roll, result.maxPoints]);
        if (result.refusal === "ineligible") expect(row.reply).toContain(result.skill);
        expect(row.sheet_after).toEqual(row.sheet_before);
        t.compared++;
        continue;
      }
      const record = (row.skill_checks ?? [])[0] as Record<string, Json>;
      const payload = row.dice_payloads[0] as Record<string, Json>;
      const { label: _shown, ...outcome } = payload.outcome as Record<string, Json>;
      expect([label, outcomeDict(result.outcome)]).toEqual([label, outcome as ReturnType<typeof outcomeDict>]);
      expect({
        roll: record.roll,
        adjusted_roll: record.adjusted_roll,
        raw_roll: record.raw_roll,
        luck_spent: record.luck_spent,
        luck_before: record.luck_before,
        luck_after: record.luck_after,
        rank_id: record.rank_id,
        tier: record.tier,
        success: record.success,
        critical: record.critical,
        fumble: record.fumble,
        target: payload.target,
        remaining: (payload.detail as Record<string, Json>).remaining,
        points: (payload.detail as Record<string, Json>).points,
      }).toEqual({
        roll: result.check.roll,
        adjusted_roll: result.spend.afterRoll,
        raw_roll: result.check.rawRoll,
        luck_spent: result.check.spent,
        luck_before: result.statBefore,
        luck_after: result.statAfter,
        rank_id: result.spend.after.id,
        tier: result.spend.after.tier,
        success: result.spend.after.success,
        critical: result.spend.after.critical,
        fumble: result.spend.after.fumble,
        target: check!.target,
        remaining: result.statAfter,
        points: result.points,
      });
      // "Vera spent 3 Luck on 侦查: 5 → 2 (Critical Success). Remaining Luck: 47"
      expect(numbersIn(row.reply)).toEqual([result.points, result.spend.beforeRoll, result.spend.afterRoll, result.statAfter]);
      expect(row.reply).toContain(rankDisplay(pack, result.spend.after.id, row.locale));
      expect(legacyOf(pack.sheet, result.sheet)).toEqual(row.sheet_after as Record<string, Json>);
      t.compared++;
    }
    expect(t).toEqual({ compared: 161, skipped: { "no active character": 1 } });
  });
});

describe("opposed (opposed_check, clash)", () => {
  test("every row", () => {
    const t = tally();
    for (const row of rowsOf("opposed")) {
      const pack = vectorPack(row.pack);
      const spec = pack.subsystems.get(row.subsystem)!;
      if (spec.template !== "opposed") throw new Error("template");
      const sheet = sheetOf(pack.sheet, row.sheet_before!);
      const args = row.arguments;
      const skill1 = String(args.skill1 ?? "");
      const skill2 = String(args.skill2 ?? "");
      const stated = (value: Json | undefined): number | null => (value === undefined || value === null ? null : pyInt(value));
      const value1 = stated(args.skill1_value);
      const value2 = stated(args.skill2_value);
      const label = `${row.subsystem} ${JSON.stringify(args)} ${JSON.stringify(row.draws)}`;
      // The 2.x reads: the active side through the alias table and sheet values (0 when
      // unknown), the passive side straight from the skills table with a default of 50.
      const read1 = sheetValue(pack.sheet, sheet, resolveName(pack.sheet, skill1) ?? skill1, evaluateSheet(pack.sheet, sheet));
      const legacy1 = value1 ?? (read1.kind === "value" ? read1.value : 0);
      const legacy2 = value2 ?? tableGet(sheet.skills, skill2) ?? 50;

      const random = scripted(row.draws);
      let result = runOpposedCheck(pack, row.subsystem, { active: { skill: skill1, sheet, value: value1 }, passive: { skill: skill2, sheet, value: value2 }, variant: row.variant }, random);
      const differs = !result.ok || result.active.value !== legacy1 || result.passive.value !== legacy2;
      if (differs) {
        if (!result.ok) {
          expect([label, result.refusal, random.consumed]).toEqual([label, "unknown_skill", 0]);
          skip(t, "2.x read an unknown skill as a number (refused)");
        } else {
          skip(t, "2.x read the passive skill raw, default 50 (corrected value)");
        }
        const rerun = scripted(row.draws);
        result = runOpposedCheck(pack, row.subsystem, { active: { skill: skill1, value: legacy1 }, passive: { skill: skill2, value: legacy2 }, variant: row.variant }, rerun);
        expect(rerun.remaining).toBe(0);
      } else {
        expect(random.remaining).toBe(0);
      }
      if (!result.ok) throw new Error(`${label}: ${result.refusal}`);
      const lines = row.reply.split("\n");
      // "🎯 Active: 侦查=25 rolled 57 → Failure": the value and the dice are unchanged in
      // either settling (the same one roll per side, from the same recorded draw).
      for (const [line, side] of [[lines[1]!, result.active], [lines[2]!, result.passive]] as const) {
        expect([label, numbersIn(line.slice(line.lastIndexOf("=") + 1))]).toEqual([label, [side.value, side.check.total]]);
      }
      expect(legacyOf(pack.sheet, sheet)).toEqual(row.sheet_after!);
      if (spec.settle === "total") {
        // Meet-the-target packs (dnd5e, oraclesynth): 2.x graded each side with its value
        // as the DC; a contest compares totals (dice + value) and grades neither side.
        const a = result.active;
        const p = result.passive;
        expect([a.total, p.total, a.outcome, p.outcome]).toEqual([a.check.total + a.value, p.check.total + p.value, null, null]);
        const winner = a.total === p.total ? "tie" : a.total > p.total ? "active" : "passive";
        expect([label, result.winner, result.decidedBy]).toEqual([label, winner, winner === "tie" ? null : "total"]);
        const last = lines[3]!;
        const old = /Tie|平局/.test(last) ? "tie" : /Active|主动方/.test(last) ? "active" : "passive";
        const key = `settled by total (2.x: value as DC) — ${row.pack}: ${old === winner ? "same winner" : "winner changed"}`;
        skip(t, key);
        continue;
      }
      for (const [line, side] of [[lines[1]!, result.active], [lines[2]!, result.passive]] as const) {
        expect(line.endsWith(rankDisplay(pack, side.outcome!.rank.id, row.locale))).toBe(true);
      }
      const last = lines[3]!;
      const winner = /Tie|平局/.test(last) ? "tie" : /Active|主动方/.test(last) ? "active" : "passive";
      const byValue = /higher skill value|技能值高/.test(last);
      expect([label, result.winner, result.decidedBy]).toEqual([label, winner, winner === "tie" ? null : byValue ? "value" : "tier"]);
      if (!differs) t.compared++;
    }
    // A row can carry two reasons (a dnd5e row whose passive value 2.x also misread).
    expect(t).toEqual({
      compared: 61,
      skipped: {
        "2.x read an unknown skill as a number (refused)": 9,
        "2.x read the passive skill raw, default 50 (corrected value)": 23,
        "settled by total (2.x: value as DC) — dnd5e: same winner": 11,
        "settled by total (2.x: value as DC) — dnd5e: winner changed": 20,
        "settled by total (2.x: value as DC) — oraclesynth: same winner": 4,
        "settled by total (2.x: value as DC) — oraclesynth: winner changed": 4,
      },
    });
  });
});

describe("table_draw (random_madness, omen)", () => {
  test("every row", () => {
    const t = tally();
    for (const row of rowsOf("table_draw")) {
      const pack = vectorPack(row.pack);
      const spec = pack.subsystems.get(row.subsystem)!;
      if (spec.template !== "table_draw") throw new Error("template");
      const random = scripted(row.draws);
      const table = row.arguments.table === undefined ? undefined : String(row.arguments.table);
      const result = runTableDraw(pack, row.subsystem, { table }, random);
      expect(random.remaining).toBe(0);
      const lines = row.reply.split("\n");
      if (!result.ok) {
        expect(lines[0]!.endsWith(result.known.join(", "))).toBe(true);
        t.compared++;
        continue;
      }
      expect([result.roll.total, result.index]).toEqual([row.draws[0]![2], row.draws[0]![2] - 1]);
      expect(lines[1]).toBe(result.entry);
      expect(lines[0]).toContain(tableName(spec.tables.get(result.table)!, row.locale));
      t.compared++;
    }
    expect(t).toEqual({ compared: 85, skipped: {} });
  });
});
