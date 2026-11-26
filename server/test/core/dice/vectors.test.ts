// Replays the dice reference vectors (see test/fixtures/reference/README.md) against the
// new engine through `adapter.ts`, and prints how many rows were compared or skipped.
import { describe, expect, test } from "bun:test";

import { naturalCritical, parseDice } from "../../../src/core/dice/index.ts";
import { readReference } from "../../reference.ts";
import { replay, type VectorRow } from "./adapter.ts";

describe("dice_vectors", () => {
  const rows = readReference<VectorRow>("dice_vectors");
  const skipped = new Map<string, string[]>();
  let compared = 0;

  test("the file is the one documented", () => {
    expect(rows.length).toBe(2150);
  });

  for (const row of rows) {
    test(row.id, () => {
      const outcome = replay(row);
      if (outcome.kind === "skip") {
        const ids = skipped.get(outcome.reason) ?? [];
        ids.push(row.id);
        skipped.set(outcome.reason, ids);
        return;
      }
      compared++;
      if (outcome.kind === "error") {
        expect(outcome.actual).toBe(outcome.expected);
        return;
      }
      expect(outcome.actual).toEqual(outcome.expected);
      expect(outcome.leftover).toBe(0);
    });
  }

  test("summary", () => {
    const lines = [...skipped].map(([reason, ids]) => `  ${ids.length} skipped: ${reason}\n    ${ids.join(" ")}`);
    console.log(`dice_vectors: ${rows.length} rows, ${compared} compared\n${lines.join("\n")}`);
    expect(compared + [...skipped.values()].reduce((n, ids) => n + ids.length, 0)).toBe(rows.length);
  });
});

describe("dice_normalize", () => {
  // The old engine rewrote SealDice notation as text before parsing (`x` -> `*`, bare
  // `kN` -> `khN`). The new grammar reads both forms itself, so the behaviour to compare
  // is that the input and the rewritten output MEAN the same: equal parse trees, or both
  // refused.
  const rows = readReference<{ input: string; output: string }>("dice_normalize");
  const parsed = (text: string): unknown => {
    try {
      return parseDice(text).root;
    } catch {
      return "refused";
    }
  };
  for (const row of rows) {
    test(JSON.stringify(row.input), () => {
      expect(parsed(row.input)).toEqual(parsed(row.output));
    });
  }
});

describe("dice_result_flags", () => {
  // Critical flags of a hand-built result. Compared: `critical_success`/`critical_failure`.
  // Not compared: `total` (just `sum(rolls) + modifier` of the hand-built input; the new
  // engine never builds a result from parts) and `text` (rendering, see adapter.ts). Rows
  // whose `dice_count` disagrees with the number of `rolls` describe no possible roll and
  // are skipped; rows for a die of fewer than two faces are adapted (see below).
  interface FlagRow {
    enable_critical_effects: boolean;
    input: { dice_count: number; dice_sides: number; rolls: number[]; is_check: boolean };
    result: { critical_success: boolean; critical_failure: boolean };
  }
  const rows = readReference<FlagRow>("dice_result_flags");
  test("every consistent row", () => {
    let compared = 0;
    let skipped = 0;
    let lowSides = 0;
    for (const row of rows) {
      const { dice_count, dice_sides, rolls, is_check } = row.input;
      const kept = dice_count === 0 ? [] : rolls;
      if (dice_count !== 0 && dice_count !== rolls.length) {
        skipped++;
        continue;
      }
      // Whether criticals apply (the old global switch, and checks only) is the caller's call.
      const critical = row.enable_critical_effects && is_check ? naturalCritical(dice_sides, kept) : null;
      let expected = { success: row.result.critical_success, failure: row.result.critical_failure };
      // Decision: a die of fewer than two faces has no natural critical (the old engine
      // compared faces against a size of 0 and flagged a rolled 0 as a critical success).
      if (dice_sides < 2 && (expected.success || expected.failure)) {
        lowSides++;
        expected = { success: false, failure: false };
      }
      expect({ success: critical === "success", failure: critical === "failure" }).toEqual(expected);
      compared++;
    }
    console.log(`dice_result_flags: ${rows.length} rows, ${compared} compared, ${skipped} skipped (dice_count != rolls); ${lowSides} of the compared rows adapted (fewer than two faces: no critical)`);
    expect(compared + skipped).toBe(rows.length);
  });
});
