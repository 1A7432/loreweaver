// The reference vectors of check resolution, row by row and cell by cell, through the
// adapter in `./adapter.ts`.
//
// Not compared, and why:
// - `rules_pack_meta` / `pack_meta`: `names`, `set_keys`, `rank_labels`, `display_names`,
//   `initiative_roll`, `commands`, `subsystems` belong to the pack assembler, labels and
//   subsystems, not to the `resolution:` section.
// - `graded_roll` `wire.*.label`: labels are localized by callers (ruling 4); every other
//   wire field is compared.
// - `rules_luck` `check_after` (the mutated record dict) and the `eligible` /
//   `find_latest` rows: updating and finding stored check records, and the list of skills
//   Luck may not touch (system vocabulary), are the callers' and the subsystem's; this
//   layer owns the spend arithmetic, which `adjustment` covers.
// - `rules_script_lane` and the script pack: out of scope (refused at compile time).
// - `rules_subsystems`: out of scope.
//
// Rows answered differently ON PURPOSE are counted per reason and the counts pinned, so a
// change in either the vectors or the engine shows up here:
// - UNKNOWN_MODIFIER: a modifier name the pack does not declare is a caller error (the old
//   roll step ignored it silently). The row is checked to throw, then re-run without the
//   undeclared names and compared in full.
// - Booleans as roll parameters are INVALID_PARAM (the old `int(True)` read 1).
// - A `target: none` system rolled without a target is GRADED (the old roll-and-grade
//   helper left every such check ungraded); the outcome is checked against the pool grid.
import { describe, expect, test } from "bun:test";

import {
  clampParams,
  effectiveTarget,
  favorModifiers,
  gradeCheck,
  performCheck,
  rollCheck,
  spendLuck,
} from "../../../src/core/resolution/index.ts";
import { ScriptedRandom } from "../../../src/core/random.ts";
import { readReference } from "../../reference.ts";
import {
  asRollDetail,
  attempt,
  compact,
  type Draw,
  expectedCode,
  type OldError,
  type OldRank,
  type OldRolled,
  outcomeDict,
  pack,
  packs,
  poolGridCell,
  pyInt,
  rankDict,
} from "./adapter.ts";

type Row = Record<string, unknown> & { kind: string };

const scripted = (draws: Draw[]) => new ScriptedRandom(draws.map(([lo, hi, value, step]) => ({ lo, hi, value, step })));

describe("rules_pack_meta and the literal packs' pack_meta", () => {
  const rows = [...readReference<Row>("rules_pack_meta"), ...readReference<Row>("rules_synthetic").filter((row) => row.kind === "pack_meta")];
  test("every compiled section matches", () => {
    expect(rows.length).toBe(5);
    const ids = ["coc7", "dnd5e", "wod", "oraclesynth", "oraclepool"];
    rows.forEach((row, index) => {
      const r = pack(ids[index]!);
      const ladder = (rules: typeof r.ladder) =>
        rules.map((rule) => ({ ...rankDict(rule.rank), conditional: rule.when !== null }));
      const actual = {
        roll: compact(r.roll.notation),
        compare: r.compare,
        target_kind: r.targetKind,
        modifiers: Object.fromEntries(
          [...r.modifiers.values()].map((m) => [
            m.name,
            { ...(m.roll === null ? {} : { roll: compact(m.roll.notation) }), ...(m.tensReroll === null ? {} : { tens_reroll: m.tensReroll }) },
          ]),
        ),
        variants: [...r.variants.keys()].sort(),
        has_margin_expression: r.margin !== null,
        ladders: Object.fromEntries([["", ladder(r.ladder)], ...[...r.variants].map(([id, rules]) => [id, ladder(rules)])]),
        difficulties: [...r.difficulties.values()].map((d) => ({ id: d.id, has_target_transform: d.target !== null, prefixes: Object.fromEntries(d.prefixes) })),
        params: [...r.params.values()].map((p) => ({ id: p.id, min: p.min, max: p.max, default: p.default })),
        check: {
          favorable: r.check.favorable ?? "",
          unfavorable: r.check.unfavorable ?? "",
          default_target: r.check.defaultTarget,
          proficiency: r.check.proficiency ?? "",
          default_skill: r.check.defaultSkill ?? "",
        },
      };
      const expected = Object.fromEntries(Object.keys(actual).map((key) => [key, row[key]]));
      expect(actual).toEqual(expected as typeof actual);
    });
  });
});

interface GridRow extends Row {
  pack: string;
  variant: string | null;
  difficulty: string | null;
  target: number | null;
  modifier: number;
  effective_target: number | null;
  legend: OldRank[];
  rank: number[];
  margin: number[];
}

/** Grades every roll of every grid row; collects mismatches instead of asserting per cell, to stay fast. */
function gradeGrid(rows: GridRow[], faces: number): { cells: number; mismatches: string[] } {
  let cells = 0;
  const mismatches: string[] = [];
  for (const row of rows) {
    const r = pack(row.pack);
    const options = { target: row.target, variant: row.variant, difficulty: row.difficulty, modifier: row.modifier };
    if (effectiveTarget(r, row.target, row.difficulty) !== row.effective_target) mismatches.push(`${JSON.stringify(options)} effective target`);
    for (let natural = 1; natural <= faces; natural++) {
      cells++;
      const outcome = gradeCheck(r, { total: natural, dice: [natural] }, options);
      const want = row.legend[row.rank[natural - 1]!]!;
      const got = rankDict(outcome.rank);
      if (got.id !== want.id || got.tier !== want.tier || got.success !== want.success || got.critical !== want.critical || got.fumble !== want.fumble || outcome.margin !== row.margin[natural - 1]) {
        if (mismatches.length < 20) mismatches.push(`${row.pack} ${JSON.stringify(options)} roll ${natural}: got ${got.id}/${outcome.margin}, want ${want.id}/${row.margin[natural - 1]}`);
      }
    }
  }
  return { cells, mismatches };
}

describe("interpretation grids", () => {
  test("rules_coc7_grid: every d100 roll of every target, variant, difficulty and modifier", () => {
    const rows = readReference<GridRow>("rules_coc7_grid");
    const { cells, mismatches } = gradeGrid(rows, 100);
    expect(mismatches).toEqual([]);
    expect(cells).toBe(599_900);
  });

  test("rules_dnd5e_grid: every natural d20 of every DC and modifier", () => {
    const rows = readReference<GridRow>("rules_dnd5e_grid");
    const { cells, mismatches } = gradeGrid(rows, 20);
    expect(mismatches).toEqual([]);
    expect(cells).toBe(23_560);
  });

  test("rules_synthetic interpret_grid (oraclesynth): difficulty transforms, a variant, a margin expression", () => {
    const rows = readReference<GridRow>("rules_synthetic").filter((row) => row.kind === "interpret_grid");
    const { cells, mismatches } = gradeGrid(rows, 20);
    expect(mismatches).toEqual([]);
    expect(cells).toBe(21_060);
  });

  test("pool grids (rules_wod_grid, oraclepool): every successes/ones cell of every pool size", () => {
    const rows = [
      ...readReference<Row & { pack: string; pool: number; legend: OldRank[]; cells: number[][] }>("rules_wod_grid"),
      ...readReference<Row & { pack: string; pool: number; legend: OldRank[]; cells: number[][] }>("rules_synthetic").filter((row) => row.kind === "pool_grid"),
    ];
    let cells = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      const r = pack(row.pack);
      for (const [successes, ones, index, margin] of row.cells as [number, number, number, number][]) {
        cells++;
        const outcome = gradeCheck(r, { total: successes, dice: new Array<number>(row.pool).fill(0), successes, ones });
        if (outcome.rank.id !== row.legend[index]!.id || outcome.rank.tier !== row.legend[index]!.tier || outcome.margin !== margin) {
          mismatches.push(`${row.pack} pool ${row.pool} ${successes}/${ones}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(cells).toBe(1_770 + 164);
  });
});

interface CaseRow extends Row {
  pack: string;
  rolled: OldRolled;
  target: number | null;
  variant: string | null;
  difficulty: string | null;
  modifier: number;
  effective_target: number | null;
  outcome: unknown;
  error: OldError | null;
}

test("rules_interpret_cases and oraclesynth interpret_case: single-cell edges and errors", () => {
  const rows = [...readReference<CaseRow>("rules_interpret_cases"), ...readReference<CaseRow>("rules_synthetic").filter((row) => row.kind === "interpret_case")];
  expect(rows.length).toBe(428);
  for (const row of rows) {
    const r = pack(row.pack);
    const options = { target: row.target, variant: row.variant, difficulty: row.difficulty, modifier: row.modifier };
    expect(effectiveTarget(r, row.target, row.difficulty)).toBe(row.effective_target);
    const result = attempt(() => gradeCheck(r, row.rolled, options));
    if (row.error !== null) {
      expect({ row: row.rolled, code: result.ok ? "ok" : result.code }).toEqual({ row: row.rolled, code: expectedCode(row.error) });
    } else {
      expect(result.ok).toBe(true);
      if (result.ok) expect(outcomeDict(result.value)).toEqual(row.outcome as ReturnType<typeof outcomeDict>);
    }
  }
});

describe("rules_params and oraclepool clamp_params / oraclesynth effective_target", () => {
  const all = [...readReference<Row>("rules_params"), ...readReference<Row>("rules_synthetic").filter((row) => row.kind === "clamp_params" || row.kind === "effective_target")];

  test("clamp_params", () => {
    const rows = all.filter((row) => row.kind === "clamp_params") as (Row & { pack: string; values: Record<string, unknown> | null; result: Record<string, number> | null; error: OldError | null })[];
    let booleans = 0;
    for (const row of rows) {
      const result = attempt(() => clampParams(pack(row.pack), row.values));
      const declared = pack(row.pack).params;
      if (row.values !== null && [...declared.keys()].some((id) => typeof row.values![id] === "boolean")) {
        booleans++;
        expect(result.ok ? "ok" : result.code).toBe("INVALID_PARAM");
        continue;
      }
      if (row.error !== null) {
        expect(result.ok ? null : { code: result.code, param: result.param }).toEqual({ code: expectedCode(row.error), param: row.error.param });
      } else {
        expect(result.ok ? Object.fromEntries(result.value) : result.code).toEqual(row.result!);
      }
    }
    expect(rows.length).toBe(64);
    expect(booleans).toBe(2);
  });

  test("effective_target", () => {
    const rows = all.filter((row) => row.kind === "effective_target") as (Row & { pack: string; target: number | null; difficulty: string | null; result: number | null })[];
    expect(rows.length).toBe(189);
    for (const row of rows) expect(effectiveTarget(pack(row.pack), row.target, row.difficulty)).toBe(row.result);
  });
});

test("favor_modifiers (rules_check_roll, oraclesynth)", () => {
  const rows = [...readReference<Row>("rules_check_roll"), ...readReference<Row>("rules_synthetic")].filter((row) => row.kind === "favor_modifiers") as (Row & {
    check: { favorable: string; unfavorable: string };
    bonus: unknown;
    penalty: unknown;
    modifiers: Record<string, number> | null;
    applied: string | null;
    error: OldError | null;
  })[];
  expect(rows.length).toBe(1_368);
  for (const row of rows) {
    const routing = { favorable: row.check.favorable || null, unfavorable: row.check.unfavorable || null };
    const result = attempt(() => favorModifiers(routing, pyInt(row.bonus) ?? Number.NaN, pyInt(row.penalty) ?? Number.NaN));
    if (row.error !== null) {
      expect(result.ok ? "ok" : result.code).toBe(expectedCode(row.error, "count"));
    } else if (result.ok) {
      expect({ modifiers: Object.fromEntries(result.value.modifiers), applied: result.value.applied ?? "" }).toEqual({ modifiers: row.modifiers!, applied: row.applied! });
    } else {
      throw new Error(`unexpected ${result.code}`);
    }
  }
});

interface RollRow extends Row {
  args: { pack: string; modifiers: [string, unknown][]; params?: Record<string, unknown> | null; target?: number | null; modifier?: number; variant?: string | null; difficulty?: string | null };
  draws: Draw[];
  result: unknown;
  error: OldError | null;
}

/** The old roll step's modifier handling at the call site: `int()` with failures as 0, in order. */
function counts(row: RollRow, declaredOnly: boolean): [string, number][] {
  return row.args.modifiers
    .filter(([name]) => !declaredOnly || pack(row.args.pack).modifiers.has(name))
    .map(([name, count]) => [name, pyInt(count) ?? 0]);
}

/** Checks the UNKNOWN_MODIFIER refusal, and reports whether the row names undeclared modifiers. */
function refusesUndeclared(row: RollRow, call: (modifiers: [string, number][]) => unknown): boolean {
  const declared = pack(row.args.pack).modifiers;
  if (row.args.modifiers.every(([name]) => declared.has(name))) return false;
  const result = attempt(() => call(counts(row, false)));
  expect(result.ok ? "ok" : result.code).toBe("UNKNOWN_MODIFIER");
  return true;
}

test("roll_for_check (dice_vectors, oraclesynth, oraclepool): the roll step with recorded draws", () => {
  const rows = [
    ...readReference<Row & { fn?: string }>("dice_vectors").filter((row) => row.fn === "roll_for_check"),
    ...readReference<Row>("rules_synthetic").filter((row) => row.kind === "roll_for_check"),
  ] as RollRow[];
  let undeclared = 0;
  let booleans = 0;
  for (const row of rows) {
    const r = pack(row.args.pack);
    const params = row.args.params ?? null;
    if (refusesUndeclared(row, (modifiers) => rollCheck(r, scripted(row.draws), { modifiers, params }))) undeclared++;
    const random = scripted(row.draws);
    const result = attempt(() => rollCheck(r, random, { modifiers: counts(row, true), params }));
    if (params !== null && [...r.params.keys()].some((id) => typeof params[id] === "boolean")) {
      booleans++;
      expect(result.ok ? "ok" : result.code).toBe("INVALID_PARAM");
      continue;
    }
    if (row.error !== null) {
      expect(result.ok ? "ok" : result.code).toBe(expectedCode(row.error));
      expect(random.consumed).toBe(0);
      continue;
    }
    if (!result.ok) throw new Error(`unexpected ${result.code} for ${JSON.stringify(row.args)}`);
    expect(asRollDetail(result.value)).toEqual(row.result as OldRolled);
    expect(random.remaining).toBe(0);
  }
  expect(rows.length).toBe(214 + 39);
  expect(undeclared).toBe(15);
  expect(booleans).toBe(2);
});

test("graded_roll (rules_check_roll, oraclesynth, oraclepool): roll and grade with recorded draws", () => {
  const rows = [...readReference<Row>("rules_check_roll"), ...readReference<Row>("rules_synthetic")].filter((row) => row.kind === "graded_roll") as RollRow[];
  let undeclared = 0;
  let gradedPools = 0;
  for (const row of rows) {
    const a = row.args;
    const r = pack(a.pack);
    const request = { target: a.target, modifier: a.modifier, variant: a.variant, difficulty: a.difficulty };
    if (refusesUndeclared(row, (modifiers) => performCheck(r, scripted(row.draws), { ...request, modifiers }))) undeclared++;
    const random = scripted(row.draws);
    const result = attempt(() => performCheck(r, random, { ...request, modifiers: counts(row, true) }));
    if (row.error !== null) throw new Error("no graded_roll row records an error");
    if (!result.ok) throw new Error(`unexpected ${result.code} for ${JSON.stringify(a)}`);
    const expected = row.result as { rolled: OldRolled; total: number; target: number | null; effective_target: number | null; outcome: Record<string, unknown> | null };
    const performed = result.value;
    expect(random.remaining).toBe(0);
    expect(asRollDetail(performed.rolled)).toEqual(expected.rolled);
    expect(performed.total).toBe(expected.total);
    expect(effectiveTarget(r, a.target, a.difficulty)).toBe(expected.effective_target);
    if (expected.outcome === null && r.targetKind === "none") {
      // Deliberate: graded, against what the old engine graded for these counts.
      gradedPools++;
      const rolled = performed.rolled;
      const cell = poolGridCell(a.pack, rolled.dice.length, rolled.successes!, rolled.ones!);
      expect(cell).toBeDefined();
      expect(performed.outcome === null ? null : { rank: rankDict(performed.outcome.rank), margin: performed.outcome.margin }).toEqual(cell!);
      continue;
    }
    if (expected.outcome === null) {
      expect(performed.outcome).toBeNull();
      continue;
    }
    const outcome = performed.outcome;
    expect(outcome).not.toBeNull();
    if (outcome === null) continue;
    const { rank, margin, target } = expected.outcome as { rank: OldRank; margin: number | null; target: number | null };
    expect(outcomeDict(outcome)).toEqual({ rank, margin, target });
    for (const locale of ["en", "zh"]) {
      const { label: _label, ...wire } = (expected.outcome.wire as Record<string, Record<string, unknown>>)[locale]!;
      expect({ ...rankDict(outcome.rank), ...(outcome.margin === null ? {} : { margin: outcome.margin }) }).toEqual(wire as unknown as OldRank);
    }
  }
  expect(rows.length).toBe(2_068 + 983);
  expect(undeclared).toBe(36);
  expect(gradedPools).toBe(24 + 9);
});

test("rules_luck adjust: the spend arithmetic and its refusals", () => {
  const rows = readReference<Row>("rules_luck").filter((row) => row.kind === "adjust") as (Row & {
    check: Record<string, unknown>;
    points: unknown;
    adjustment: { before_roll: number; after_roll: number; before: OldRank; after: OldRank; total_spent: number } | null;
    error: OldError | null;
  })[];
  const coc7 = pack("coc7");
  for (const row of rows) {
    const check = row.check;
    const options = { target: pyInt(check.target), variant: (check.variant as string | undefined) || null, difficulty: (check.difficulty as string | undefined) || null };
    const result = attempt(() =>
      spendLuck({
        roll: pyInt(check.roll) ?? Number.NaN,
        // The old guard refused anything but a real int (a bool, "3", 1.5, None).
        points: typeof row.points === "number" ? row.points : Number.NaN,
        alreadySpent: pyInt(check.luck_spent ?? 0) ?? 0,
        grade: (roll) => gradeCheck(coc7, { total: roll, dice: [roll] }, options).rank,
      }),
    );
    if (row.error !== null) {
      expect(result.ok ? "ok" : result.code).toBe(expectedCode(row.error, "luck_roll"));
    } else if (result.ok) {
      const spend = result.value;
      expect({ before_roll: spend.beforeRoll, after_roll: spend.afterRoll, before: rankDict(spend.before), after: rankDict(spend.after), total_spent: spend.totalSpent }).toEqual(row.adjustment!);
    } else {
      throw new Error(`unexpected ${result.code}`);
    }
  }
  expect(rows.length).toBe(5_644);
});

test("every pack the vectors use compiles", () => {
  expect([...packs().keys()].sort()).toEqual(["coc7", "dnd5e", "oraclepool", "oraclesynth", "wod"]);
});
