import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ModuleVariable, PanelTemplateBlock, UiBlock } from "loreweaver-protocol"
import { resolvePanelBlocks } from "./panelTemplates"

// The TypeScript half of the panel template-instantiation conformance suite.
//
// `tests/fixtures/panel_template_vectors.json` is the SHARED table: the same rows run
// here and in `tests/core/test_panel_template_vectors.py`. A panel is instantiated in
// every client AND on the server (the `.panel` text fallback), so "every implementation
// agrees with the reference one" is a promise only a shared fixture can keep — a row
// that moves breaks both suites at once. THIS file is the reference side: the engine
// mirrors `resolvePanelBlocks`, not the other way round.

const VECTORS_PATH = fileURLToPath(new URL("../../../tests/fixtures/panel_template_vectors.json", import.meta.url))
const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as {
  cases: Array<{
    id: string
    why: string
    blocks: PanelTemplateBlock[]
    variables: ModuleVariable[]
    locale: string
    expect: UiBlock[]
  }>
}

describe("panel template conformance vectors", () => {
  test("the shared table is actually loaded", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(30)
    // Rows that resolve to nothing are half the contract; rows that resolve to something
    // are the other half. A table of only one kind would pass a resolver that always
    // returned [].
    expect(vectors.cases.some((row) => row.expect.length === 0)).toBe(true)
    expect(vectors.cases.some((row) => row.expect.length > 1)).toBe(true)
  })

  for (const row of vectors.cases) {
    test(`${row.id} — ${row.why}`, () => {
      expect(resolvePanelBlocks(row.blocks, row.variables, row.locale)).toEqual(row.expect)
    })
  }
})
