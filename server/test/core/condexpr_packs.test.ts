// Every expression the three built-in rule packs carry, plus the synthetic packs of the
// reference vectors, run through the evaluator — and, where the vectors recorded what
// the frozen engine graded, checked against those grades cell by cell. The rank-ladder
// harness below is only as much of check resolution as it takes to exercise the
// expressions (first matching rule wins, `int()` of the transformed target and the
// margin); resolution itself is not this file's subject.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  ABSENT,
  type CompiledExpr,
  compile,
  ExprError,
  type FunctionName,
  mapResolver,
  type Resolver,
} from "../../src/core/condexpr.ts";
import { readReference } from "../reference.ts";

const RESOLUTION_FUNCTIONS: readonly FunctionName[] = ["floor", "ceil", "min", "max", "abs"];
const DERIVED_FUNCTIONS: readonly FunctionName[] = ["floor", "ceil", "min", "max", "abs", "if"];
// The closed namespace a resolution expression may read.
const RESOLUTION_NAME = /^(?:roll|target|raw_target|modifier|successes|ones|dice\.[0-9]+)$/;

// ---------------------------------------------------------------------------
// The built-in packs' expressions, as data (the packs' YAML lives in the frozen tree;
// the last test checks this copy against it while that tree exists).
// ---------------------------------------------------------------------------

interface RankRule {
  readonly id: string;
  readonly when?: string;
}
interface Resolution {
  readonly ranks: readonly RankRule[];
  readonly variants?: Readonly<Record<string, { readonly ranks: readonly RankRule[] }>>;
  readonly difficulties?: Readonly<Record<string, { readonly target?: string }>>;
  readonly margin?: string;
  readonly compare: "<=" | ">=";
}

const COC7_SUCCESS_TIERS: readonly RankRule[] = [
  { id: "extreme", when: "roll <= target && roll <= floor(raw_target / 5)" },
  { id: "hard", when: "roll <= target && roll <= floor(raw_target / 2)" },
  { id: "regular", when: "roll <= target" },
];

const COC7: Resolution = {
  compare: "<=",
  difficulties: {
    regular: {},
    hard: { target: "floor(target / 2)" },
    extreme: { target: "floor(target / 5)" },
    critical: { target: "1" },
  },
  ranks: [
    { id: "crit", when: "roll == 1" },
    { id: "fumble", when: "roll == 100" },
    ...COC7_SUCCESS_TIERS,
    { id: "fumble", when: "roll >= 96 && target < 50" },
    { id: "fail" },
  ],
  variants: {
    rule1: {
      ranks: [
        { id: "crit", when: "roll == 1" },
        { id: "crit", when: "raw_target >= 50 && roll <= 5" },
        ...COC7_SUCCESS_TIERS,
        { id: "fumble", when: "raw_target < 50 && roll >= 96" },
        { id: "fumble", when: "raw_target >= 50 && roll == 100" },
        { id: "fail" },
      ],
    },
    rule2: {
      ranks: [
        { id: "crit", when: "roll == 1" },
        { id: "crit", when: "roll <= 5 && roll <= raw_target" },
        ...COC7_SUCCESS_TIERS,
        { id: "fumble", when: "raw_target < 96 && roll >= 96" },
        { id: "fumble", when: "raw_target >= 96 && roll >= min(raw_target + 1, 100)" },
        { id: "fail" },
      ],
    },
    rule3: {
      ranks: [
        { id: "fumble", when: "roll >= 96" },
        { id: "crit", when: "roll <= 5" },
        ...COC7_SUCCESS_TIERS,
        { id: "fail" },
      ],
    },
    rule4: {
      ranks: [
        { id: "crit", when: "roll <= min(floor(raw_target / 10), 5)" },
        ...COC7_SUCCESS_TIERS,
        { id: "fumble", when: "roll >= min(96 + floor(raw_target / 10), 100)" },
        { id: "fail" },
      ],
    },
    rule5: {
      ranks: [
        { id: "crit", when: "roll <= min(floor(raw_target / 5), 2)" },
        ...COC7_SUCCESS_TIERS,
        { id: "fumble", when: "raw_target < 50 && roll >= 96" },
        { id: "fumble", when: "raw_target >= 50 && roll >= 99" },
        { id: "fail" },
      ],
    },
    dg: {
      ranks: [
        { id: "crit", when: "roll == 1" },
        { id: "crit", when: "roll <= target && roll % 10 == floor(roll / 10) % 10" },
        { id: "fumble", when: "roll > target && roll % 10 == floor(roll / 10) % 10" },
        { id: "regular", when: "roll <= target" },
        { id: "fail" },
      ],
    },
  },
};

const DND5E: Resolution = {
  compare: ">=",
  ranks: [
    { id: "crit", when: "dice[0] == 20" },
    { id: "fumble", when: "dice[0] == 1" },
    { id: "success", when: "roll >= target" },
    { id: "fail" },
  ],
};

const WOD: Resolution = {
  compare: ">=",
  ranks: [
    { id: "botch", when: "successes == 0 && ones > 0" },
    { id: "fail", when: "successes == 0" },
    { id: "success" },
  ],
  margin: "successes",
};

const BUILT_IN: Readonly<Record<string, Resolution>> = { coc7: COC7, dnd5e: DND5E, wod: WOD };

/** Derived-value, vital and budget formulas: [pack, key, expression, functions]. */
const FORMULAS: readonly (readonly [string, string, string, readonly FunctionName[]])[] = [
  ["coc7", "DB", "floor((力量 + 体型 - 205) / 80) + 2", DERIVED_FUNCTIONS],
  ["coc7", "体格", "floor((力量 + 体型 - 205) / 80) + 3", DERIVED_FUNCTIONS],
  ["coc7", "移动力", "if(敏捷 > 体型 && 力量 > 体型, 9, if(敏捷 < 体型 && 力量 < 体型, 7, 8))", DERIVED_FUNCTIONS],
  ["coc7", "生命值上限", "floor((体质 + 体型) / 10)", DERIVED_FUNCTIONS],
  ["coc7", "生命值", "floor((体质 + 体型) / 10)", DERIVED_FUNCTIONS],
  ["coc7", "魔法值上限", "floor(意志 / 5)", DERIVED_FUNCTIONS],
  ["coc7", "魔法值", "floor(意志 / 5)", DERIVED_FUNCTIONS],
  ["coc7", "理智上限", "99 - 克苏鲁神话", DERIVED_FUNCTIONS],
  ["coc7", "SAN.start", "min(意志, 理智上限)", DERIVED_FUNCTIONS],
  ["coc7", "skill_points", "智力 * 2", []],
  ["coc7", "skill_points.max", "教育 * 4", []],
  ["coc7", "skill_points.max", "教育 * 2 + 力量 * 2", []],
  ["coc7", "skill_points.max", "教育 * 2 + 敏捷 * 2", []],
  ["coc7", "skill_points.max", "教育 * 2 + 外貌 * 2", []],
  ["coc7", "skill_points.max", "教育 * 2 + 意志 * 2", []],
  ["dnd5e", "力量调整值", "floor((力量 - 10) / 2)", DERIVED_FUNCTIONS],
  ["dnd5e", "敏捷调整值", "floor((敏捷 - 10) / 2)", DERIVED_FUNCTIONS],
  ["dnd5e", "体质调整值", "floor((体质 - 10) / 2)", DERIVED_FUNCTIONS],
  ["dnd5e", "智力调整值", "floor((智力 - 10) / 2)", DERIVED_FUNCTIONS],
  ["dnd5e", "感知调整值", "floor((感知 - 10) / 2)", DERIVED_FUNCTIONS],
  ["dnd5e", "魅力调整值", "floor((魅力 - 10) / 2)", DERIVED_FUNCTIONS],
  ["dnd5e", "pp", "10 + 察觉", DERIVED_FUNCTIONS],
  ["dnd5e", "速度", "30", DERIVED_FUNCTIONS],
  ["dnd5e", "载重", "力量 * 15", DERIVED_FUNCTIONS],
  ["dnd5e", "负重", "力量 * 10", DERIVED_FUNCTIONS],
  ["dnd5e", "护甲等级", "10 + 敏捷调整值", DERIVED_FUNCTIONS],
  ["dnd5e", "熟练加值", "floor((等级 - 1) / 4) + 2", DERIVED_FUNCTIONS],
];

function resolutionExpressions(resolution: Resolution): string[] {
  const out: string[] = [];
  const ladders = [resolution.ranks, ...Object.values(resolution.variants ?? {}).map((variant) => variant.ranks)];
  for (const ladder of ladders) for (const rule of ladder) if (rule.when !== undefined) out.push(rule.when);
  for (const difficulty of Object.values(resolution.difficulties ?? {})) {
    if (difficulty.target !== undefined) out.push(difficulty.target);
  }
  if (resolution.margin !== undefined) out.push(resolution.margin);
  return out;
}

// ---------------------------------------------------------------------------
// A minimal grader over compiled ladders.
// ---------------------------------------------------------------------------

interface CompiledResolution {
  readonly compare: "<=" | ">=";
  readonly ladders: ReadonlyMap<string, readonly { id: string; when: CompiledExpr | null }[]>;
  readonly difficulties: ReadonlyMap<string, CompiledExpr | null>;
  readonly margin: CompiledExpr | null;
}

function compileResolution(resolution: Resolution): CompiledResolution {
  const ladder = (rules: readonly RankRule[]) =>
    rules.map((rule) => ({
      id: rule.id,
      when: rule.when === undefined ? null : compile(rule.when, { functions: RESOLUTION_FUNCTIONS }),
    }));
  const ladders = new Map([["", ladder(resolution.ranks)]]);
  for (const [id, variant] of Object.entries(resolution.variants ?? {})) ladders.set(id, ladder(variant.ranks));
  const difficulties = new Map<string, CompiledExpr | null>();
  for (const [id, spec] of Object.entries(resolution.difficulties ?? {})) {
    difficulties.set(id, spec.target === undefined ? null : compile(spec.target, { functions: RESOLUTION_FUNCTIONS }));
  }
  return {
    compare: resolution.compare,
    ladders,
    difficulties,
    margin: resolution.margin === undefined ? null : compile(resolution.margin, { functions: RESOLUTION_FUNCTIONS }),
  };
}

/** Python's `int(_number(value))`: a number (or boolean), truncated toward zero. */
function integer(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "number") throw new Error(`expected a number, got ${String(value)}`);
  return Math.trunc(value) + 0;
}

interface Check {
  readonly variant: string | null;
  readonly difficulty: string | null;
  readonly target: number | null;
  readonly total: number;
  readonly dice: readonly number[];
  readonly successes: number | null;
  readonly ones: number | null;
  readonly modifier: number;
}

function effectiveTarget(resolution: CompiledResolution, target: number | null, difficulty: string | null): number | null {
  if (target === null) return null;
  const transform = difficulty === null ? null : (resolution.difficulties.get(difficulty) ?? null);
  if (transform === null) return target;
  const names = new Map([
    ["target", target],
    ["raw_target", target],
  ]);
  return integer(transform.evaluate(mapResolver(names), { absent: "error" }));
}

function grade(resolution: CompiledResolution, check: Check): { id: string; margin: number | null; effective: number | null } {
  const ladder = resolution.ladders.get(check.variant ?? "") ?? resolution.ladders.get("") ?? [];
  const effective = effectiveTarget(resolution, check.target, check.difficulty);
  const roll = check.total + check.modifier;
  const names = new Map<string, number>([
    ["roll", roll],
    ["modifier", check.modifier],
    ["successes", check.successes ?? 0],
    ["ones", check.ones ?? 0],
  ]);
  if (effective !== null) names.set("target", effective);
  if (check.target !== null) names.set("raw_target", check.target);
  check.dice.forEach((face, index) => names.set(`dice.${index}`, face));
  const resolve = mapResolver(names);
  const rule = ladder.find((candidate) => candidate.when === null || candidate.when.test(resolve, { absent: "error" }));
  if (rule === undefined) throw new Error("no rank");
  let margin: number | null;
  if (resolution.margin !== null) margin = integer(resolution.margin.evaluate(resolve, { absent: "error" }));
  else if (effective === null) margin = null;
  else margin = resolution.compare === "<=" ? effective - roll : roll - effective;
  return { id: rule.id, margin, effective };
}

// ---------------------------------------------------------------------------
// The synthetic packs of the reference vectors (their YAML is recorded in the vectors).
// ---------------------------------------------------------------------------

interface SyntheticPack {
  readonly names: readonly string[];
  readonly resolution?: Resolution & { readonly target?: string };
  readonly derived?: Record<string, unknown>;
  readonly creation_constraints?: { readonly budgets?: Record<string, { readonly parts: readonly unknown[] }> };
  readonly subsystems?: Record<string, { readonly loss_ceiling?: { readonly when: string } }>;
}

const SYNTHETIC_ROWS = readReference<Record<string, unknown>>("rules_synthetic");
const SYNTHETIC = new Map<string, SyntheticPack>();
for (const row of SYNTHETIC_ROWS) {
  if (row.kind === "pack") SYNTHETIC.set(String(row.pack), parseYaml(String(row.yaml)) as SyntheticPack);
}

function packResolution(pack: string): CompiledResolution {
  const builtIn = BUILT_IN[pack];
  if (builtIn !== undefined) return compileResolution(builtIn);
  const synthetic = SYNTHETIC.get(pack)?.resolution;
  if (synthetic === undefined) throw new Error(`no pack ${pack}`);
  return compileResolution(synthetic);
}

// ---------------------------------------------------------------------------

describe("every built-in expression compiles and reads only names its context supplies", () => {
  for (const [pack, resolution] of Object.entries(BUILT_IN)) {
    test.each(resolutionExpressions(resolution).map((source) => [pack, source] as const))("%s: %s", (_pack, source) => {
      const compiled = compile(source, { functions: RESOLUTION_FUNCTIONS });
      for (const name of compiled.references) expect(name).toMatch(RESOLUTION_NAME);
      // Each one evaluates against a full namespace.
      const names = new Map<string, unknown>([
        ["roll", 42],
        ["target", 50],
        ["raw_target", 50],
        ["modifier", 0],
        ["successes", 2],
        ["ones", 1],
        ["dice.0", 7],
      ]);
      const value = compiled.evaluate(mapResolver(names), { absent: "error" });
      expect(["number", "boolean"]).toContain(typeof value);
    });
  }

  test.each(FORMULAS.map(([pack, key, source, functions]) => [pack, key, source, functions] as const))(
    "%s %s: %s",
    (_pack, _key, source, functions) => {
      const compiled = compile(source, { functions });
      const value = compiled.evaluate(() => 50, { absent: "error" });
      expect(Number.isSafeInteger(value)).toBe(true);
    },
  );

  test("a resolution expression reading an unknown name is visible in its references", () => {
    expect(compile("roll <= targt", { functions: RESOLUTION_FUNCTIONS }).references).toEqual(["roll", "targt"]);
    // Even behind a short circuit, where no single run would ever trip over it.
    expect(compile("roll == 1 || rol > 5", { functions: RESOLUTION_FUNCTIONS }).references).toEqual(["roll", "rol"]);
    // A bare `dice` (no index) is not a supplied name.
    expect(compile("dice == 1").references.every((name) => RESOLUTION_NAME.test(name))).toBe(false);
  });
});

describe("formula values", () => {
  const value = (source: string, values: Record<string, number>, functions = DERIVED_FUNCTIONS) =>
    compile(source, { functions }).evaluate(mapResolver(new Map(Object.entries(values))), { absent: "error" });

  test.each<[Record<string, number>, number]>([
    [{ 敏捷: 60, 力量: 60, 体型: 50 }, 9],
    [{ 敏捷: 40, 力量: 40, 体型: 50 }, 7],
    [{ 敏捷: 60, 力量: 40, 体型: 50 }, 8],
    [{ 敏捷: 50, 力量: 50, 体型: 50 }, 8],
  ])("coc7 移动力 %p = %d", (values, expected) => {
    expect(value("if(敏捷 > 体型 && 力量 > 体型, 9, if(敏捷 < 体型 && 力量 < 体型, 7, 8))", values)).toBe(expected);
  });

  test.each<[number, number]>([
    [1, -5],
    [8, -1],
    [9, -1],
    [10, 0],
    [11, 0],
    [20, 5],
  ])("dnd5e modifier of %d is %d (floor toward -infinity)", (score, expected) => {
    expect(value("floor((力量 - 10) / 2)", { 力量: score })).toBe(expected);
  });

  test.each<[number, number]>([
    [1, 2],
    [4, 2],
    [5, 3],
    [17, 6],
    [20, 6],
  ])("dnd5e proficiency at level %d is %d", (level, expected) => {
    expect(value("floor((等级 - 1) / 4) + 2", { 等级: level })).toBe(expected);
  });

  test("coc7 skill points take the best occupation family", () => {
    const values = { 智力: 70, 教育: 60, 力量: 80, 敏捷: 50, 外貌: 40, 意志: 55 };
    const families = ["教育 * 4", "教育 * 2 + 力量 * 2", "教育 * 2 + 敏捷 * 2", "教育 * 2 + 外貌 * 2", "教育 * 2 + 意志 * 2"];
    const best = Math.max(...families.map((source) => value(source, values, []) as number));
    expect((value("智力 * 2", values, []) as number) + best).toBe(140 + 280);
  });
});

describe("the frozen engine's derived values, recomputed", () => {
  // `sheets_derived` rows whose inputs are plain integers: the expression-defined outputs
  // must match. A name reads the row's input value, else the recorded derived output
  // (`护甲等级` reads the derived `敏捷调整值`).
  const rows = readReference<{ pack: string; values: Record<string, unknown>; derived: Record<string, unknown> }>(
    "sheets_derived",
  );
  const formulas = FORMULAS.filter(([, key]) => !key.includes(".") && key !== "DB" && key !== "体格");

  test("every integer-input row agrees", () => {
    let checked = 0;
    for (const row of rows) {
      for (const [pack, key, source, functions] of formulas) {
        if (row.pack !== pack || !Object.hasOwn(row.derived, key)) continue;
        const compiled = compile(source, { functions });
        const resolve: Resolver = (path) => {
          const raw = Object.hasOwn(row.values, path) ? row.values[path] : row.derived[path];
          return Number.isSafeInteger(raw) ? raw : ABSENT;
        };
        let result: unknown;
        try {
          result = compiled.evaluate(resolve, { absent: "error" });
        } catch (error) {
          if (error instanceof ExprError && error.code === "ABSENT_NAME") continue; // not an integer-input row
          throw error;
        }
        expect({ pack, key, values: row.values, result }).toEqual({ pack, key, values: row.values, result: row.derived[key] });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("rank ladders reproduce the recorded grades", () => {
  interface GridRow {
    pack: string;
    variant: string | null;
    difficulty: string | null;
    target: number;
    modifier: number;
    effective_target: number;
    legend: { id: string }[];
    rank: number[];
    margin: number[];
  }

  const gridCheck = (rows: GridRow[]): number => {
    let cells = 0;
    const compiled = new Map<string, CompiledResolution>();
    for (const row of rows) {
      let resolution = compiled.get(row.pack);
      if (resolution === undefined) {
        resolution = packResolution(row.pack);
        compiled.set(row.pack, resolution);
      }
      const ids: string[] = [];
      const margins: (number | null)[] = [];
      let effective: number | null = null;
      for (let face = 1; face <= row.rank.length; face += 1) {
        const outcome = grade(resolution, {
          variant: row.variant,
          difficulty: row.difficulty,
          target: row.target,
          total: face,
          dice: [face],
          successes: null,
          ones: null,
          modifier: row.modifier,
        });
        ids.push(outcome.id);
        margins.push(outcome.margin);
        effective = outcome.effective;
        cells += 1;
      }
      const label = `${row.pack} ${row.variant} ${row.difficulty} target=${row.target} modifier=${row.modifier}`;
      expect({ label, effective, ids, margins }).toEqual({
        label,
        effective: row.effective_target,
        ids: row.rank.map((index) => row.legend[index]?.id ?? "?"),
        margins: row.margin,
      });
    }
    return cells;
  };

  test("coc7: every variant, difficulty, target -10..120 and modifier", () => {
    expect(gridCheck(readReference<GridRow>("rules_coc7_grid"))).toBeGreaterThan(500_000);
  }, 60_000);

  test("dnd5e: every modifier and DC", () => {
    expect(gridCheck(readReference<GridRow>("rules_dnd5e_grid"))).toBeGreaterThan(10_000);
  });

  test("oraclesynth: difficulty transforms, a variant and a margin expression", () => {
    expect(gridCheck(SYNTHETIC_ROWS.filter((row) => row.kind === "interpret_grid") as unknown as GridRow[])).toBeGreaterThan(
      20_000,
    );
  });

  test("success pools: wod and oraclepool", () => {
    interface PoolRow {
      pack: string;
      pool: number;
      legend: { id: string }[];
      cells: [number, number, number, number][];
    }
    const rows = [
      ...readReference<PoolRow>("rules_wod_grid"),
      ...(SYNTHETIC_ROWS.filter((row) => row.kind === "pool_grid") as unknown as PoolRow[]),
    ];
    let cells = 0;
    for (const row of rows) {
      const resolution = packResolution(row.pack);
      for (const [successes, ones, legendIndex, margin] of row.cells) {
        const outcome = grade(resolution, {
          variant: null,
          difficulty: null,
          target: null,
          total: successes,
          dice: Array.from({ length: row.pool }, () => 0),
          successes,
          ones,
          modifier: 0,
        });
        expect([row.pack, row.pool, successes, ones, outcome.id, outcome.margin]).toEqual([
          row.pack,
          row.pool,
          successes,
          ones,
          row.legend[legendIndex]?.id ?? "?",
          margin,
        ]);
        cells += 1;
      }
    }
    expect(cells).toBeGreaterThan(1000);
  });

  test("single-cell cases, including checks without a target", () => {
    interface CaseRow {
      pack: string;
      variant: string | null;
      difficulty: string | null;
      target: number | null;
      modifier: number;
      effective_target: number | null;
      rolled: { dice: number[]; total: number; successes: number | null; ones: number | null };
      outcome: { rank: { id: string }; margin: number | null } | null;
      error: { message: string } | null;
    }
    const rows = [
      ...readReference<CaseRow>("rules_interpret_cases"),
      ...(SYNTHETIC_ROWS.filter((row) => row.kind === "interpret_case") as unknown as CaseRow[]),
    ];
    let absent = 0;
    for (const row of rows) {
      const check = { ...row.rolled, variant: row.variant, difficulty: row.difficulty, target: row.target, modifier: row.modifier };
      const resolution = packResolution(row.pack);
      if (row.error !== null) {
        // The engine's "unknown name 'target' in resolution expression": a rule read a
        // name this check does not carry, which here is ABSENT_NAME.
        let code: string | undefined;
        try {
          grade(resolution, check);
        } catch (error) {
          code = error instanceof ExprError ? error.code : String(error);
        }
        expect({ message: row.error.message, code }).toEqual({ message: row.error.message, code: "ABSENT_NAME" });
        absent += 1;
        continue;
      }
      const outcome = grade(resolution, check);
      expect({ id: outcome.id, margin: outcome.margin, effective: outcome.effective }).toEqual({
        id: row.outcome?.rank.id ?? "?",
        margin: row.outcome?.margin ?? null,
        effective: row.effective_target,
      });
    }
    expect(absent).toBeGreaterThan(10);
  });

  test("oraclesynth effective targets", () => {
    const resolution = packResolution("oraclesynth");
    const rows = SYNTHETIC_ROWS.filter((row) => row.kind === "effective_target");
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) {
      const target = row.target as number | null;
      const difficulty = row.difficulty as string | null;
      expect([target, difficulty, effectiveTarget(resolution, target, difficulty)]).toEqual([target, difficulty, row.result as number | null]);
    }
  });
});

describe("the synthetic packs' other expressions", () => {
  const pack = SYNTHETIC.get("oraclesynth");

  test("derived formulas and budgets compile with the derived function set", () => {
    const sources: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (typeof node === "object" && node !== null) {
        for (const [key, child] of Object.entries(node)) {
          if (key === "expr" && typeof child === "string") sources.push(child);
          else visit(child);
        }
      }
    };
    visit(pack?.derived);
    for (const budget of Object.values(pack?.creation_constraints?.budgets ?? {})) {
      for (const part of budget.parts) {
        if (typeof part === "string") sources.push(part);
        else visit(part);
        if (typeof part === "object" && part !== null && "max" in part) sources.push(...(part.max as string[]));
      }
    }
    expect(sources.length).toBeGreaterThanOrEqual(8);
    for (const source of sources) {
      expect(Number.isFinite(compile(source, { functions: DERIVED_FUNCTIONS }).evaluate(() => 12))).toBe(true);
    }
    // `guard` exercises if/max/abs/floor together.
    const guard = compile("if(muscle > 12, 2, 0) + max(1, floor(nerve / 4)) + abs(wit - 10)", { functions: DERIVED_FUNCTIONS });
    expect(guard.evaluate(mapResolver(new Map([["muscle", 13], ["nerve", 9], ["wit", 7]])))).toBe(2 + 2 + 3);
  });

  test("the conditional loss ceiling reads a scene tag and the sheet", () => {
    const when = pack?.subsystems?.stress_check?.loss_ceiling?.when ?? "";
    expect(when).toBe("tag == 'safe' || stat_data.level >= 5");
    const compiled = compile(when);
    expect(compiled.references).toEqual(["tag", "stat_data.level"]);
    const holds = (tag: string, level: unknown) =>
      compiled.test(mapResolver(new Map<string, unknown>([["tag", tag], ["stat_data.level", level]])));
    expect(holds("safe", 1)).toBe(true);
    expect(holds("", 5)).toBe(true);
    expect(holds("", 4)).toBe(false);
    expect(() => holds("", null)).toThrow(ExprError); // the caller fails closed: no cap
  });
});

// While the frozen Python tree is present, the copy above must be the packs' whole
// expression set — a pack edit that adds an expression would otherwise go untested.
const RULEPACKS = join(import.meta.dir, "../../../rulepacks");
test.skipIf(!existsSync(RULEPACKS))("the embedded copy covers every expression in the built-in packs' YAML", () => {
  const embedded = new Set<string>([
    ...Object.values(BUILT_IN).flatMap(resolutionExpressions),
    ...FORMULAS.map(([, , source]) => source),
  ]);
  const found: string[] = [];
  const visit = (node: unknown, path: readonly string[]): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, path));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      const here = [...path, key];
      if ((key === "when" || key === "expr" || key === "margin") && typeof child === "string") found.push(child);
      else if (key === "target" && path.includes("difficulties") && typeof child === "string") found.push(child);
      else if (key === "parts" && Array.isArray(child)) {
        for (const part of child) {
          if (typeof part === "string") found.push(part);
          else if (typeof part === "object" && part !== null && Array.isArray((part as { max?: unknown }).max)) {
            found.push(...((part as { max: string[] }).max));
          }
        }
      } else visit(child, here);
    }
  };
  for (const name of ["coc7", "dnd5e", "wod"]) {
    visit(parseYaml(readFileSync(join(RULEPACKS, `${name}.yaml`), "utf8")), []);
  }
  expect(found.length).toBeGreaterThan(70);
  expect(found.filter((source) => !embedded.has(source))).toEqual([]);
});
