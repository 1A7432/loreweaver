import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { CondExprError, evaluateBool, isVisible } from "./condexpr"

// The TypeScript half of the `visible_when` conformance suite (M19 item 7).
//
// `tests/fixtures/visible_when_vectors.json` is the SHARED table: the same rows run
// here and in `tests/core/test_visible_when_vectors.py`. `visible_when` is evaluated
// client-side, so "every implementation agrees with the reference" is a promise only a
// shared fixture can keep — a row that moves breaks both suites at once. This is
// deliberately the first brick of the LWF conformance suite.

const VECTORS_PATH = fileURLToPath(new URL("../../../tests/fixtures/visible_when_vectors.json", import.meta.url))
const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as {
  cases: Array<{ expr: string; vars: Record<string, unknown>; expect: boolean | "error"; why?: string }>
  rejected: Array<{ expr: string; why: string }>
}

/** The same resolution rule the renderer uses: a variable id looked up in the viewer's
 * own `state.variables`; anything absent is null. */
function resolver(variables: Record<string, unknown>) {
  return (path: string) => (path in variables ? variables[path] : null)
}

describe("visible_when conformance vectors", () => {
  test("the shared table is actually loaded and covers both halves", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(40)
    expect(vectors.rejected.length).toBeGreaterThanOrEqual(8)
    expect(vectors.cases.some((row) => row.expect === "error")).toBe(true)
  })

  for (const row of vectors.cases) {
    test(`${row.expr} | ${JSON.stringify(row.vars)} -> ${row.expect}`, () => {
      if (row.expect === "error") {
        expect(() => evaluateBool(row.expr, resolver(row.vars))).toThrow(CondExprError)
        // ...and the renderer turns that into "hidden", never "shown".
        expect(isVisible(row.expr, resolver(row.vars))).toBe(false)
        return
      }
      expect(evaluateBool(row.expr, resolver(row.vars))).toBe(row.expect)
      expect(isVisible(row.expr, resolver(row.vars))).toBe(row.expect)
    })
  }

  for (const row of vectors.rejected) {
    test(`out of subset: ${row.expr}`, () => {
      // The SERVER refuses these at pack build. This client evaluator must not
      // implement them either — an expression that works here but not in a sibling
      // client is the exact divergence the subset exists to prevent.
      expect(() => evaluateBool(row.expr, resolver({ day: 1, clues: [], stage: 1 }))).toThrow(CondExprError)
    })
  }
})

describe("isVisible", () => {
  test("no condition means visible", () => {
    expect(isVisible(undefined, resolver({}))).toBe(true)
  })

  test("fails closed on anything it cannot decide", () => {
    expect(isVisible("day >=", resolver({ day: 1 }))).toBe(false)
    expect(isVisible("", resolver({}))).toBe(false)
    expect(isVisible("day > 'abc'", resolver({ day: 1 }))).toBe(false)
  })

  test("fails closed on an absent variable and on grammar this build does not implement", () => {
    // The protocol rule a client MUST obey: a gate it cannot evaluate hides its block.
    // An absent reference is `null`, which is unorderable — hidden, never shown.
    expect(isVisible("day >= 46", resolver({}))).toBe(false)
    expect(isVisible("mvu.真相已揭 === true", resolver({}))).toBe(false)
    // Out-of-subset grammar (a future minor's syntax, or a hand-edited manifest) is a
    // condition this build cannot decide, so it hides too.
    for (const condition of ["day + 1 > 46", "getvar('day') > 5", "clues[0] === 'ash'", "day ?? 1"]) {
      expect(isVisible(condition, resolver({ day: 99 }))).toBe(false)
    }
    // Positive control: the same variable set, a condition this build DOES implement.
    expect(isVisible("day >= 46", resolver({ day: 46 }))).toBe(true)
  })

  test("fails closed on a malformed condition value and on a resolver that throws", () => {
    // A `visible_when` that is not a string at all (hand-edited manifest, a future
    // structured form) is undecidable — it must not fall through to "visible".
    for (const bad of [null, 0, 1, true, {}, [], "   "]) {
      expect(isVisible(bad as unknown as string, resolver({}))).toBe(false)
    }
    expect(
      isVisible("day >= 46", () => {
        throw new Error("variable lookup failed")
      }),
    ).toBe(false)
    // Positive control: only an ABSENT condition means "no gate, draw it".
    expect(isVisible(undefined, resolver({}))).toBe(true)
  })
})
