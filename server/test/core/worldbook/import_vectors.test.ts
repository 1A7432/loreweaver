// `st_worldbook_import` vectors: every step's stored book, skipped and unreachable titles.
//
// Not compared: `mvu_tree_after` — parsing a `[InitVar]` body into the variable tree is
// the MVU module's job; the import only hands the declaration over. What IS compared for
// those rows: a keeper import that changed the tree returned at least one declaration, a
// player import returned none, and no declaration was stored as lore.

import { describe, expect, test } from "bun:test";

import { importLorebook, type ImportedEntry, keptOnReimport } from "../../../src/core/worldbook/index.ts";
import { readReference } from "../../reference.ts";
import { type RecordedEntry, toRecorded } from "./adapter.ts";

interface Step {
  readonly book: unknown;
  readonly char_name: string;
  readonly is_keeper: boolean;
  readonly source: string;
}
interface StepResult {
  readonly count?: number;
  readonly error?: { readonly type: string };
  readonly entries_after: RecordedEntry[];
  readonly mvu_tree_after: Record<string, unknown>;
  readonly skipped_titles: string[];
  readonly unreachable_titles: string[];
}
interface Row {
  readonly case: string;
  readonly input: { readonly steps: Step[] };
  readonly steps: StepResult[];
}

/**
 * Rows encoding an old-engine divergence from SillyTavern that this port corrects, each
 * with a direct test in `corrections.test.ts`. Per row: the fields not compared, or `"*"`.
 */
const CORRECTED: Readonly<Record<string, { readonly fields: readonly string[] | "*"; readonly why: string }>> = {
  st_native_disable_flag: { fields: ["enabled"], why: "ST-native `disable: true` is read (world-info.js checkWorldInfo)" },
  priority_vs_insertion_order: { fields: ["priority"], why: "ST-native `order` is read as the priority" },
  v2_extensions_fields_ignored: { fields: "*", why: "V2 trigger fields under `extensions` are read (convertCharacterBook)" },
  numeric_clamps: { fields: ["group_weight"], why: "`groupWeight: 0` stays 0 (ST `?? DEFAULT_WEIGHT`); a negative weight clamps to 0, not 1" },
  activate_decorator_ignored: { fields: ["constant"], why: "`@@activate` activates like `constant` on a keeper import (checkWorldInfo)" },
};

function compareStep(rowCase: string, result: StepResult, actual: ImportedEntry[], declarations: number, skipped: string[], unreachable: string[]): void {
  const corrected = CORRECTED[rowCase];
  if (corrected?.fields === "*") return;
  const strip = (entry: RecordedEntry): Partial<RecordedEntry> => {
    const copy: Record<string, unknown> = { ...entry };
    for (const field of corrected?.fields ?? []) delete copy[field];
    return copy as Partial<RecordedEntry>;
  };
  expect(actual.map((entry) => strip(toRecorded(entry)))).toEqual(result.entries_after.map(strip));
  expect(skipped).toEqual(result.skipped_titles);
  expect(unreachable).toEqual(result.unreachable_titles);
  if (Object.keys(result.mvu_tree_after).length > 0) expect(declarations).toBeGreaterThan(0);
}

describe("st_worldbook_import", () => {
  const rows = readReference<Row>("st_worldbook_import");

  test("every row is accounted for", () => {
    expect(rows.length).toBe(40);
    for (const name of Object.keys(CORRECTED)) expect(rows.some((row) => row.case === name)).toBe(true);
  });

  for (const row of rows) {
    test(row.case, () => {
      let room: ImportedEntry[] = [];
      let mvuTouched = false;
      row.input.steps.forEach((step, index) => {
        const expected = row.steps[index];
        if (expected === undefined) throw new Error("missing step result");
        const trust = step.is_keeper ? "keeper" : "player";
        const result = importLorebook(step.book, { trust, source: step.source, charName: step.char_name });
        if (expected.error !== undefined) {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe("TOO_MANY_ENTRIES");
          return;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        if (result.declarations.length > 0) mvuTouched = true;
        if (trust === "player") expect(result.declarations).toEqual([]);
        room = [...keptOnReimport(room, { trust, source: step.source }), ...result.entries];
        expect(result.entries.length).toBe(expected.count ?? -1);
        compareStep(row.case, expected, room, mvuTouched ? 1 : 0, [...result.skippedTitles], [...result.unreachableTitles]);
      });
    });
  }
});
