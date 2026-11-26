import { describe, expect, test } from "bun:test";

import {
  builtInPackIds,
  builtInPacks,
  builtInPackSource,
  compileRulePack,
  expertiseText,
  rankDisplay,
  rankLabel,
  type RulePack,
  RulePackError,
  type RulePackErrorCode,
  RulePackRegistry,
  subsystemName,
} from "../../../src/core/rulepacks/index.ts";
import { computeDerived } from "../../../src/core/sheets/index.ts";
import { loadYaml } from "../../../src/core/yaml.ts";

function refusal(id: string, text: string, bases?: Record<string, string>): { code: RulePackErrorCode; path: string; layerCode: string | undefined } {
  try {
    compileRulePack(id, text, bases === undefined ? {} : { bases: (base) => bases[base] ?? null });
  } catch (error) {
    if (!(error instanceof RulePackError)) throw error;
    expect(error.packId).toBe(id);
    return { code: error.code, path: error.path, layerCode: error.layerCode };
  }
  throw new Error("the pack loaded");
}

const MINIMAL = ["names: [mini]", "resolution:", "  roll: 1d20", "  target: dc", "  compare: '>='", "  ranks:", "    - {id: hit, when: 'roll >= target', success: true}", "    - {id: miss}"].join("\n");

describe("built-in packs", () => {
  const packs = builtInPacks();

  test("the three built-ins compile, frozen, in discovery order", () => {
    expect(packs.map((pack) => pack.id)).toEqual(["coc7", "dnd5e", "wod"]);
    expect([...builtInPackIds()]).toEqual(["coc7", "dnd5e", "wod"]);
    for (const pack of packs) {
      expect(Object.isFrozen(pack)).toBe(true);
      expect(Object.isFrozen(pack.source)).toBe(true);
      expect(pack.resolution).not.toBeNull();
    }
    expect(builtInPackSource("coc7")).toContain("sanity_check");
    expect(builtInPackSource("nope")).toBeNull();
  });

  test("each call compiles afresh: no shared state", () => {
    expect(builtInPacks()[0]).not.toBe(packs[0]);
  });

  test("sections reach the pack compiled", () => {
    const coc = packs[0]!;
    expect([...coc.subsystems.keys()]).toEqual(["sanity_check", "skill_growth", "spend_luck", "opposed_check", "random_madness"]);
    expect(coc.commands.get("ti")).toEqual({ kind: "tool", tool: "random_madness", args: { table: "temp" } });
    expect(coc.commands.get("coc")).toEqual({ kind: "action", action: "make_char" });
    expect(coc.initiative?.notation.replace(/\s/g, "")).toBe("1d100+{敏捷}");
    expect(rankLabel(coc, "regular", "en")).toEqual({ display: "Success", markers: ["Regular Success"] });
    expect(rankDisplay(coc, "fumble", "zh-TW")).toBe("大失败");
    expect(rankDisplay(coc, "nonesuch", "en")).toBe("nonesuch");
    expect(expertiseText(coc, "zh_CN")).toContain("守秘人");
    expect(expertiseText(coc, "fr")).toContain("Keeper");
    expect(subsystemName(coc.subsystems.get("sanity_check")!, "zh")).toBe("理智");
    expect((coc.stShow as Record<string, unknown>).sortBy).toBe("name");
    // Informative sections are read from the source by their consumers.
    const dnd = packs[1]!;
    expect(((dnd.source.creation_constraints as Record<string, unknown>).methods as Record<string, unknown>).standard_array).toEqual({ values: [15, 14, 13, 12, 10, 8] });
    expect(packs[2]!.turnChecks).toEqual([]);
  });
});

describe("RulePackRegistry", () => {
  const packs = builtInPacks();
  const registry = new RulePackRegistry(packs);

  test("resolves a system by id, names or set_keys, normalized", () => {
    expect(registry.resolve("Call_Of_Cthulhu")?.id).toBe("coc7");
    expect(registry.resolve("D&D5E")?.id).toBe("dnd5e");
    expect(registry.resolve("dnd 5e")).toBeNull();
    expect(registry.get("wod")?.id).toBe("wod");
    expect(registry.get("WOD")).toBeNull();
  });

  test("the first pack to claim a name keeps it; an id cannot be added twice", () => {
    const squatter = compileRulePack("squatter", `${MINIMAL.replace("names: [mini]", "names: [coc, squat]")}`);
    const extended = registry.with(squatter);
    expect(extended.resolve("coc")?.id).toBe("coc7");
    expect(extended.resolve("squat")?.id).toBe("squatter");
    expect(registry.resolve("squat")).toBeNull();
    expect(() => extended.with(compileRulePack("squatter", MINIMAL))).toThrow(RulePackError);
    expect(extended.ids()).toEqual(["coc7", "dnd5e", "wod", "squatter"]);
  });

  test("a make-character word routes to the first pack declaring it, even through extends", () => {
    const patch = compileRulePack("pulp-coc", "extends: coc7\nnames: [pulp]\ncommands:\n  pulp: {action: make_char}\n");
    const withPatch = registry.with(patch);
    expect(withPatch.makeCharacterPack(" COC ")?.id).toBe("coc7");
    expect(withPatch.makeCharacterPack("pulp")?.id).toBe("pulp-coc");
    expect(withPatch.makeCharacterPack("ra")).toBeNull();
  });
});

describe("extends", () => {
  test("deep-merges the child over the base; null deletes; lists replace; new keys follow", () => {
    const base = "names: [base]\ndefaults: {力量: 50, 体质: 50}\nalias: {力量: [str], 体质: [con]}\nset_keys: [base]\n";
    const child = "extends: base\nnames: [patched]\ndefaults:\n  力量: 70\n  意志: 40\nalias:\n  体质: null\n  意志: [pow]\n";
    const pack = compileRulePack("patched", child, { bases: (id) => (id === "base" ? base : null) });
    expect([...pack.sheet.defaults]).toEqual([["力量", 70], ["体质", 50], ["意志", 40]]);
    expect(pack.names).toEqual(["patched"]);
    expect(pack.setKeys).toEqual(["base"]);
    expect(Object.keys(pack.source.alias as object)).toEqual(["力量", "意志"]);
    expect(Object.hasOwn(pack.source, "extends")).toBe(false);
  });

  test("a built-in base by default; its derived math survives", () => {
    const pack = compileRulePack("pulp-coc", "extends: coc7\nnames: [pulp-coc]\ndefaults:\n  幸运: 99\n");
    expect(pack.sheet.defaults.get("幸运")).toBe(99);
    const derived = computeDerived(pack.sheet, new Map([["力量", 60], ["体型", 70]]));
    expect(derived.values.get("DB")).toBe("1d4");
    expect(pack.subsystems.size).toBe(5);
  });

  test("a patch can add a variant without restating the base ladder", () => {
    const child = "extends: coc7\nresolution:\n  variants:\n    smoke:\n      ranks:\n        - {id: crit, when: 'roll == 1', success: true, critical: true}\n        - {id: fail}\n";
    const pack = compileRulePack("smoke", child);
    expect([...pack.resolution!.variants.keys()]).toContain("smoke");
    expect(pack.resolution!.variants.has("rule1")).toBe(true);
  });

  test("grandparents resolve; the depth, cycles and unknown bases fail the load", () => {
    const bases = { a: "defaults: {x: 1, y: 1, z: 1}", b: "extends: a\ndefaults: {y: 2}" };
    const pack = compileRulePack("c", "extends: b\ndefaults:\n  z: 3\n", { bases: (id) => bases[id as keyof typeof bases] ?? null });
    expect([...pack.sheet.defaults]).toEqual([["x", 1], ["y", 2], ["z", 3]]);
    const deep: Record<string, string> = {};
    for (let i = 0; i < 8; i++) deep[`p${i}`] = `extends: p${i + 1}`;
    deep.p8 = "{}";
    expect(refusal("top", "extends: p0", deep).code).toBe("EXTENDS_TOO_DEEP");
    // Four bases is the limit, and is fine.
    expect(compileRulePack("top", "extends: p5", { bases: (id) => deep[id] ?? null }).id).toBe("top");
    expect(refusal("c", "extends: a", { a: "extends: b", b: "extends: a" }).code).toBe("EXTENDS_CYCLE");
    expect(refusal("self", "extends: self", { self: "{}" }).code).toBe("EXTENDS_CYCLE");
    expect(refusal("c", "extends: nope", {}).code).toBe("EXTENDS_UNKNOWN");
    expect(refusal("c", "extends: 3", {}).code).toBe("EXTENDS_INVALID");
    expect(refusal("c", "extends: a", { a: "[1, 2]" }).code).toBe("NOT_A_MAPPING");
    expect(refusal("c", "extends: a", { a: "a: [" }).code).toBe("BAD_YAML");
  });
});

describe("the document", () => {
  test("unknown top-level keys are ignored and kept in the source", () => {
    const pack = compileRulePack("mini", `${MINIMAL}\nfuture_section: {anything: 1}\n`);
    expect(pack.source.future_section).toEqual({ anything: 1 });
  });

  test("an empty document is an empty pack", () => {
    const pack = compileRulePack("empty", "");
    expect([pack.resolution, pack.subsystems.size, pack.sheet.shape, pack.initiative]).toEqual([null, 0, null, null]);
  });

  test("a parsed document is copied, never frozen in the caller's hands", () => {
    const doc = loadYaml(MINIMAL) as Record<string, unknown>;
    const pack = compileRulePack("mini", doc);
    expect(Object.isFrozen(doc)).toBe(false);
    (doc.names as string[]).push("changed");
    expect(pack.names).toEqual(["mini"]);
  });

  test("turn checks are shape-checked", () => {
    const pack = compileRulePack("tc", "turn_checks:\n  - {when: dice_forged, instruction: {EN: Roll first}, max_rounds: 2}\n  - {condition: narration_lost, enabled: false, id: lost}\n");
    expect(pack.turnChecks.map((row) => [row.id, row.condition, [...row.instruction], row.maxRounds, row.enabled])).toEqual([
      [null, "dice_forged", [["en", "Roll first"]], 2, true],
      ["lost", "narration_lost", [], null, false],
    ]);
    expect(refusal("tc", "turn_checks:\n  - {when: x, extra: 1}").code).toBe("UNKNOWN_KEY");
    expect(refusal("tc", "turn_checks:\n  - {instruction: {en: x}}").path).toBe("turn_checks[0].when");
    expect(refusal("tc", "turn_checks:\n  - {when: x, max_rounds: 0}").code).toBe("BAD_FIELD");
    expect(refusal("tc", "turn_checks: {when: x}").code).toBe("BAD_FIELD");
  });
});

describe("refusals: every one a RulePackError with a code and a path", () => {
  const cases: [string, string, RulePackErrorCode, string][] = [
    ["bad YAML", "names: [", "BAD_YAML", "(root)"],
    ["a list root", "- a", "NOT_A_MAPPING", "(root)"],
    ["names not a list", "names: coc", "BAD_FIELD", "names"],
    ["a non-string name", "names: [1]", "BAD_FIELD", "names[0]"],
    ["a broken ladder", "resolution:\n  roll: 1d20\n  ranks: [{id: a, when: 'roll > 1'}]", "BAD_RESOLUTION", "resolution.ranks"],
    ["a resolution script", "resolution:\n  roll: 1d20\n  script: resolve.js", "SCRIPT_UNSUPPORTED", "resolution.script"],
    ["a broken sheet", "sheet: {label: X, bogus: 1}", "BAD_SHEET", "sheet"],
    ["a bad derived formula", "derived: {a: {expr: '1 +'}}", "BAD_SHEET", "derived.a.expr"],
    ["a bad label", "labels: {en: {hit: 3}}", "BAD_FIELD", "labels.en.hit"],
    ["an empty label list", "labels: {en: {hit: []}}", "BAD_FIELD", "labels.en.hit"],
    ["a label locale twice", "labels: {en: {}, EN: {}}", "DUPLICATE_ID", "labels.EN"],
    ["an initiative without roll", "initiative: {dice: 1d20}", "BAD_FIELD", "initiative.roll"],
    ["a broken initiative", "initiative: {roll: '1d20 +'}", "BAD_NOTATION", "initiative.roll"],
    ["expertise not text", "expertise: {en: [a]}", "BAD_FIELD", "expertise.en"],
    ["a command with both", "commands: {ra: {action: check, tool: x}}", "BAD_FIELD", "commands.ra"],
    ["a command with neither", "commands: {ra: {}}", "BAD_FIELD", "commands.ra"],
    ["an unknown action", "commands: {ra: {action: roll}}", "BAD_FIELD", "commands.ra.action"],
    ["an undeclared tool", "commands: {sc: {tool: sanity}}", "UNDECLARED", "commands.sc.tool"],
    ["a command key typo", "commands: {ra: {action: check, arg: 1}}", "UNKNOWN_KEY", "commands.ra"],
    ["a word twice", "commands: {ra: {action: check}, RA: {action: check}}", "DUPLICATE_ID", "commands.RA"],
    ["a subsystem script", "subsystems: {flow: {script: flow.js}}", "SCRIPT_UNSUPPORTED", "subsystems.flow.script"],
    ["an unknown template", "subsystems: {x: {template: magic}}", "BAD_FIELD", "subsystems.x.template"],
    ["a reserved name", "subsystems: {module_action: {template: opposed}}", "RESERVED_NAME", "subsystems.module_action"],
    ["a private name", "subsystems: {_x: {template: opposed}}", "BAD_ID", "subsystems._x"],
    ["a key of another template", "subsystems: {x: {template: opposed, stat: SAN}}", "UNKNOWN_KEY", "subsystems.x"],
    ["a loss check without stat", "subsystems: {x: {template: check_with_loss}}", "BAD_FIELD", "subsystems.x.stat"],
    ["a bad fumble rule", "subsystems: {x: {template: check_with_loss, stat: S, fumble_loss: half}}", "BAD_FIELD", "subsystems.x.fumble_loss"],
    ["a ceiling string", "subsystems: {x: {template: check_with_loss, stat: S, loss_ceiling: 'a'}}", "BAD_FIELD", "subsystems.x.loss_ceiling"],
    ["a ceiling without when", "subsystems: {x: {template: check_with_loss, stat: S, loss_ceiling: {value: 0}}}", "BAD_FIELD", "subsystems.x.loss_ceiling.when"],
    ["a ceiling without value", "subsystems: {x: {template: check_with_loss, stat: S, loss_ceiling: {when: '1 == 1'}}}", "BAD_FIELD", "subsystems.x.loss_ceiling.value"],
    ["a negative ceiling", "subsystems: {x: {template: check_with_loss, stat: S, loss_ceiling: {when: '1 == 1', value: -1}}}", "BAD_FIELD", "subsystems.x.loss_ceiling.value"],
    ["a ceiling key typo", "subsystems: {x: {template: check_with_loss, stat: S, loss_ceiling: {when: '1 == 1', value: 0, extra: true}}}", "UNKNOWN_KEY", "subsystems.x.loss_ceiling"],
    ["a broken ceiling", "subsystems: {x: {template: check_with_loss, stat: S, loss_ceiling: {when: 'tag ==', value: 1}}}", "BAD_EXPRESSION", "subsystems.x.loss_ceiling.when"],
    ["a broken growth roll", "subsystems: {x: {template: improvement_check, improve: 'd'}}", "BAD_NOTATION", "subsystems.x.improve"],
    ["a cap that is no integer", "subsystems: {x: {template: improvement_check, cap: high}}", "BAD_FIELD", "subsystems.x.cap"],
    ["no tables", "subsystems: {x: {template: table_draw, tables: {}}}", "BAD_FIELD", "subsystems.x.tables"],
    ["an empty table", "subsystems: {x: {template: table_draw, tables: {t: {entries: []}}}}", "BAD_FIELD", "subsystems.x.tables.t.entries"],
    ["a table id twice", "subsystems: {x: {template: table_draw, tables: {t: {entries: [a]}, T: {entries: [b]}}}}", "DUPLICATE_ID", "subsystems.x.tables.T"],
    ["an unknown default table", "subsystems: {x: {template: table_draw, default: u, tables: {t: {entries: [a]}}}}", "UNDECLARED", "subsystems.x.default"],
    ["a check template without resolution", "subsystems: {x: {template: opposed}}", "NEEDS_RESOLUTION", "subsystems.x.template"],
    ["a creation roll that does not parse", "creation_constraints: {attributes: {STR: {roll: '3d'}}}", "BAD_NOTATION", "creation_constraints.attributes.STR.roll"],
  ];
  for (const [what, yaml, code, path] of cases) {
    test(what, () => {
      expect(refusal("bad", yaml)).toMatchObject({ code, path });
    });
  }

  test("too many subsystems", () => {
    const many = Array.from({ length: 17 }, (_, i) => `  s${i}: {template: table_draw, tables: {t: {entries: [a]}}}`).join("\n");
    expect(refusal("bad", `subsystems:\n${many}`).code).toBe("TOO_MANY");
  });

  test("a bad pack id", () => {
    expect(refusal("Bad Id", MINIMAL).code).toBe("BAD_ID");
  });

  test("a wrapped error keeps the layer's code and cause", () => {
    expect(refusal("bad", "resolution:\n  roll: 1d20\n  ranks: [{id: a, when: 'roll > 1'}]").layerCode).toBe("BAD_LADDER");
    expect(refusal("bad", "names: [").layerCode).toBe("syntax");
  });

  test("a write target or creation roll on a derived attribute slot", () => {
    const sheet = "sheet:\n  label: X\n  attr_keys: {fate: F, fatemax: FM}\n  derived_attrs: {FM: fatemax}\nderived:\n  fatemax: {expr: '3'}\n";
    expect(refusal("bad", `${MINIMAL}\n${sheet}subsystems:\n  spend: {template: resource_spend_adjust, stat: FM}\n`)).toMatchObject({ code: "DERIVED_SLOT", path: "subsystems.spend.stat" });
    expect(refusal("bad", `${sheet}creation_constraints:\n  attributes:\n    FM: {roll: 1d6}\n`)).toMatchObject({ code: "DERIVED_SLOT", path: "creation_constraints.attributes.FM.roll" });
  });
});

test("a pack's tables are frozen", () => {
  const pack: RulePack = builtInPacks()[0]!;
  expect(Object.isFrozen(pack.labels)).toBe(true);
  expect(Object.isFrozen(pack.subsystems.get("random_madness"))).toBe(true);
  expect(Object.isFrozen(pack.turnChecks)).toBe(true);
});
