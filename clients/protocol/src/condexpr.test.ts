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
})
