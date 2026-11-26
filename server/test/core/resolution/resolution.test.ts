// The resolution layer's own contract, beyond what the reference vectors record:
// compile-time refusals with their codes, immutability, the absent-target rule, the roll
// step passing parameters through, the rounding rule, and pack names as content.
import { describe, expect, test } from "bun:test";

import {
  clampParams,
  compileResolution,
  effectiveTarget,
  FrozenMap,
  gradeCheck,
  performCheck,
  type Resolution,
  ResolutionError,
  type ResolutionErrorCode,
  rollCheck,
  spendLuck,
} from "../../../src/core/resolution/index.ts";
import { ScriptedRandom, SeededRandom } from "../../../src/core/random.ts";
import { pack } from "./adapter.ts";

const LADDER = [{ id: "hit", when: "roll >= target", success: true }, { id: "miss" }];

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { roll: "1d20", target: "dc", compare: ">=", ranks: LADDER, ...extra };
}

function compileError(section: unknown): ResolutionError {
  try {
    compileResolution("testpack", section);
  } catch (error) {
    if (error instanceof ResolutionError) return error;
    throw error;
  }
  throw new Error("compiled, but a refusal was expected");
}

function codeOf(fn: () => unknown): ResolutionErrorCode | "ok" {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof ResolutionError) return error.code;
    throw error;
  }
}

describe("compile-time refusals", () => {
  const cases: [string, unknown, ResolutionErrorCode, string][] = [
    ["not a mapping", [1], "BAD_FIELD", "resolution"],
    ["unknown top-level key", base({ rolls: "1d20" }), "UNKNOWN_KEY", "resolution"],
    ["newer version", base({ version: 2 }), "UNSUPPORTED_VERSION", "resolution.version"],
    ["script lane", base({ script: "resolve.js" }), "SCRIPT_UNSUPPORTED", "resolution.script"],
    ["bad target kind", base({ target: "skillz" }), "BAD_FIELD", "resolution.target"],
    ["explicit null compare", base({ compare: null }), "BAD_FIELD", "resolution.compare"],
    ["bad notation", base({ roll: "1d" }), "BAD_NOTATION", "resolution.roll"],
    ["undeclared slot", base({ roll: "{pool}d10" }), "UNDECLARED_PARAM", "resolution.roll"],
    ["undeclared slot in a modifier", base({ modifiers: { up: { roll: "{n}d20kh1" } } }), "UNDECLARED_PARAM", "resolution.modifiers.up.roll"],
    ["bad tens_reroll", base({ modifiers: { up: { tens_reroll: "keep_middle" } } }), "BAD_FIELD", "resolution.modifiers.up.tens_reroll"],
    ["empty ladder", base({ ranks: [] }), "BAD_FIELD", "resolution.ranks"],
    ["no fallback", base({ ranks: [{ id: "hit", when: "roll >= target" }] }), "BAD_LADDER", "resolution.ranks"],
    ["early fallback", base({ ranks: [{ id: "a" }, { id: "b", when: "roll > 1" }, { id: "c" }] }), "BAD_LADDER", "resolution.ranks[0]"],
    ["rank id not a slug", base({ ranks: [{ id: "Hit" }] }), "BAD_ID", "resolution.ranks[0].id"],
    ["rank flag not boolean", base({ ranks: [{ id: "hit", success: "yes" }] }), "BAD_FIELD", "resolution.ranks[0].success"],
    ["tier out of range", base({ ranks: [{ id: "hit", tier: 33 }] }), "BAD_FIELD", "resolution.ranks[0].tier"],
    ["unknown rank key", base({ ranks: [{ id: "hit", label: "Hit" }] }), "UNKNOWN_KEY", "resolution.ranks[0]"],
    ["too many ranks", base({ ranks: [...Array.from({ length: 32 }, (_, i) => ({ id: `r${i}`, when: `roll == ${i}` })), { id: "miss" }] }), "TOO_MANY", "resolution.ranks"],
    ["bad expression", base({ ranks: [{ id: "hit", when: "roll >=" }, { id: "miss" }] }), "BAD_EXPRESSION", "resolution.ranks[0].when"],
    ["function outside the rule set", base({ ranks: [{ id: "hit", when: "if(roll, 1, 0)" }, { id: "miss" }] }), "BAD_EXPRESSION", "resolution.ranks[0].when"],
    ["unknown name", base({ ranks: [{ id: "hit", when: "rolll >= target" }, { id: "miss" }] }), "UNKNOWN_NAME", "resolution.ranks[0].when"],
    ["bare dice", base({ ranks: [{ id: "hit", when: "dice" }, { id: "miss" }] }), "UNKNOWN_NAME", "resolution.ranks[0].when"],
    ["target read in a targetless system", { roll: "3d6>=5", target: "none", ranks: LADDER }, "TARGET_FORBIDDEN", "resolution.ranks[0].when"],
    ["raw_target in a targetless margin", { roll: "3d6>=5", target: "none", ranks: [{ id: "x" }], margin: "successes - raw_target" }, "TARGET_FORBIDDEN", "resolution.margin"],
    ["transform reads the roll", base({ difficulties: { hard: { target: "roll + 5" } } }), "UNKNOWN_NAME", "resolution.difficulties.hard.target"],
    ["transform with a constant division by zero", base({ difficulties: { odd: { target: "target + 1 / 0" } } }), "BAD_EXPRESSION", "resolution.difficulties.odd.target"],
    ["duplicate prefix locale", base({ difficulties: { hard: { prefixes: { en: ["hard"], EN: ["tough"] } } } }), "DUPLICATE_ID", "resolution.difficulties.hard.prefixes.EN"],
    ["variant without ranks", base({ variants: { house: {} } }), "BAD_FIELD", "resolution.variants.house"],
    ["variant id not a slug", base({ variants: { "House Rule": { ranks: LADDER } } }), "BAD_ID", "resolution.variants.House Rule"],
    ["param max below min", base({ params: { n: { min: 5, max: 1 } } }), "BAD_RANGE", "resolution.params.n"],
    ["param bound not an integer", base({ params: { n: { min: 1, max: "9" } } }), "BAD_FIELD", "resolution.params.n.max"],
    ["param without bounds", base({ params: { n: { default: 1 } } }), "BAD_FIELD", "resolution.params.n.min"],
    ["check routes to an undeclared modifier", base({ check: { favorable: "boon" } }), "UNDECLARED_MODIFIER", "resolution.check.favorable"],
    ["default target not an integer", base({ check: { default_target: 12.5 } }), "BAD_FIELD", "resolution.check.default_target"],
  ];
  for (const [name, section, code, path] of cases) {
    test(name, () => {
      const error = compileError(section);
      expect({ code: error.code, path: error.path, packId: error.packId }).toEqual({ code, path, packId: "testpack" });
    });
  }

  test("an expression error carries its cause", () => {
    const error = compileError(base({ ranks: [{ id: "hit", when: "roll >=" }, { id: "miss" }] }));
    expect((error as Error & { cause?: unknown }).cause).toBeDefined();
  });
});

describe("compiled objects", () => {
  test("are frozen all the way down, and their tables cannot be changed", () => {
    const r = pack("coc7");
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.ladder)).toBe(true);
    expect(Object.isFrozen(r.ladder[0])).toBe(true);
    expect(Object.isFrozen(r.ladder[0]!.rank)).toBe(true);
    expect(Object.isFrozen(r.check)).toBe(true);
    expect(r.variants).toBeInstanceOf(FrozenMap);
    expect("set" in r.variants).toBe(false);
    expect(Object.isFrozen(r.difficulties.get("hard")!.prefixes.get("en"))).toBe(true);
  });

  test("keep declared order", () => {
    const r = pack("coc7");
    expect([...r.variants.keys()]).toEqual(["rule1", "rule2", "rule3", "rule4", "rule5", "dg"]);
    expect([...r.difficulties.keys()]).toEqual(["regular", "hard", "extreme", "critical"]);
    expect([...pack("wod").params.keys()]).toEqual(["pool", "difficulty"]);
  });

  test("an undeclared tier counts down from the top of the ladder", () => {
    const r = compileResolution("t", base({ ranks: [{ id: "a", when: "roll > 15" }, { id: "b", when: "roll > 5" }, { id: "c" }] }));
    expect(r.ladder.map((rule) => rule.rank.tier)).toEqual([2, 1, 0]);
  });
});

describe("grading", () => {
  test("a missing target is ABSENT, never 0 (ruling 2)", () => {
    const dnd = pack("dnd5e");
    // Read as 0, `roll >= target` would grade this a success.
    expect(codeOf(() => gradeCheck(dnd, { total: 10, dice: [10] }))).toBe("TARGET_REQUIRED");
    expect(codeOf(() => gradeCheck(dnd, { total: 10, dice: [10] }, { target: null }))).toBe("TARGET_REQUIRED");
    // A rank decided before the ladder reaches `target` still grades.
    expect(gradeCheck(dnd, { total: 20, dice: [20] }).rank.id).toBe("crit");
    // A targetless system grades without one.
    expect(gradeCheck(pack("wod"), { total: 2, dice: [6, 9, 3], successes: 2, ones: 0 }).rank.id).toBe("success");
  });

  test("a ladder reading a face the roll did not keep fails with DIE_MISSING", () => {
    expect(codeOf(() => gradeCheck(pack("dnd5e"), { total: 12, dice: [] }, { target: 10 }))).toBe("DIE_MISSING");
  });

  test("carries the rank, flags, margin and both targets as data, no labels", () => {
    const outcome = gradeCheck(pack("coc7"), { total: 9, dice: [9] }, { target: 50, difficulty: "extreme", variant: "rule3" });
    expect(outcome).toEqual({
      rank: { id: "extreme", tier: 4, success: true, critical: false, fumble: false },
      margin: 1,
      target: 50,
      effectiveTarget: 10,
      roll: 9,
      variant: "rule3",
    });
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  test("an unknown variant grades by the default ladder; an unknown difficulty is the identity", () => {
    const coc = pack("coc7");
    expect(gradeCheck(coc, { total: 3, dice: [3] }, { target: 50, variant: "nope" }).variant).toBeNull();
    expect(effectiveTarget(coc, 50, "nope")).toBe(50);
    expect(effectiveTarget(coc, 50, "HARD")).toBe(50);
  });

  test("pack names are content: prototype names are never members", () => {
    const coc = pack("coc7");
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(gradeCheck(coc, { total: 3, dice: [3] }, { target: 50, variant: name }).variant).toBeNull();
      expect(effectiveTarget(coc, 50, name)).toBe(50);
    }
    const wod = pack("wod");
    const inherited = Object.create({ pool: 9 }) as Record<string, unknown>;
    expect(Object.fromEntries(clampParams(wod, inherited))).toEqual({ pool: 1, difficulty: 6 });
  });

  test("fractions truncate toward zero, in effective targets and margins (ruling 6)", () => {
    const r = compileResolution("t", base({ difficulties: { third: { target: "target / 3" } }, margin: "(roll - target) / 4" }));
    expect(effectiveTarget(r, -4, "third")).toBe(-1); // floor would give -2
    expect(effectiveTarget(r, 10, "third")).toBe(3);
    expect(gradeCheck(r, { total: 5, dice: [5] }, { target: 7 }).margin).toBe(0); // -0.5 -> 0, not -0
    expect(Object.is(gradeCheck(r, { total: 5, dice: [5] }, { target: 7 }).margin, -0)).toBe(false);
    expect(gradeCheck(r, { total: 1, dice: [1] }, { target: 7 }).margin).toBe(-1); // -1.5 -> -1
  });

  test("refuses values that are not safe integers", () => {
    const dnd = pack("dnd5e");
    expect(codeOf(() => gradeCheck(dnd, { total: 1.5, dice: [1] }, { target: 1 }))).toBe("INVALID_ROLL");
    expect(codeOf(() => gradeCheck(dnd, { total: 1, dice: [Number.NaN] }, { target: 1 }))).toBe("INVALID_ROLL");
    expect(codeOf(() => gradeCheck(dnd, { total: 1, dice: [1] }, { target: 7.5 }))).toBe("INVALID_TARGET");
    expect(codeOf(() => gradeCheck(dnd, { total: 1, dice: [1] }, { target: 7, modifier: 0.5 }))).toBe("INVALID_MODIFIER");
  });

  test("a value an expression cannot compute is EXPRESSION_FAILED", () => {
    const r = compileResolution("t", base({ difficulties: { odd: { target: "100 / (target - 1)" } } }));
    expect(effectiveTarget(r, 5, "odd")).toBe(25);
    expect(codeOf(() => effectiveTarget(r, 1, "odd"))).toBe("EXPRESSION_FAILED");
  });
});

describe("rolling", () => {
  test("the pack's pool parameters reach the dice (ruling 3)", () => {
    const wod = pack("wod");
    const rolled = rollCheck(wod, new SeededRandom("pool"), { params: { pool: 7, difficulty: 8 } });
    expect(rolled.dice.length).toBe(7);
    expect(rolled.roll?.root.kind === "pool" && rolled.roll.root.threshold).toBe(8);
    expect(Object.fromEntries(rolled.params)).toEqual({ pool: 7, difficulty: 8 });
    const performed = performCheck(wod, new SeededRandom("pool"), { params: { pool: 7, difficulty: 8 } });
    expect(performed.rolled.dice.length).toBe(7);
    expect(performed.outcome).not.toBeNull();
  });

  test("parameters are clamped and parsed strictly", () => {
    const wod = pack("wod");
    expect(Object.fromEntries(clampParams(wod, new Map<string, unknown>([["pool", " 300 "]])))).toEqual({ pool: 200, difficulty: 6 });
    expect(codeOf(() => clampParams(wod, { pool: "12abc" }))).toBe("INVALID_PARAM");
    expect(codeOf(() => clampParams(wod, { pool: "1e3" }))).toBe("INVALID_PARAM");
    expect(codeOf(() => clampParams(wod, { pool: Number.POSITIVE_INFINITY }))).toBe("INVALID_PARAM");
    expect(codeOf(() => clampParams(wod, { pool: true }))).toBe("INVALID_PARAM");
    expect(codeOf(() => clampParams(wod, { pool: null }))).toBe("MISSING_PARAM");
    const bare = compileResolution("t", { roll: "{n}d6>=5", target: "none", ranks: [{ id: "x" }], params: { n: { min: 1, max: 9 } } });
    const error = (() => {
      try {
        clampParams(bare, {});
      } catch (caught) {
        return caught as ResolutionError;
      }
    })();
    expect({ code: error?.code, param: error?.param }).toEqual({ code: "MISSING_PARAM", param: "n" });
  });

  test("an undeclared modifier name is refused, before any draw", () => {
    const random = new ScriptedRandom([]);
    expect(codeOf(() => rollCheck(pack("dnd5e"), random, { modifiers: [["bonus", 1]] }))).toBe("UNKNOWN_MODIFIER");
    expect(codeOf(() => rollCheck(pack("dnd5e"), random, { modifiers: [["advantage", 1.5]] }))).toBe("INVALID_COUNT");
  });

  test("a bad target is refused before the roll consumes randomness", () => {
    const random = new ScriptedRandom([]);
    expect(codeOf(() => performCheck(pack("dnd5e"), random, { target: 7.5 }))).toBe("INVALID_TARGET");
    expect(random.consumed).toBe(0);
  });

  test("a check-kind system rolled without a target is left ungraded", () => {
    const performed = performCheck(pack("dnd5e"), new ScriptedRandom([{ lo: 1, hi: 20, value: 12, step: 1 }]), { modifier: 3 });
    expect(performed.outcome).toBeNull();
    expect(performed.total).toBe(15);
  });

  test("a dice failure is a ROLL_FAILED with its cause", () => {
    const r = compileResolution("t", { roll: "{n}d6>=5", target: "none", ranks: [{ id: "x" }], params: { n: { min: -5, max: 9 } } });
    expect(codeOf(() => rollCheck(r, new SeededRandom(1), { params: { n: -2 } }))).toBe("ROLL_FAILED");
  });

  test("bonus and penalty dice net into one percentile roll", () => {
    const random = new ScriptedRandom([
      { lo: 1, hi: 100, value: 57, step: 1 },
      { lo: 0, hi: 9, value: 2, step: 1 },
    ]);
    const rolled = rollCheck(pack("coc7"), random, { modifiers: [["bonus", 2], ["penalty", 1]] });
    expect(rolled.total).toBe(27);
    expect(rolled.dice).toEqual([27]);
    expect(rolled.percentile?.extraTens).toEqual([2]);
    expect(Object.fromEntries(rolled.modifiers)).toEqual({ bonus: 2, penalty: 1 });
  });
});

describe("Luck", () => {
  const coc: Resolution = pack("coc7");
  const grade = (roll: number) => gradeCheck(coc, { total: roll, dice: [roll] }, { target: 50 }).rank;

  test("lowers the roll and re-grades it", () => {
    expect(spendLuck({ roll: 60, points: 15, alreadySpent: 3, grade })).toEqual({
      beforeRoll: 60,
      afterRoll: 45,
      before: grade(60),
      after: grade(45),
      totalSpent: 18,
    });
  });

  test("refusals", () => {
    expect(codeOf(() => spendLuck({ roll: 60, points: 0, grade }))).toBe("LUCK_POINTS_NOT_POSITIVE");
    expect(codeOf(() => spendLuck({ roll: 100, points: 5, grade }))).toBe("LUCK_FUMBLE");
    expect(codeOf(() => spendLuck({ roll: 10, points: 10, grade }))).toBe("LUCK_EXCEEDS_ROLL");
    expect(codeOf(() => spendLuck({ roll: 60, points: 5, alreadySpent: -1, grade }))).toBe("INVALID_COUNT");
  });
});
