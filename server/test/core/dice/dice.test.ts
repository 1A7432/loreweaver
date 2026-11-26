// Direct tests of the dice engine: the owner's rulings, the limits, every error code, and
// the JavaScript traps (code points, full-width input, exact integers).
import { describe, expect, test } from "bun:test";

import {
  DiceError,
  type DiceErrorCode,
  LIMITS,
  naturalCritical,
  parseDice,
  primaryDice,
  renderRoll,
  type Roll,
  type RollOptions,
  rollAdvantage,
  rollDice,
  rollPercentileTens,
  rollRepeated,
} from "../../../src/core/dice/index.ts";
import { type RandomSource, ScriptedRandom } from "../../../src/core/random.ts";

/** Scripted faces for dice of `sides` (one size per call; use `draws` for mixed sizes). */
function faces(sides: number, ...values: number[]): ScriptedRandom {
  return new ScriptedRandom(values.map((value) => ({ lo: 1, hi: sides, step: 1, value })));
}

function roll(notation: string, random: RandomSource = new ScriptedRandom([]), options?: RollOptions): Roll {
  return rollDice(notation, random, options);
}

function codeOf(run: () => unknown): DiceErrorCode | "no error" {
  try {
    run();
  } catch (error) {
    if (error instanceof DiceError) return error.code;
    throw error;
  }
  return "no error";
}

function positionOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof DiceError) return error.position;
    throw error;
  }
  return undefined;
}

function dice(r: Roll) {
  const group = primaryDice(r);
  if (group === null) throw new Error("no dice");
  return group.dice;
}

describe("ruling 1: rerolls go left to right", () => {
  test("rr rerolls each matching die in position order, until none match", () => {
    const r = roll("3d6rr1", faces(6, 1, 1, 4, 2, 1, 5));
    // Round one rerolls die 0 then die 1 (1,1,4 -> 2,1,4); round two only die 1 (-> 2,5,4).
    expect(dice(r).map((d) => d.rolls)).toEqual([[1, 2], [1, 1, 5], [4]]);
    expect(r.total).toBe(11);
  });

  test("ro rerolls once, left to right", () => {
    const r = roll("2d6ro1", faces(6, 1, 1, 1, 4));
    expect(dice(r).map((d) => d.rolls)).toEqual([[1, 1], [1, 4]]);
    expect(r.total).toBe(5);
  });
});

describe("ruling 2: a dropped die keeps its face", () => {
  test("2d20kh1 shows the dropped die's real face, marked dropped", () => {
    const r = roll("2d20kh1", faces(20, 20, 7));
    expect(dice(r)).toEqual([
      { face: 20, rolls: [20], kept: true, exploded: false },
      { face: 7, rolls: [7], kept: false, exploded: false },
    ]);
    expect(r.total).toBe(20);
  });

  test("a dropped set member keeps its value, marked dropped", () => {
    const r = roll("(1, 2, 3)kh2");
    expect(r.root.kind === "set" && r.root.items.map((i) => [i.value, i.kept])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect(r.total).toBe(5);
  });
});

describe("ruling 3: 0dF rolls zero dice", () => {
  test("0dF draws nothing and totals 0", () => {
    expect(roll("0dF").total).toBe(0);
    expect(dice(roll("0dF+3"))).toEqual([]);
    expect(roll("0dF+3").total).toBe(3);
  });

  test("a bare dF rolls four Fate dice; an explicit count means what it says", () => {
    const fate: RandomSource = { nextInt: (lo) => lo };
    expect(dice(roll("dF", fate)).length).toBe(4);
    expect(dice(roll("DF+1", fate)).length).toBe(4);
    expect(dice(roll("1dF", fate)).length).toBe(1);
    expect(dice(roll("3dF", fate)).length).toBe(3);
    expect(dice(roll("0dF", fate)).length).toBe(0);
    expect(parseDice("dF").notation).toBe("4dF");
    expect(parseDice("df-1").root).toEqual(parseDice("4dF-1").root);
    // Only Fate dice default to four.
    expect(dice(roll("d6", faces(6, 3))).length).toBe(1);
  });

  test("NdF draws -1..1 per die", () => {
    const random = new ScriptedRandom([-1, 0, 1, 1].map((value) => ({ lo: -1, hi: 1, step: 1, value })));
    const r = roll("4dF+2", random);
    expect(dice(r).map((d) => d.face)).toEqual([-1, 0, 1, 1]);
    expect(r.total).toBe(3);
    expect(primaryDice(r)?.sides).toBe("F");
  });
});

describe("ruling 4: one error type with a code per failure", () => {
  const cases: [string, DiceErrorCode][] = [
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["abc", "SYNTAX"],
    ["1d20 sword", "SYNTAX"],
    ["1d", "SYNTAX"],
    ["1d6k", "SYNTAX"],
    ["(1d6", "SYNTAX"],
    ["1d20 [unclosed", "SYNTAX"],
    ["6d6p>=3", "SYNTAX"],
    ["1d20mih5", "SYNTAX"],
    ["1e3", "SYNTAX"],
    ["1_000", "SYNTAX"],
    ["1d6!!", "SYNTAX"],
    ["{ pool }d6", "SYNTAX"],
    ["{1pool}d6", "SYNTAX"],
    ["1001d6", "TOO_MANY_DICE"],
    ["999999999d6", "TOO_MANY_DICE"],
    ["1d1rr1", "TOO_MANY_DICE"],
    ["1d1!", "TOO_MANY_DICE"],
    ["1d1000000001", "TOO_MANY_SIDES"],
    ["1d0", "ZERO_SIDED_DIE"],
    ["0d10>=6", "BAD_POOL"],
    ["5d1>=1", "BAD_POOL"],
    ["5/0", "DIVISION_BY_ZERO"],
    ["1d20//0", "DIVISION_BY_ZERO"],
    ["1d20%0", "DIVISION_BY_ZERO"],
    ["9007199254740992", "VALUE_TOO_LARGE"],
    ["9007199254740991+1", "VALUE_TOO_LARGE"],
    ["99999999999*99999999", "VALUE_TOO_LARGE"],
    ["{x}", "MISSING_PARAM"],
  ];
  for (const [notation, code] of cases) {
    test(`${JSON.stringify(notation)} -> ${code}`, () => {
      const random: RandomSource = { nextInt: (lo) => lo };
      expect(codeOf(() => roll(notation, random))).toBe(code);
    });
  }

  test("the message is the code and position, not a sentence", () => {
    try {
      parseDice("1d6 +");
      throw new Error("parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(DiceError);
      expect((error as DiceError).message).toBe("SYNTAX at 5");
    }
  });

  test("slot values must be safe integers and may not make a count negative", () => {
    const random: RandomSource = { nextInt: (lo) => lo };
    expect(codeOf(() => roll("{n}d6", random, { params: { n: Number.NaN } }))).toBe("BAD_PARAM");
    expect(codeOf(() => roll("{n}d6", random, { params: { n: 1.5 } }))).toBe("BAD_PARAM");
    expect(codeOf(() => roll("{n}d6", random, { params: { n: -3 } }))).toBe("BAD_PARAM");
    expect(codeOf(() => roll("1d{n}", random, { params: new Map([["n", -1]]) }))).toBe("BAD_PARAM");
    // An inherited property is not a parameter.
    expect(codeOf(() => roll("{constructor}", random, { params: {} }))).toBe("MISSING_PARAM");
    expect(roll("1d20+{bonus}", faces(20, 10), { params: { bonus: -3 } }).total).toBe(7);
  });

  test("the special rollers' counts are checked", () => {
    const random: RandomSource = { nextInt: (lo) => lo };
    expect(codeOf(() => rollRepeated("1d6", 0, random))).toBe("BAD_COUNT");
    expect(codeOf(() => rollRepeated("1d6", LIMITS.maxRepeat + 1, random))).toBe("BAD_COUNT");
    expect(codeOf(() => rollPercentileTens(random, Number.NaN))).toBe("BAD_COUNT");
    expect(codeOf(() => roll("1d6", random, { maxDice: -1 }))).toBe("BAD_COUNT");
  });
});

describe("ruling 5: one meaning per notation", () => {
  test("a whole `NdM>=K` / `NdM<=K` is a success pool", () => {
    const r = roll("5d10>=6", faces(10, 1, 6, 5, 1, 7));
    expect(r.root.kind).toBe("pool");
    expect(r.total).toBe(2);
    expect(r.root.kind === "pool" && [r.root.successes, r.root.ones]).toEqual([2, 2]);
    expect(roll("5d10<=3", faces(10, 1, 2, 3, 4, 10)).total).toBe(3);
    expect(parseDice("d10 >= 6").root.kind).toBe("pool");
    expect(parseDice("{pool}d10>={difficulty}").root.kind).toBe("pool");
    expect(roll("{pool}d10>={difficulty}", faces(10, 6, 1, 9), { params: { pool: 3, difficulty: 7 } }).total).toBe(1);
  });

  test("every other comparison compares totals and yields 1 or 0", () => {
    for (const notation of ["(5d10)>=6", "5d10>=6+0", "1d20>10", "2d20kh1>=10", "5d10!>=8", "1d20>=10 [x]"]) {
      expect(parseDice(notation).root.kind).toBe("binary");
    }
    expect(roll("(3d6)>=10", faces(6, 1, 3, 6)).total).toBe(1);
    expect(roll("3d6>=3", faces(6, 1, 3, 6)).total).toBe(2);
  });

  test("Fate dice and `!` read the same through every roller", () => {
    const fate = (): RandomSource => ({ nextInt: (lo) => lo });
    expect(rollAdvantage("4dF", fate(), "advantage").kept.total).toBe(-4);
    expect(rollRepeated("2dF", 2, fate()).map((r) => r.total)).toEqual([-2, -2]);
  });
});

describe("ruling 6: `!` explodes everywhere", () => {
  test("NdM! explodes on the highest face, again for new dice", () => {
    const r = roll("1d6!", faces(6, 6, 6, 2));
    expect(dice(r).map((d) => [d.face, d.exploded])).toEqual([
      [6, true],
      [6, true],
      [2, false],
    ]);
    expect(r.total).toBe(14);
  });

  test("! combines with other operators and in every roller", () => {
    expect(roll("3d6!kh2", faces(6, 6, 1, 2, 3)).total).toBe(9);
    expect(rollAdvantage("1d6!", faces(6, 6, 1, 3), "advantage").candidates.map((r) => r.total)).toEqual([7, 3]);
    expect(rollRepeated("1d4!", 2, faces(4, 4, 1, 2)).map((r) => r.total)).toEqual([5, 2]);
    expect(parseDice("1d6!").notation).toBe("1d6!");
  });

  test("`!=` stays a comparison; `!==` is an explosion then `==`", () => {
    expect(roll("1d20!=5", faces(20, 5)).total).toBe(0);
    expect(roll("1d6!==8", faces(6, 6, 2)).total).toBe(1);
  });

  test("percentile tens and Fate dice explode on their own highest face", () => {
    const random = new ScriptedRandom([
      { lo: 0, hi: 90, step: 10, value: 90 },
      { lo: 0, hi: 90, step: 10, value: 30 },
    ]);
    expect(roll("1d%!", random).total).toBe(120);
  });
});

describe("limits", () => {
  test("1000 dice are allowed, 1001 refused before any draw", () => {
    expect(roll("1000d1", faces(1, ...Array<number>(1000).fill(1))).total).toBe(1000);
    // An empty script fails the test if the engine draws at all.
    expect(codeOf(() => roll("1001d6"))).toBe("TOO_MANY_DICE");
    const random = faces(6, ...Array<number>(500).fill(3));
    expect(codeOf(() => roll("500d6+501d6", random))).toBe("TOO_MANY_DICE");
    expect(random.consumed).toBe(500);
  });

  test("maxDice lowers the budget for one roll, never raises it", () => {
    expect(codeOf(() => roll("1d6!", faces(6, 6, 6, 6), { maxDice: 2 }))).toBe("TOO_MANY_DICE");
    expect(roll("1d6!", faces(6, 6, 1), { maxDice: 2 }).total).toBe(7);
    expect(codeOf(() => roll("1001d6", undefined, { maxDice: 5000 }))).toBe("TOO_MANY_DICE");
  });

  test("notation length and nesting are bounded", () => {
    expect(codeOf(() => parseDice("1".repeat(LIMITS.maxNotationLength + 1)))).toBe("TOO_LONG");
    expect(codeOf(() => parseDice(`${"(".repeat(LIMITS.maxDepth + 1)}1${")".repeat(LIMITS.maxDepth + 1)}`))).toBe("TOO_DEEP");
    expect(codeOf(() => parseDice(`${"-".repeat(LIMITS.maxDepth + 1)}1`))).toBe("TOO_DEEP");
    expect(parseDice(`${"(".repeat(LIMITS.maxDepth)}1${")".repeat(LIMITS.maxDepth)}`).root.kind).toBe("group");
  });

  test("0d0 rolls nothing and is not an error; a die with no faces is, once rolled", () => {
    expect(roll("0d0").total).toBe(0);
    expect(codeOf(() => roll("1d0"))).toBe("ZERO_SIDED_DIE");
  });
});

describe("text: code points, full-width input, labels", () => {
  test("error positions count code points", () => {
    expect(positionOf(() => parseDice("侦查"))).toBe(0);
    expect(positionOf(() => parseDice("1d20 + 剑"))).toBe(7);
    // The die emoji is two UTF-16 units but one position.
    expect(positionOf(() => parseDice("🎲 1d6"))).toBe(0);
    expect(positionOf(() => parseDice("1d6 [🎲] y"))).toBe(8);
  });

  test("full-width ASCII forms and the ideographic space read as ASCII", () => {
    expect(parseDice("１ｄ２０＋５").root).toEqual(parseDice("1d20+5").root);
    expect(parseDice("（２ｄ６＋６）×５").root).toEqual(parseDice("(2d6+6)*5").root);
    expect(parseDice("1d20　+　5").root).toEqual(parseDice("1d20 + 5").root);
    expect(parseDice("5ｄ10＞＝6").root.kind).toBe("pool");
  });

  test("other digits are not digits", () => {
    expect(codeOf(() => parseDice("١d6"))).toBe("SYNTAX");
  });

  test("labels keep their text as typed, CJK included", () => {
    const r = roll("1d20 [长剑 Sword] + 5 [加值]", faces(20, 14));
    expect(primaryDice(r)?.labels).toEqual(["长剑 Sword"]);
    expect(r.total).toBe(19);
    expect(renderRoll(r)).toBe("1d20 (14) [长剑 Sword] + 5 [加值] = 19");
  });

  test("letters are case-insensitive, slot names are not", () => {
    expect(parseDice("3D6X5").root).toEqual(parseDice("3d6*5").root);
    expect(parseDice("4DF").root).toEqual(parseDice("4dF").root);
    expect(codeOf(() => roll("{Pool}d6", undefined, { params: { pool: 1 } }))).toBe("MISSING_PARAM");
    expect(roll("1d20+{先攻修正}", faces(20, 10), { params: { 先攻修正: 2 } }).total).toBe(12);
  });
});

describe("arithmetic", () => {
  const cases: [string, number][] = [
    ["-7//2", -4],
    ["7//-2", -4],
    ["-7%3", 2],
    ["7%-3", -2],
    ["10/4*2", 5],
    ["10/3", 3],
    ["-10/3", -3],
    ["1.5+1.5", 3],
    [".5*4", 2],
    ["5.*2", 10],
    ["2+3*4", 14],
    ["-2*3", -6],
    ["--5", 5],
    ["1<2<3", 1],
    ["0x10", 0],
    ["(1,2,3)kh2", 5],
    ["(1,2,3)pl1", 5],
    ["()", 0],
    ["(5,)", 5],
    ["-0.4", 0],
  ];
  for (const [notation, total] of cases) {
    test(`${notation} = ${total}`, () => {
      const r = roll(notation);
      expect(r.total).toBe(total);
      expect(Object.is(r.total, -0)).toBe(false);
    });
  }
});

describe("operators", () => {
  test("a bare k keeps the highest; a bare p drops equal faces", () => {
    expect(roll("4d6k3", faces(6, 3, 1, 6, 2)).total).toBe(11);
    expect(roll("4d6p1", faces(6, 1, 1, 3, 4)).total).toBe(7);
    expect(parseDice("4d6k3").notation).toBe("4d6kh3");
  });

  test("consecutive same operators act on the union of their selectors", () => {
    expect(roll("8d6k2kh1", faces(6, 1, 2, 3, 4, 5, 6, 1, 1)).total).toBe(11);
  });

  test("k/p on a group reach into its dice", () => {
    expect(roll("(4d6)kh3", faces(6, 3, 1, 6, 2)).total).toBe(11);
  });

  test("mi/ma move a face and keep the roll that was made", () => {
    const r = roll("1d20mi5", faces(20, 1));
    expect(dice(r)).toEqual([{ face: 5, rolls: [1], kept: true, exploded: false }]);
    expect(renderRoll(r)).toBe("1d20mi5 (1 => 5) = 5");
  });

  test("ra adds one die for the first match only", () => {
    expect(roll("2d6ra1", faces(6, 1, 1, 5)).total).toBe(7);
  });
});

describe("special rollers", () => {
  test("advantage keeps the higher total, disadvantage the lower, the first on a tie", () => {
    expect(rollAdvantage("1d20", faces(20, 8, 17), "advantage").keptIndex).toBe(1);
    expect(rollAdvantage("1d20", faces(20, 8, 17), "disadvantage").keptIndex).toBe(0);
    expect(rollAdvantage("1d20", faces(20, 9, 9), "advantage").keptIndex).toBe(0);
    expect(rollAdvantage("1d20", faces(20, 9, 9), "disadvantage").keptIndex).toBe(0);
  });

  test("percentile tens dice compare by the d100 they make", () => {
    const script = (base: number, ...tens: number[]) =>
      new ScriptedRandom([{ lo: 1, hi: 100, step: 1, value: base }, ...tens.map((value) => ({ lo: 0, hi: 9, step: 1, value }))]);
    // 100 is tens 0 + ones 0: a bonus die of 3 improves it to 30, a penalty die never worsens it.
    expect(rollPercentileTens(script(100, 3), 1)).toEqual({ base: 100, tens: 0, ones: 0, extraTens: [3], finalTens: 3, total: 30 });
    expect(rollPercentileTens(script(100, 3), -1).total).toBe(100);
    expect(rollPercentileTens(script(57, 2, 8), 2).total).toBe(27);
    expect(rollPercentileTens(script(57, 2, 8), -2).total).toBe(87);
    expect(rollPercentileTens(script(57), 0).total).toBe(57);
  });

  test("extra tens dice stop at the cap", () => {
    const random = new ScriptedRandom([
      { lo: 1, hi: 100, step: 1, value: 50 },
      ...Array.from({ length: LIMITS.maxTensDice }, () => ({ lo: 0, hi: 9, step: 1, value: 9 })),
    ]);
    expect(rollPercentileTens(random, 1e8).extraTens.length).toBe(LIMITS.maxTensDice);
    expect(random.remaining).toBe(0);
  });
});

describe("natural critical", () => {
  test("single kept die: max face succeeds, 1 fails; d100 the other way round", () => {
    expect(naturalCritical(20, [20])).toBe("success");
    expect(naturalCritical(20, [1])).toBe("failure");
    expect(naturalCritical(20, [10])).toBeNull();
    expect(naturalCritical(100, [1])).toBe("success");
    expect(naturalCritical(100, [100])).toBe("failure");
  });

  test("none for several dice, percentile tens, Fate, or a die that cannot vary", () => {
    expect(naturalCritical(20, [20, 20])).toBeNull();
    expect(naturalCritical("%", [0])).toBeNull();
    expect(naturalCritical("F", [1])).toBeNull();
    expect(naturalCritical(1, [1])).toBeNull();
  });

  test("advantage's kept roll is still a single-die roll", () => {
    const kept = rollAdvantage("1d20", faces(20, 20, 3), "advantage").kept;
    const group = primaryDice(kept);
    expect(group && naturalCritical(group.sides, [group.dice[0]?.face ?? 0])).toBe("success");
  });
});

describe("rendering", () => {
  const cases: [string, number[], string][] = [
    ["4d6kh3+2", [5, 3, 1, 6], "4d6kh3 (5, 3, ~~1~~, 6) + 2 = 16"],
    ["3d6rr1", [1, 2, 5, 4], "3d6rr1 (1 -> 4, 2, 5) = 11"],
    ["1d6!", [6, 2], "1d6! (6!, 2) = 8"],
    ["5d10>=6", [1, 6, 5, 1, 7], "5d10 (1, 6, 5, 1, 7) >= 6 = 2"],
    ["(1d6, 1d6)kh1", [2, 5], "(~~1d6 (2)~~, 1d6 (5))kh1 = 5"],
    ["d20", [7], "1d20 (7) = 7"],
  ];
  for (const [notation, values, text] of cases) {
    test(notation, () => {
      const sides = Number(/d(\d+)/.exec(notation)?.[1]);
      expect(renderRoll(roll(notation, faces(sides, ...values)))).toBe(text);
    });
  }

  test("no dice", () => {
    expect(renderRoll(roll("2*3+4"))).toBe("2 * 3 + 4 = 10");
  });
});

describe("canonical notation", () => {
  const notations = [
    "4d6k3+2",
    "3D6X5",
    "(2d6+6)×5",
    "1d20 [sword] + 5 [bonus]",
    "(1d6, 2d6, 3)kh2",
    "(1d20,)",
    "()",
    "-(1d6+2)",
    "--1d6",
    "3d6rr1rr2",
    "1d8e8e1",
    "1d10e>8",
    "5d6!kh3",
    "1d%+1d10",
    "4dF-1",
    "dF+2",
    "{pool}d10>={difficulty}",
    "1d20+{先攻修正}",
    ".5+1d6",
    "1d20>=10+0",
    "7//2%3",
  ];
  for (const notation of notations) {
    test(`${notation} round-trips`, () => {
      const parsed = parseDice(notation);
      expect(parseDice(parsed.notation).root).toEqual(parsed.root);
      expect(parseDice(parsed.notation).notation).toBe(parsed.notation);
    });
  }
});
