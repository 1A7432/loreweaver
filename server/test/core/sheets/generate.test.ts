// Character generation: the `generate_character` rows of `sheets_ops`, replayed draw for
// draw, plus the properties the rows cannot show.
//
// Each row is resolved to its pack the way a caller does (a `RulePackRegistry`); an
// unknown system (`nonsense`, the reference's `ValueError`) resolves to nothing, so there
// is nothing to generate. The whole generated sheet is compared in the 2.x dict shape,
// derived attribute slots filled in from the derivation as the reference stored them.
import { describe, expect, test } from "bun:test";

import { parseDice } from "../../../src/core/dice/index.ts";
import { ScriptedRandom, SeededRandom } from "../../../src/core/random.ts";
import { compileRulePack } from "../../../src/core/rulepacks/index.ts";
import { compileSheetSpec, creationRolls, generateCharacter } from "../../../src/core/sheets/index.ts";
import { readReference } from "../../reference.ts";
import { vectorRegistry } from "../rulepacks/adapter.ts";
import { type Json, legacyView } from "./adapter.ts";

type Draw = [number, number, number, number];
interface Row {
  kind: string;
  system: string;
  name: string;
  draws: Draw[];
  sheet: Record<string, Json> | null;
  error: { class: string; message: string } | null;
}

const scripted = (draws: Draw[]) => new ScriptedRandom(draws.map(([lo, hi, value, step]) => ({ lo, hi, value, step })));

describe("sheets_ops generate_character", () => {
  test("every row", () => {
    const registry = vectorRegistry();
    const rows = readReference<Row>("sheets_ops").filter((row) => row.kind === "generate_character");
    let generated = 0;
    let unknown = 0;
    for (const row of rows) {
      const pack = registry.resolve(row.system);
      if (pack === null) {
        expect(row.error?.class).toBe("ValueError");
        expect(row.draws).toEqual([]);
        unknown++;
        continue;
      }
      const random = scripted(row.draws);
      const result = generateCharacter(pack.sheet, random, { name: row.name, system: pack.id });
      expect(random.remaining).toBe(0);
      expect(result.violations).toEqual([]);
      expect(result.issues).toEqual([]);
      expect(legacyView(pack.sheet, result.sheet, true)).toEqual(row.sheet as Record<string, Json>);
      // Each roll is what landed in its attribute slot.
      for (const roll of result.rolls) expect((row.sheet!.attributes as Record<string, Json>)[roll.key]).toBe(roll.roll.total);
      generated++;
    }
    expect([generated, unknown]).toEqual([35, 6]);
  });
});

describe("generateCharacter", () => {
  const pack = compileRulePack(
    "gen",
    [
      "defaults: {might: 10}",
      "sheet:",
      "  label: Gen",
      "  attr_keys: {might: MIG, grit: GRT, gritmax: GRTMAX}",
      "  attributes: {MIG: 10, GRT: 0}",
      "  derived_attrs: {GRTMAX: gritmax}",
      "  vitals: {GRT: {max_key: GRTMAX}}",
      "derived:",
      "  gritmax: {expr: 'might * 2'}",
      "creation_constraints:",
      "  attributes:",
      "    MIG: {min: 3, max: 12, roll: '2d10'}",
      "    LCK: {min: 1, max: 6, roll: '1d6'}",
    ].join("\n"),
  );

  test("rolls in declaration order, sets vitals from the rolled values, and clamps into the declared range", () => {
    const result = generateCharacter(pack.sheet, scripted([[1, 10, 9, 1], [1, 10, 8, 1], [1, 6, 4, 1]]), { name: "A", system: "gen" });
    expect(result.rolls.map((roll) => [roll.key, roll.roll.total])).toEqual([["MIG", 17], ["LCK", 4]]);
    // 17 is above MIG's max of 12: validation clamps it and says so; the vital starts full from the clamped value.
    expect(result.violations.map((v) => [v.code, v.key, v.original, v.corrected])).toEqual([["attribute_above_max", "MIG", 17, 12]]);
    expect(result.sheet.attributes).toEqual([["MIG", 12], ["GRT", 24], ["LCK", 4]]);
  });

  test("a seeded source gives the same character twice; nothing is shared between calls", () => {
    const a = generateCharacter(pack.sheet, new SeededRandom("x"), { name: "A", system: "gen" });
    const b = generateCharacter(pack.sheet, new SeededRandom("x"), { name: "A", system: "gen" });
    expect(a.sheet).toEqual(b.sheet);
    expect(Object.isFrozen(a.sheet)).toBe(true);
  });

  test("a pack without creation rolls gives a fresh sheet and consumes nothing", () => {
    const bare = compileSheetSpec("bare", {});
    const random = scripted([]);
    const result = generateCharacter(bare, random, { name: "B", system: "bare" });
    expect([result.rolls.length, random.consumed]).toEqual([0, 0]);
    expect(creationRolls(pack.sheet).map((entry) => [entry.key, entry.expression.notation])).toEqual([
      ["MIG", parseDice("2d10").notation],
      ["LCK", parseDice("1d6").notation],
    ]);
  });
});
