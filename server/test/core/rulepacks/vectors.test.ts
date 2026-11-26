// The reference vectors of the rule-pack loader, through `./adapter.ts`.
//
// Compared: `rules_pack_meta` and the literal packs' `pack_meta` rows — `names`,
// `set_keys`, `rank_labels`, `display_names`, `initiative_roll`, `commands`, `subsystems`
// (template, labels and every parameter the template reads); the `load_rulepack`,
// `built_in_ids` and `available_systems_contains` rows of `sheets_aliases`.
//
// Not compared here, and why:
// - The resolution fields of `pack_meta` (`roll`, `ladders`, `difficulties`, `params`,
//   `check`, ...) are compared cell by cell by `test/core/resolution/vectors.test.ts` on
//   the same sections; here it is only checked that the compiled pack holds a resolution.
// - The subsystem fields a template does not read (`roll: 1d100` on a `table_draw`, ...):
//   the reference filled every field of one record with defaults; the compiled spec of
//   each template has only its own fields.
//
// Answered differently on purpose:
// - `available_systems_contains` lists `oraclescript`, a pack whose resolution is a rules
//   script: the script lane is not built, so that pack is refused (`SCRIPT_UNSUPPORTED`)
//   instead of loading. The test checks the refusal and the rest of the list.
// - `load_rulepack` error rows (`unknown rulepack: …`) are a null from
//   `RulePackRegistry.resolve`: an unknown name is an answer, not an exception.
import { describe, expect, test } from "bun:test";

import { builtInPackIds, compileRulePack, rankDisplay, RulePackError, subsystemName, tableName } from "../../../src/core/rulepacks/index.ts";
import { displayName } from "../../../src/core/sheets/index.ts";
import type { SubsystemSpec } from "../../../src/core/subsystems/index.ts";
import { readReference } from "../../reference.ts";
import { literalPackSources, vectorPack, vectorRegistry } from "./adapter.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface MetaRow {
  kind: string;
  pack: string;
  names: string[];
  set_keys: string[];
  initiative_roll: string;
  commands: Record<string, { action: string; args: Record<string, Json>; tool: string }>;
  rank_labels: { locale: string | null; labels: Record<string, string> }[];
  display_names: { locale: string | null; names: Record<string, string> }[];
  subsystems: Record<string, Record<string, Json> & { labels: { locale: string | null; label: string }[] }>;
}

const compact = (text: string): string => text.replace(/\s+/g, "");

function oldSubsystem(spec: SubsystemSpec): Record<string, Json> {
  const common = { template: spec.template };
  switch (spec.template) {
    case "check_with_loss":
      return {
        ...common,
        stat: spec.stat,
        stat_max: spec.statMax ?? "",
        fumble_loss: spec.fumbleLoss,
        loss_ceiling: spec.lossCeiling === null ? null : [spec.lossCeiling.when.source, spec.lossCeiling.value],
      };
    case "improvement_check":
      return { ...common, roll: spec.roll.notation, improve: spec.improve.notation, cap: spec.cap, auto_success_above: spec.autoSuccessAbove };
    case "resource_spend_adjust":
      return { ...common, stat: spec.stat };
    case "opposed":
      return common;
    case "table_draw":
      return {
        ...common,
        default_table: spec.defaultTable,
        tables: Object.fromEntries(
          [...spec.tables.values()].map((table) => [
            table.id,
            { aliases: [...table.aliases], display: Object.fromEntries(table.labels), entries: [...table.entries] },
          ]),
        ),
      };
  }
}

describe("pack_meta rows", () => {
  const rows = [...readReference<MetaRow>("rules_pack_meta"), ...readReference<MetaRow>("rules_synthetic").filter((row) => row.kind === "pack_meta")];

  test("every row's loader-owned fields", () => {
    expect(rows.map((row) => row.pack)).toEqual(["coc7", "dnd5e", "wod", "oraclesynth", "oraclepool"]);
    let cells = 0;
    for (const row of rows) {
      const pack = vectorPack(row.pack);
      expect(pack.resolution).not.toBeNull();
      expect([...pack.names]).toEqual(row.names);
      expect([...pack.setKeys]).toEqual(row.set_keys);
      expect(pack.initiative === null ? "" : compact(pack.initiative.notation)).toBe(compact(row.initiative_roll));
      const commands = Object.fromEntries(
        [...pack.commands].map(([word, binding]) => [
          word,
          binding.kind === "action" ? { action: binding.action, args: {}, tool: "" } : { action: "", args: binding.args as Record<string, Json>, tool: binding.tool },
        ]),
      );
      expect(commands).toEqual(row.commands);
      for (const entry of row.rank_labels) {
        for (const [rankId, label] of Object.entries(entry.labels)) {
          cells++;
          expect(`${entry.locale} ${rankId} ${rankDisplay(pack, rankId, entry.locale)}`).toBe(`${entry.locale} ${rankId} ${label}`);
        }
      }
      for (const entry of row.display_names) {
        for (const [name, label] of Object.entries(entry.names)) {
          cells++;
          expect(displayName(pack.sheet, name, entry.locale)).toBe(label);
        }
      }
      expect([...pack.subsystems.keys()].sort()).toEqual(Object.keys(row.subsystems).sort());
      for (const [id, old] of Object.entries(row.subsystems)) {
        const spec = pack.subsystems.get(id)!;
        const actual = oldSubsystem(spec);
        const expected = Object.fromEntries(Object.keys(actual).map((key) => [key, old[key] ?? null]));
        expect(actual).toEqual(expected);
        for (const entry of old.labels) {
          cells++;
          expect(subsystemName(spec, entry.locale)).toBe(entry.label);
        }
      }
    }
    expect(cells).toBe(1376);
  });

  test("draw tables name themselves by locale, then en, then id", () => {
    const madness = vectorPack("coc7").subsystems.get("random_madness")!;
    if (madness.template !== "table_draw") throw new Error("template");
    expect(tableName(madness.tables.get("temp")!, "zh-CN")).toBe("临时性疯狂");
    expect(tableName(madness.tables.get("temp")!, "fr")).toBe("Temporary madness");
    const omen = vectorPack("oraclesynth").subsystems.get("omen")!;
    if (omen.template !== "table_draw") throw new Error("template");
    expect(tableName(omen.tables.get("major")!, "zh")).toBe("major");
  });
});

describe("sheets_aliases: system lookup", () => {
  const rows = readReference<Record<string, Json>>("sheets_aliases");

  test("load_rulepack", () => {
    const registry = vectorRegistry();
    const lookups = rows.filter((row) => row.kind === "load_rulepack");
    expect(lookups.length).toBe(20);
    for (const row of lookups) {
      expect([row.name, registry.resolve(row.name as string)?.id ?? null]).toEqual([row.name, row.pack]);
      expect(row.error === null).toBe(row.pack !== null);
    }
  });

  test("built_in_ids", () => {
    const row = rows.find((r) => r.kind === "built_in_ids")!;
    expect([...builtInPackIds()].sort()).toEqual(row.ids as string[]);
  });

  test("available_systems_contains: every listed pack loads, except the script pack, which is refused", () => {
    const row = rows.find((r) => r.kind === "available_systems_contains")!;
    const sources = literalPackSources();
    let refused: RulePackError | null = null;
    try {
      compileRulePack("oraclescript", sources.get("oraclescript")!);
    } catch (error) {
      refused = error as RulePackError;
    }
    expect(refused).toBeInstanceOf(RulePackError);
    expect([refused?.code, refused?.path]).toEqual(["SCRIPT_UNSUPPORTED", "resolution.script"]);
    expect([...vectorRegistry().ids(), "oraclescript"].sort()).toEqual(row.ids as string[]);
  });
});
