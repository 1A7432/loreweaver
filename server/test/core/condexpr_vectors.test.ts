// The server's evaluator against the shared `visible_when` conformance table
// (`clients/protocol/src/condexpr.vectors.json`), which the client-side evaluator
// (`clients/protocol/src/condexpr.ts`) runs too. `visible_when` is evaluated by clients,
// so the server — which decides at pack build time what a gate may contain — must agree
// with them on every row, in full mode and in portable mode alike.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";


import { compile, ExprError, FUNCTION_NAMES, recordResolver, type Value } from "../../src/core/condexpr.ts";

// The client's evaluator, loaded at run time by URL, as a second implementation under test
// (it is type-checked through the protocol package's v3 entry, which imports it for panels).
const CLIENT_EVALUATOR = new URL("../../../clients/protocol/src/condexpr.ts", import.meta.url).href;
const { evaluate: clientEvaluate } = (await import(CLIENT_EVALUATOR)) as {
  evaluate: (expression: string, resolve: (path: string) => unknown) => unknown;
};

interface Case {
  readonly expr: string;
  readonly vars: Record<string, unknown>;
  readonly expect: boolean | "error";
}
interface Rejected {
  readonly expr: string;
}

const VECTORS = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../clients/protocol/src/condexpr.vectors.json"), "utf8"),
) as { cases: Case[]; rejected: Rejected[] };

const MODES = [
  ["full", { functions: FUNCTION_NAMES }],
  ["portable", { portable: true }],
] as const;

describe.each(MODES)("visible_when table, %s mode", (_mode, options) => {
  test.each(VECTORS.cases.map((row) => [row.expr, JSON.stringify(row.vars), row] as const))(
    "%s with %s",
    (_expr, _vars, row) => {
      // Every accepted row is a gate a pack may ship: it compiles in either mode.
      const compiled = compile(row.expr, options);
      expect(compiled.portable).toBe(true);
      const resolve = recordResolver(row.vars);
      if (row.expect === "error") {
        expect(() => compiled.test(resolve)).toThrow(ExprError);
      } else {
        expect(compiled.test(resolve)).toBe(row.expect);
      }
    },
  );

  test.each(VECTORS.rejected.map((row) => [row.expr] as const))("rejected: %s", (expr) => {
    if (options === MODES[1][1]) {
      let code: string | undefined;
      try {
        compile(expr, options);
      } catch (error) {
        code = error instanceof ExprError ? error.code : undefined;
      }
      expect(code).toBe("OUTSIDE_SUBSET");
    } else {
      // The full language reads it; it is just not portable.
      expect(compile(expr, options).portable).toBe(false);
    }
  });
});

test("the table still covers both halves of the contract", () => {
  expect(VECTORS.cases.length).toBeGreaterThanOrEqual(40);
  expect(VECTORS.rejected.length).toBeGreaterThanOrEqual(8);
  expect(VECTORS.cases.some((row) => row.expect === "error")).toBe(true);
});

// Beyond the table: random portable expressions over random variables, evaluated by both
// implementations. The generator stays inside the inputs on which the two are meant to
// agree. Outside them the client still reads hex numerals and empty objects the
// JavaScript way, and it evaluates a short-circuited branch against the placeholder `1`
// — so a dead `note > 'a'` raises there. The last test pins that one difference.
describe("differential against the client evaluator", () => {
  // A fixed-seed xorshift: deterministic, so a failure reproduces.
  let seed = 0x2545f491;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

  const NAMES = ["a", "b", "c", "mvu.潮位", "祭典日", "x.0"];
  const VALUES: readonly unknown[] = [0, 1, 2, 46, -3, 2.5, "2", " 7 ", "2.0", "", "abc", "b", "1e1", true, false, null];
  const LITERALS = ["0", "1", "2", "46", "2.5", "'2'", "'abc'", '"b"', "''", "true", "false", "null", "undefined"];
  // Literals a reference may be ORDERED against without the client's placeholder `1`
  // raising in a dead branch.
  const ORDERABLE_WITH_ONE = ["0", "1", "2", "46", "2.5", "'2'", "' 7 '", "true", "false"];
  const EQUALITY = ["===", "!==", "==", "!="];
  const ORDERING = [">=", "<=", ">", "<"];

  const operand = (): string => (next() < 0.5 ? pick(NAMES) : pick(LITERALS));
  const comparison = (): string => {
    if (next() < 0.5) return `${operand()} ${pick(EQUALITY)} ${operand()}`;
    const kind = next();
    const pair =
      kind < 0.3
        ? [pick(NAMES), pick(NAMES)]
        : kind < 0.85
          ? [pick(NAMES), pick(ORDERABLE_WITH_ONE)]
          : [pick(LITERALS), pick(LITERALS)];
    const [first, second] = next() < 0.5 ? pair : [pair[1], pair[0]];
    return `${first} ${pick(ORDERING)} ${second}`;
  };
  const expression = (depth: number): string => {
    const roll = next();
    if (depth <= 0 || roll < 0.25) return next() < 0.6 ? comparison() : operand();
    if (roll < 0.45) return `!${expression(depth - 1)}`;
    if (roll < 0.55) return `not (${expression(depth - 1)})`;
    if (roll < 0.65) return `(${expression(depth - 1)})`;
    return `${expression(depth - 1)} ${pick(["&&", "||", "and", "or"])} ${expression(depth - 1)}`;
  };

  type Outcome = { ok: true; value: unknown } | { ok: false };
  const outcome = (run: () => unknown): Outcome => {
    try {
      return { ok: true, value: run() };
    } catch {
      return { ok: false };
    }
  };

  test("3000 random gates agree, value for value and error for error", () => {
    let errors = 0;
    for (let index = 0; index < 3000; index += 1) {
      const source = expression(4);
      const vars: Record<string, unknown> = {};
      for (const name of NAMES) if (next() < 0.8) vars[name] = pick(VALUES);
      const resolve = recordResolver(vars);
      const ours = outcome(() => compile(source, { portable: true }).evaluate(resolve) as Value);
      const theirs = outcome(() => clientEvaluate(source, (path) => (Object.hasOwn(vars, path) ? vars[path] : null)));
      if (!ours.ok) errors += 1;
      expect({ source, vars, outcome: ours }).toEqual({ source, vars, outcome: theirs });
    }
    // The generator must exercise the error half too, not only happy paths.
    expect(errors).toBeGreaterThan(100);
  });

  test("the one deliberate difference: a short-circuited branch is never evaluated", () => {
    const vars = { stage: 1, note: "b" };
    const source = "!(stage === 2 && note > 'a')";
    expect(compile(source, { portable: true }).test(recordResolver(vars))).toBe(true);
    expect(() => clientEvaluate(source, (path) => (vars as Record<string, unknown>)[path] ?? null)).toThrow();
  });
});
