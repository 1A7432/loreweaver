import { describe, expect, test } from "bun:test";

import {
  ABSENT,
  compile,
  ExprError,
  type ExprErrorCode,
  FUNCTION_NAMES,
  MAX_DEPTH,
  MAX_SOURCE_LENGTH,
  MAX_TOKENS,
  mapResolver,
  recordResolver,
  type Resolver,
  truthy,
  type Value,
} from "../../src/core/condexpr.ts";

const ALL = { functions: FUNCTION_NAMES };

function run(source: string, values: Record<string, unknown> = {}, absent: "null" | "error" = "null"): Value {
  return compile(source, ALL).evaluate(recordResolver(values), { absent });
}

function failure(action: () => unknown): ExprError {
  try {
    action();
  } catch (error) {
    if (error instanceof ExprError) return error;
    throw error;
  }
  throw new Error("expected an ExprError");
}

function compileError(source: string, options: Parameters<typeof compile>[1] = ALL): ExprError {
  return failure(() => compile(source, options));
}

function runError(source: string, values: Record<string, unknown> = {}, absent: "null" | "error" = "null"): ExprError {
  const compiled = compile(source, ALL);
  return failure(() => compiled.evaluate(recordResolver(values), { absent }));
}

describe("literals and references", () => {
  test.each<[string, Value]>([
    ["42", 42],
    ["3.5", 3.5],
    ["007", 7],
    ["'hello'", "hello"],
    ['"double"', "double"],
    ["'it\\'s'", "it's"],
    ["'a\\nb'", "anb"], // a backslash takes the next character literally; there are no escape sequences
    ["true", true],
    ["FALSE", false],
    ["null", null],
    ["undefined", null],
    ["None", null],
  ])("%s", (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  test("bare, dotted, CJK and root-prefixed paths reach the resolver verbatim", () => {
    const seen: string[] = [];
    const resolve: Resolver = (path) => {
      seen.push(path);
      return 2;
    };
    for (const source of ["town_fear", "理.好感度", "variables.stage", "stat_data.理.情绪", "𠀀字", "_x1"]) {
      expect(compile(source).evaluate(resolve)).toBe(2);
    }
    expect(seen).toEqual(["town_fear", "理.好感度", "variables.stage", "stat_data.理.情绪", "𠀀字", "_x1"]);
  });

  test.each<[string, string]>([
    ["party[0].hp", "party.0.hp"],
    ["a['key']", "a.key"],
    ['a["k k"]', "a.k k"],
    ["dice[0]", "dice.0"],
    ["队伍.0.血量", "队伍.0.血量"],
    ["a.1.0", "a.1.0"], // the reference read the segment `1.0` as a float and resolved `a.1`
    ["a.1.5", "a.1.5"],
    ["a.007", "a.7"],
    ["a[007]", "a.7"],
    ["getvar('好感度')", "好感度"],
    ["getvar('a.b', 0, 'x')", "a.b"],
  ])("%s resolves %s", (source, path) => {
    expect(compile(source).references).toEqual([path]);
    expect(compile(source).evaluate(mapResolver(new Map([[path, 9]])))).toBe(9);
  });

  test("references are deduplicated, in source order, and include skipped branches and getvar names", () => {
    const compiled = compile("b || a.x && getvar('g') > floor(c) || b || if(d, e, f)", ALL);
    expect(compiled.references).toEqual(["b", "a.x", "g", "c", "d", "e", "f"]);
    // getvar's ignored arguments read nothing.
    expect(compile("getvar('x', y + z)").references).toEqual(["x"]);
    // A function name is not a reference; the same word without a call is.
    expect(compile("floor(x) + floor", ALL).references).toEqual(["x", "floor"]);
  });
});

describe("precedence and associativity", () => {
  test.each<[string, Value]>([
    ["2 + 3 * 4", 14],
    ["(2 + 3) * 4", 20],
    ["10 - 4 - 3", 3], // left-associative
    ["100 / 10 / 5", 2],
    ["17 % 5 % 3", 2],
    ["2 * 3 % 4", 2], // * and % share a level, left to right
    ["-2 * 3", -6],
    ["- -2", 2],
    ["-(2 + 3)", -5],
    ["1 + 2 > 2", true], // arithmetic binds tighter than comparison
    ["2 * 3 == 6 && 1", 1],
  ])("%s", (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  test("`!` binds looser than comparison: `!a == b` is `!(a == b)`", () => {
    expect(run("!a == b", { a: 1, b: false })).toBe(true); // !(1 == false)
    expect(run("!a == b", { a: 0, b: true })).toBe(true); // !(0 == true); JavaScript would say false
    expect(run("!(a == b)", { a: 1, b: 1 })).toBe(false);
    expect(run("!!a", { a: "x" })).toBe(true);
    expect(run("not not a", { a: 0 })).toBe(false);
  });

  test("`&&` binds tighter than `||`; both return the deciding operand's value", () => {
    expect(run("1 || 0 && 0")).toBe(1);
    expect(run("(1 || 0) && 0")).toBe(0);
    expect(run("0 || 'x'")).toBe("x");
    expect(run("1 && 2")).toBe(2);
    expect(run("0 && 2")).toBe(0);
    expect(run("'' || null")).toBe(null);
    expect(run("a and not b or c", { a: 1, b: 1, c: "c" })).toBe("c");
  });

  test("short-circuited branches are neither resolved nor evaluated", () => {
    const seen: string[] = [];
    const resolve: Resolver = (path) => {
      seen.push(path);
      return path === "a";
    };
    expect(compile("a || boom").test(resolve)).toBe(true);
    expect(compile("!a && boom").test(resolve)).toBe(false);
    expect(compile("if(a, 1, boom)", ALL).evaluate(resolve)).toBe(1);
    expect(seen).not.toContain("boom");
    // A dead branch that WOULD fail does not (the reference evaluated it against a
    // placeholder value and could raise here).
    expect(run("false && note > 'a'", { note: "b" })).toBe(false);
    expect(run("x && 1 / x", { x: 0 })).toBe(0);
    expect(run("if(x > 0, 10 / x, 0)", { x: 0 })).toBe(0);
    // An absent name in a dead branch is fine even under absent: "error".
    expect(run("roll == 1 || roll <= target", { roll: 1 }, "error")).toBe(true);
  });

  test.each(["a < b < c", "a == b == c", "a === 1 !== b", "1 <= 2 <= 3"])("%s does not chain", (source) => {
    expect(compileError(source).code).toBe("CHAINED_COMPARISON");
  });
});

describe("equality", () => {
  // [left, right, ==, ===]
  test.each<[unknown, unknown, boolean, boolean]>([
    [5, 5, true, true],
    ["5", 5, true, false],
    [" 5 ", 5, true, false],
    ["5.0", 5, true, false],
    ["1.0", "1", true, false],
    ["1e3", 1000, true, false],
    ["+5", 5, true, false],
    [".5", 0.5, true, false],
    ["5.", 5, true, false],
    [true, 1, true, false],
    [false, 0, true, false],
    [true, "1", true, false],
    [true, true, true, true],
    ["", 0, false, false],
    [" ", 0, false, false],
    [null, 0, false, false],
    [null, false, false, false],
    [null, "", false, false],
    [null, null, true, true],
    ["abc", "abc", true, true],
    ["abc", "ABC", false, false],
    ["0x10", 16, false, false], // decimal numerals only
    ["Infinity", 1e308, false, false],
    ["1_000", 1000, false, false],
    ["NaN", "NaN", true, true], // equal as strings, never as numbers
    [2.5, 2.5, true, true],
    [[1, 2], [1, 2], true, true],
    [[1, 2], [2, 1], false, false],
    [[1], 1, false, false],
    [[true], [1], false, false],
    [{ a: 1 }, { a: 1 }, true, true],
    [{ a: 1 }, { a: "1" }, false, false],
    [{ a: 1 }, { b: 1 }, false, false],
    [[], {}, false, false],
  ])("%p vs %p", (left, right, loose, strict) => {
    const values = { l: left, r: right };
    expect(run("l == r", values)).toBe(loose);
    expect(run("l != r", values)).toBe(!loose);
    expect(run("l === r", values)).toBe(strict);
    expect(run("l !== r", values)).toBe(!strict);
    expect(run("r == l", values)).toBe(loose);
    expect(run("r === l", values)).toBe(strict);
  });

  test("one number type: an integral division result is === the integer", () => {
    // The reference's Python evaluator had int and float, so `4 / 2 === 2` was false.
    expect(run("4 / 2 === 2")).toBe(true);
    expect(run("2.0 === 2")).toBe(true);
  });
});

describe("ordering", () => {
  test.each<[string, Record<string, unknown>, boolean]>([
    ["fear >= 5", { fear: "7" }, true],
    ["fear < 5", { fear: "7" }, false],
    ["'apple' < 'banana'", {}, true],
    ["'10' > '9'", {}, true], // both numeric: compared as numbers
    ["'abc' > '9'", {}, true], // one is not numeric: compared as strings
    ["true > 0", {}, true],
    ["x <= 2", { x: 2.0 }, true],
    ["'Z' < 'a'", {}, true],
    ["a < b", { a: "￿", b: "😀" }, true], // code-point order, not UTF-16 units
    ["'' < 'a'", {}, true],
  ])("%s", (source, values, expected) => {
    expect(run(source, values)).toBe(expected);
  });

  test.each<[string, Record<string, unknown>]>([
    ["note > 5", { note: "abc" }],
    ["missing > 5", {}],
    ["missing < 'a'", {}],
    ["x < 1", { x: [1] }],
    ["x >= 0", { x: { a: 1 } }],
    ["x <= 'a'", { x: true }],
  ])("%s is an error, not false", (source, values) => {
    expect(runError(source, values).code).toBe("UNORDERABLE");
  });

  test.each(["'apple' > 5", "true < 'a'", "null >= 0"])("%s, all literals, is refused at compile time", (source) => {
    expect(compileError(source).code).toBe("UNORDERABLE");
  });
});

describe("arithmetic", () => {
  test.each<[string, Record<string, unknown>, Value]>([
    ["x * 2 + 1", { x: 4 }, 9],
    ["(x + 1) % 3", { x: 4 }, 2],
    ["-x", { x: 4 }, -4],
    ["-x", { x: "4" }, -4],
    ["-x", { x: true }, -1],
    ["'a' + 'b'", {}, "ab"],
    ["'1' + '2'", {}, "12"], // two strings concatenate, even numeric ones
    ["'1' + 2", {}, 3],
    ["x * 3", { x: "2" }, 6],
    ["true + true", {}, 2],
    ["7 / 2", {}, 3.5],
    ["-7 / 2", {}, -3.5],
    ["-7 % 3", {}, 2], // floored: the result takes the divisor's sign
    ["7 % -3", {}, -2],
    ["-7.5 % 2", {}, 0.5],
    ["6 % 3", {}, 0],
    ["-6 % 3", {}, 0],
    ["0 * -1", {}, 0],
    ["0.1 + 0.2", {}, 0.1 + 0.2],
    ["9007199254740990 + 1", {}, 9007199254740991],
  ])("%s", (source, values, expected) => {
    const result = run(source, values);
    expect(result).toEqual(expected);
    if (expected === 0) expect(Object.is(result, -0)).toBe(false);
  });

  test.each<[string, Record<string, unknown>, ExprErrorCode]>([
    ["x / 0", { x: 1 }, "DIVISION_BY_ZERO"],
    ["x % y", { x: 1, y: "0" }, "DIVISION_BY_ZERO"],
    ["x + 1", { x: null }, "TYPE_MISMATCH"],
    ["x - 1", { x: "abc" }, "TYPE_MISMATCH"],
    ["x * 1", { x: [2] }, "TYPE_MISMATCH"],
    ["x + 'a'", { x: 1 }, "TYPE_MISMATCH"],
    ["-x", { x: "abc" }, "TYPE_MISMATCH"],
    ["-x", { x: null }, "TYPE_MISMATCH"],
    ["x + 1", { x: Number.MAX_SAFE_INTEGER }, "NUMBER_RANGE"],
    ["x * x", { x: 1e10 }, "NUMBER_RANGE"],
    ["x * 10", { x: 1e307 }, "NUMBER_RANGE"],
    ["x + 0", { x: "99999999999999999999" }, "NUMBER_RANGE"],
    ["x == 1", { x: "1e400" }, "NUMBER_RANGE"],
  ])("%s with %p fails with %s", (source, values, code) => {
    expect(runError(source, values).code).toBe(code);
  });

  test("string concatenation is bounded", () => {
    const big = "x".repeat(40_000);
    expect(runError("a + a", { a: big }).code).toBe("VALUE_TOO_LARGE");
  });
});

describe("functions", () => {
  test.each<[string, Record<string, unknown>, Value]>([
    ["floor(7 / 2)", {}, 3],
    ["floor(-7 / 2)", {}, -4],
    ["ceil(7 / 2)", {}, 4],
    ["ceil(-0.5)", {}, 0],
    ["abs(-3)", {}, 3],
    ["abs(x)", { x: true }, 1],
    ["min(3, 1, 2)", {}, 1],
    ["max(3, 1, 2)", {}, 3],
    ["min(5)", {}, 5],
    ["max(x, 1)", { x: false }, 1],
    ["floor((x - 10) / 2)", { x: 8 }, -1],
    ["if(x, 'yes', 'no')", { x: [] }, "no"],
    ["if(x, 'yes', 'no')", { x: [0] }, "yes"],
    ["if(1, x, 0)", { x: "s" }, "s"],
  ])("%s", (source, values, expected) => {
    const result = run(source, values);
    expect(result).toEqual(expected);
    if (expected === 0) expect(Object.is(result, -0)).toBe(false);
  });

  test("arguments are numbers or booleans, never strings or null", () => {
    expect(runError("floor(x)", { x: "5" }).code).toBe("TYPE_MISMATCH");
    expect(runError("min(1, x)", { x: null }).code).toBe("TYPE_MISMATCH");
    expect(compileError("abs('x')").code).toBe("TYPE_MISMATCH");
  });

  test.each<[string, ExprErrorCode]>([
    ["min()", "ARITY"],
    ["max()", "ARITY"],
    ["floor(1, 2)", "ARITY"],
    ["floor()", "ARITY"],
    ["if(1, 2)", "ARITY"],
    ["if(1, 2, 3, 4)", "ARITY"],
    ["round(1)", "UNKNOWN_FUNCTION"],
    ["constructor(1)", "UNKNOWN_FUNCTION"],
    ["toString()", "UNKNOWN_FUNCTION"],
    ["getvar(x)", "GETVAR_NAME"],
    ["getvar()", "GETVAR_NAME"],
  ])("%s fails with %s", (source, code) => {
    expect(compileError(source).code).toBe(code);
  });

  test("only the functions a caller enables are callable", () => {
    expect(compileError("floor(x)", {}).code).toBe("UNKNOWN_FUNCTION");
    expect(compileError("if(x, 1, 2)", { functions: ["floor"] }).code).toBe("UNKNOWN_FUNCTION");
    expect(compile("floor(x)", { functions: ["floor"] }).evaluate(recordResolver({ x: 2.5 }))).toBe(2);
    // getvar is not a function in that sense: always available outside the portable subset.
    expect(compile("getvar('x')", {}).evaluate(recordResolver({ x: 1 }))).toBe(1);
  });
});

describe("absent names and resolver values", () => {
  test("absent reads as null by default", () => {
    expect(run("missing")).toBe(null);
    expect(run("missing === null")).toBe(true);
    expect(run("!missing")).toBe(true);
    expect(run("missing == 0")).toBe(false);
  });

  test('absent is ABSENT_NAME under absent: "error", at the reference\'s position', () => {
    const error = runError("roll <= target", { roll: 5 }, "error");
    expect(error.code).toBe("ABSENT_NAME");
    expect(error.position).toBe(8);
    // undefined is a value (null), not absence.
    expect(run("x === null", { x: undefined }, "error")).toBe(true);
  });

  test.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "prototype"])(
    "%s is an ordinary absent name",
    (name) => {
      expect(compile(name).evaluate(recordResolver({}))).toBe(null);
      expect(compile(name).evaluate(mapResolver(new Map()))).toBe(null);
      expect(failure(() => compile(name).evaluate(recordResolver({}), { absent: "error" })).code).toBe("ABSENT_NAME");
      expect(compile(`${name} == 1`).evaluate(recordResolver({ [name]: 1 }))).toBe(true);
      expect(compile(`a.${name}`).references).toEqual([`a.${name}`]);
    },
  );

  test("the resolver's ABSENT is the exported symbol", () => {
    expect(compile("x").evaluate(() => ABSENT)).toBe(null);
  });

  test.each<[unknown, string]>([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [10n, "bigint"],
    [Symbol("s"), "symbol"],
    [() => 1, "function"],
    [new Date(0), "Date"],
    [new Map(), "Map"],
  ])("a resolver value %p (%s) is BAD_VALUE", (value) => {
    expect(failure(() => compile("x").evaluate(() => value)).code).toBe("BAD_VALUE");
  });

  test("-0 from a resolver reads as 0", () => {
    expect(Object.is(compile("x").evaluate(() => -0), 0)).toBe(true);
  });

  test("a resolver's own exception passes through unchanged", () => {
    const boom = new RangeError("boom");
    expect(() =>
      compile("x").evaluate(() => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  test("structural comparison of a hostile nested value is bounded", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i += 1) deep = [deep];
    expect(runError("a == b", { a: deep, b: deep }).code).toBe("VALUE_TOO_LARGE");
  });
});

describe("truthiness", () => {
  test.each<[Value, boolean]>([
    [0, false],
    ["", false],
    [null, false],
    [false, false],
    [[], false],
    [{}, false],
    [[0], true],
    [{ a: 0 }, true],
    ["no", true],
    ["0", true],
    [-1, true],
    [0.5, true],
  ])("%p is %p", (value, expected) => {
    expect(truthy(value)).toBe(expected);
    expect(compile("x").test(() => value)).toBe(expected);
  });
});

describe("syntax errors carry a code and a position", () => {
  test.each<[string, ExprErrorCode, number]>([
    ["", "EMPTY", 0],
    ["   ", "EMPTY", 0],
    ["'unterminated", "UNTERMINATED_STRING", 0],
    ["1 2", "UNEXPECTED_TOKEN", 2],
    ["&& 1", "UNEXPECTED_TOKEN", 0],
    ["a ~ b", "UNEXPECTED_CHARACTER", 2],
    ["a = b", "UNEXPECTED_CHARACTER", 2],
    ["a ? b : c", "UNEXPECTED_CHARACTER", 2],
    ["１", "UNEXPECTED_CHARACTER", 0], // ASCII digits only
    ["getvar('x'", "UNEXPECTED_END", 10],
    ["(1 + 2", "UNEXPECTED_END", 6],
    ["1 +", "UNEXPECTED_END", 3],
    ["+1", "UNEXPECTED_TOKEN", 0], // no unary plus
    ["1 + !a", "UNEXPECTED_TOKEN", 4], // `!` does not appear inside arithmetic
    ["a == !b", "UNEXPECTED_TOKEN", 5],
    ["a.", "UNEXPECTED_END", 2],
    ["a.true", "BAD_SEGMENT", 2],
    ["a.'x'", "BAD_SEGMENT", 2],
    ["a[b]", "BAD_SEGMENT", 2],
    ["a[1.5]", "BAD_SEGMENT", 2],
    ["a[0", "UNEXPECTED_END", 3],
    [".5", "UNEXPECTED_TOKEN", 0],
    ["(1).x", "UNEXPECTED_TOKEN", 3],
    ["a, b", "UNEXPECTED_TOKEN", 1],
    ["()", "UNEXPECTED_TOKEN", 1],
    ["1 / 0", "DIVISION_BY_ZERO", 2],
    ["true || 1 % 0", "DIVISION_BY_ZERO", 10], // a constant error is refused even in a dead branch
    ["-'x'", "TYPE_MISMATCH", 0],
    ["99999999999999999999", "NUMBER_RANGE", 0],
    ["9007199254740991 + 1", "NUMBER_RANGE", 17],
  ])("%p → %s at %d", (source, code, position) => {
    const error = compileError(source);
    expect(error.code).toBe(code);
    expect(error.position).toBe(position);
    expect(error.message).toContain(`(at ${position})`);
  });

  test("a sound expression whose divisor a placeholder would zero still compiles", () => {
    // The reference dry-ran every expression with each name = 1 and refused this.
    expect(compile("10 / (target - 1)").evaluate(recordResolver({ target: 3 }))).toBe(5);
  });
});

describe("bounds", () => {
  test("source length", () => {
    expect(() => compile("1".padEnd(MAX_SOURCE_LENGTH, " "))).not.toThrow();
    expect(compileError("1".padEnd(MAX_SOURCE_LENGTH + 1, " ")).code).toBe("TOO_LONG");
    // UTF-16 units, the unit a client measures: 250 astral characters are 500 units.
    expect(() => compile("𠀀".repeat(MAX_SOURCE_LENGTH / 2))).not.toThrow();
    expect(compileError(`a${"𠀀".repeat(MAX_SOURCE_LENGTH / 2)}`).code).toBe("TOO_LONG");
  });

  test("token count", () => {
    // `a||a||…` with an odd token count, well inside the length cap.
    const tokens = (count: number): string => Array.from({ length: (count + 1) / 2 }, () => "a").join("||");
    expect(() => compile(tokens(MAX_TOKENS - 1))).not.toThrow();
    expect(compileError(tokens(MAX_TOKENS + 1)).code).toBe("TOO_MANY_TOKENS");
  });

  test("nesting depth: parentheses, unary operators, calls", () => {
    const parens = (n: number): string => `${"(".repeat(n)}1${")".repeat(n)}`;
    expect(compile(parens(MAX_DEPTH)).evaluate(() => ABSENT)).toBe(1);
    expect(compileError(parens(MAX_DEPTH + 1)).code).toBe("TOO_DEEP");
    expect(compileError(`${"!".repeat(MAX_DEPTH + 1)}1`).code).toBe("TOO_DEEP");
    expect(compileError(`${"- ".repeat(MAX_DEPTH + 1)}1`).code).toBe("TOO_DEEP");
    expect(compileError(`${"floor(".repeat(MAX_DEPTH + 1)}1${")".repeat(MAX_DEPTH + 1)}`).code).toBe("TOO_DEEP");
    // An operator chain is not nesting: its length is bounded by the token cap alone.
    const chain = Array.from({ length: 100 }, () => "a").join("+");
    expect(compile(chain).evaluate(() => 1)).toBe(100);
  });

  test("the error position of a bound points into the source", () => {
    const error = compileError(`${"(".repeat(MAX_DEPTH + 1)}1${")".repeat(MAX_DEPTH + 1)}`);
    expect(error.position).toBe(MAX_DEPTH);
  });
});

describe("the compiled object", () => {
  test("is frozen and reusable", () => {
    const compiled = compile("x + 1");
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.references)).toBe(true);
    expect(compiled.source).toBe("x + 1");
    expect(compiled.evaluate(recordResolver({ x: 1 }))).toBe(2);
    expect(compiled.evaluate(recordResolver({ x: 5 }))).toBe(6);
  });

  test("reports whether it lies in the portable subset", () => {
    expect(compile("a >= 1 && !b || c.d === 'x'").portable).toBe(true);
    expect(compile("a + 1 > 2").portable).toBe(false);
    expect(compile("a[0]").portable).toBe(false);
    expect(compile("getvar('a')").portable).toBe(false);
    expect(compile("floor(a)", ALL).portable).toBe(false);
    expect(compile("-1").portable).toBe(false);
  });

  test("portable mode refuses each construct outside the subset at its position", () => {
    const portable = { portable: true, functions: FUNCTION_NAMES };
    for (const [source, position] of [
      ["a + 1", 2],
      ["a >= -1", 5],
      ["a[0] == 1", 1],
      ["getvar('a')", 0],
      ["x && floor(a)", 5],
      ["unknown(a)", 0],
    ] as const) {
      const error = compileError(source, portable);
      expect(error.code).toBe("OUTSIDE_SUBSET");
      expect(error.position).toBe(position);
    }
    expect(compile("a.0.b === 'x' and not c", portable).portable).toBe(true);
  });
});
