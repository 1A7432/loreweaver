// The sheet layer's own contract, beyond what the reference vectors record: content names
// that are JavaScript traps, formula failures reported instead of zeroed, pack errors at
// compile time, the loose-input boundary, refused writes, labels.
import { describe, expect, test } from "bun:test";

import {
  checkValue,
  coerceInt,
  compileSheetSpec,
  computeDerived,
  displayName,
  getHitPoints,
  hasCheckValue,
  newSheet,
  normalizeAlias,
  parseSheet,
  refreshSheet,
  resolveName,
  type Sheet,
  SheetSpecError,
  setHitPoints,
  setSheetValue,
  sheetValue,
  validateSheet,
  wireResources,
} from "../../../src/core/sheets/index.ts";
import { loadYaml } from "../../../src/core/yaml.ts";
import { packYaml, spec } from "./adapter.ts";

function pack(yaml: string) {
  return compileSheetSpec("test", loadYaml(yaml) as Record<string, unknown>);
}

function specError(run: () => unknown): SheetSpecError {
  try {
    run();
  } catch (error) {
    if (error instanceof SheetSpecError) return error;
    throw error;
  }
  throw new Error("expected a SheetSpecError");
}

const TRAPS = pack(`
defaults: {"10": 3, constructor: 7}
alias:
  constructor: [ctor]
  toString: [ts]
derived:
  twice: {expr: "constructor * 2"}
sheet:
  label: Traps
  attr_keys: {constructor: constructor, toString: toString}
  attributes: {b: 1, a: 2, constructor: 5, toString: 6}
  skills: {zeta: 1, alpha: 2}
  resources:
    - {id: b, label: B, value: b, max: a}
    - {id: a, label: A, value: a, max: b}
`);

describe("names that are JavaScript traps", () => {
  test("constructor, toString and __proto__ are ordinary names", () => {
    const { sheet, violations } = parseSheet(TRAPS, {
      attributes: [
        ["__proto__", 9],
        ["constructor", 4],
      ],
      skills: { toString: 3 },
    });
    expect(violations).toEqual([]);
    expect(sheet.attributes).toEqual([
      ["__proto__", 9],
      ["constructor", 4],
    ]);
    expect(sheetValue(TRAPS, sheet, "constructor")).toEqual({ kind: "value", value: 4, from: "sheet" });
    expect(computeDerived(TRAPS, new Map()).values.get("twice")).toBe(14);
    expect(sheetValue(TRAPS, sheet, "hasOwnProperty")).toEqual({ kind: "unset" });
    expect(resolveName(TRAPS, "CTOR")).toBe("constructor");
    expect(resolveName(TRAPS, "valueOf")).toBeNull();
    expect(Object.getPrototypeOf(sheet)).toBe(Object.prototype);
  });

  test("number-like names keep their written order", () => {
    const { sheet } = parseSheet(TRAPS, {
      skills: [
        ["b", 1],
        ["10", 2],
        ["2", 3],
      ],
    });
    expect(sheet.skills.map(([name]) => name)).toEqual(["b", "10", "2"]);
    const written = setSheetValue(TRAPS, sheet, "1", 5);
    expect(written.ok && written.sheet.skills.map(([name]) => name)).toEqual(["b", "10", "2", "1"]);
    // The pack's own order, not alphabetical, for fresh sheets and resources.
    const fresh = newSheet(TRAPS, "x", "test").sheet;
    expect(fresh.attributes.map(([name]) => name)).toEqual(["b", "a", "constructor", "toString"]);
    expect(wireResources(TRAPS, fresh, "en").resources.map((r) => r.id)).toEqual(["b", "a"]);
  });

  test("a sheet survives a JSON round trip unchanged", () => {
    const fresh = newSheet(spec("coc7"), "Vera", "coc7").sheet;
    const back = parseSheet(spec("coc7"), JSON.parse(JSON.stringify(fresh)));
    expect(back.violations).toEqual([]);
    expect(back.sheet).toEqual(fresh);
  });
});

describe("formulas", () => {
  test("a failing derived formula is reported, never 0, and blocks what reads it", () => {
    const failing = pack(`
derived:
  ratio: {expr: "a / b"}
  doubled: {expr: "ratio * 2"}
  fine: {expr: "a + 1"}
`);
    const result = computeDerived(failing, new Map([["a", 4], ["b", 0]]));
    expect(result.values.has("ratio")).toBe(false);
    expect(result.values.has("doubled")).toBe(false);
    expect(result.values.get("fine")).toBe(5);
    expect(result.issues.map((issue) => [issue.name, issue.code, issue.exprCode])).toEqual([
      ["ratio", "evaluation_failed", "DIVISION_BY_ZERO"],
      ["doubled", "input_failed", null],
    ]);
  });

  test("a non-integer or non-value result is reported", () => {
    const odd = pack(`
derived:
  half: {expr: "a / 2"}
  flag: {expr: "a > 1"}
  text: {expr: "if(a > 1, 'big', 'small')"}
`);
    const result = computeDerived(odd, new Map([["a", 3]]));
    expect(result.values.get("text")).toBe("big");
    expect(result.issues.map((issue) => [issue.name, issue.code])).toEqual([
      ["half", "not_integer"],
      ["flag", "bad_result"],
    ]);
  });

  test("bands, formats and the copy family", () => {
    const banded = pack(`
defaults: {s: 10}
derived:
  band:
    sum_ranges:
      of: [s, t]
      ranges: [[0, 9, low], [10, 19, -1]]
      else: {expr: "floor((s + t) / 10)", format: "{}d6 {{x}}"}
  half: {half_of: s}
  third: {floor_div: {of: s, by: 3}}
  copy: {copy_of: band}
`);
    expect(computeDerived(banded, new Map([["s", 3]])).values.get("band")).toBe("low");
    expect(computeDerived(banded, new Map([["s", 13]])).values.get("band")).toBe(-1);
    const high = computeDerived(banded, new Map([["s", 25], ["t", 30]]));
    expect(high.values.get("band")).toBe("5d6 {x}");
    expect(high.issues.map((issue) => [issue.name, issue.code])).toEqual([["copy", "not_integer"]]);
    const negative = computeDerived(banded, new Map([["s", -7]]));
    expect([negative.values.get("half"), negative.values.get("third")]).toEqual([-4, -3]);
  });

  test("a budget formula may call functions (the old engine compiled budgets without any)", () => {
    const budgeted = pack(`
sheet:
  label: B
  skills: {a: 0}
creation_constraints:
  budgets:
    points: {parts: ["floor(wit / 3)"]}
`);
    const over = validateSheet(budgeted, { attributes: { wit: 10 }, skills: { a: 5 } });
    expect(over.violations).toEqual([
      { code: "budget_exceeded", section: "skills", key: null, original: 5, corrected: null, limit: 3, budget: "points" },
    ]);
    const failing = pack(`
sheet:
  label: B
creation_constraints:
  budgets:
    points: {parts: ["10 / wit"]}
`);
    const result = validateSheet(failing, { skills: { a: 5 } });
    expect(result.violations).toEqual([]);
    expect(result.issues.map((issue) => [issue.kind, issue.name, issue.exprCode])).toEqual([["budget", "points", "DIVISION_BY_ZERO"]]);
  });

  test("a pack formula that does not compile is a pack error at compile time", () => {
    expect(specError(() => pack(`derived: {x: {expr: "floor("}}`)).code).toBe("BAD_FORMULA");
    expect(specError(() => pack(`derived: {x: {expr: "unknownfn(1)"}}`)).code).toBe("BAD_FORMULA");
    expect(specError(() => pack(`creation_constraints: {budgets: {p: {parts: ["a +"]}}}`)).code).toBe("BAD_FORMULA");
    expect(specError(() => pack(`sheet: {label: x, vitals: {HP: {max_key: M, start: {expr: ")"}}}}`)).code).toBe("BAD_FORMULA");
  });

  test("other pack errors", () => {
    expect(specError(() => pack(`derived: {x: {computer: dnd_mod}}`)).code).toBe("UNSUPPORTED_COMPUTER");
    expect(specError(() => pack(`derived: {x: {floor_div: {of: a, by: 0}}}`)).code).toBe("BAD_BOUND");
    expect(specError(() => pack(`derived: {x: {expr: "1", format: "{name}"}}`)).code).toBe("BAD_FORMAT");
    expect(specError(() => pack(`derived: {x: {copy_of: a, half_of: b}}`)).code).toBe("BAD_SHAPE");
    expect(specError(() => pack(`sheet: {label: x, colour: red}`)).code).toBe("UNKNOWN_KEY");
    expect(specError(() => pack(`sheet: {attributes: {a: 1}}`)).code).toBe("MISSING");
    expect(specError(() => pack(`sheet: {label: x, attributes: {a: 1.5}}`)).code).toBe("NOT_INTEGER");
    expect(specError(() => pack(`creation_constraints: {attributes: {A: {min: 9, max: 3}}}`)).code).toBe("BAD_BOUND");
    const error = specError(() => pack(`defaults: {a: x}`));
    expect([error.packId, error.where]).toEqual(["test", "defaults.a"]);
  });

  test("every built-in pack compiles", () => {
    for (const id of ["coc7", "dnd5e", "wod", "oraclesynth"]) {
      expect(() => compileSheetSpec(id, loadYaml(packYaml(id)) as Record<string, unknown>)).not.toThrow();
    }
    expect(spec("wod").shape).toBeNull();
  });
});

describe("the loose-input boundary", () => {
  test("integer coercion", () => {
    expect([coerceInt(5), coerceInt(-2.5), coerceInt(12.7), coerceInt(" 80 "), coerceInt("+7"), coerceInt("８０"), coerceInt("٣")]).toEqual([
      5, -2, 12, 80, 7, 80, 3,
    ]);
    for (const junk of [true, null, "", "abc", "12abc", "1e3", "0x10", "1_000", [1], {}, Number.NaN, Infinity, 2 ** 60, "9".repeat(20)]) {
      expect(coerceInt(junk)).toBeNull();
    }
  });

  test("each value that cannot be kept is reported", () => {
    const dnd = spec("dnd5e");
    const { sheet, violations } = parseSheet(dnd, {
      attributes: { STR: "14", DEX: "fast", CON: 12.9 },
      fields: { level: "abc", race: 3, mystery: 1 },
      hitPoints: { current: "x", max: 10 },
      equipment: "sword",
    });
    expect(sheet.attributes).toEqual([
      ["STR", 14],
      ["CON", 12],
    ]);
    expect(sheet.fields).toEqual([
      ["character_class", ""],
      ["race", ""],
      ["level", 1],
    ]);
    expect(sheet.hitPoints).toEqual({ current: 10, max: 10 });
    expect(violations.map((v) => [v.code, v.section, v.key, v.corrected])).toEqual([
      ["unknown_entry", "fields", "mystery", null],
      ["malformed", "equipment", null, null],
      ["attribute_not_numeric", "attributes", "DEX", null],
      ["field_not_text", "fields", "race", ""],
      ["field_not_numeric", "fields", "level", 1],
      ["hit_points_not_numeric", "hitPoints", "current", null],
    ]);
  });

  test("a derived attribute arriving with the input is not stored", () => {
    const { sheet } = parseSheet(spec("coc7"), { attributes: { CON: 50, SIZ: 50, HPMAX: 99 } });
    expect(sheet.attributes).toEqual([
      ["CON", 50],
      ["SIZ", 50],
    ]);
    expect(sheetValue(spec("coc7"), sheet, "生命值上限")).toEqual({ kind: "value", value: 10, from: "derived" });
  });

  test("validation drops an unconstrained value that is not a number, and never mutates its input", () => {
    const input = { attributes: { x: "3", y: null }, skills: { a: true } };
    const frozen = JSON.stringify(input);
    const result = validateSheet(spec("wod"), input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(result.sheet.attributes).toEqual([["x", 3]]);
    expect(result.violations.map((v) => [v.code, v.key])).toEqual([
      ["attribute_not_numeric", "y"],
      ["skill_not_numeric", "a"],
    ]);
  });
});

describe("writes", () => {
  const coc = spec("coc7");
  const fresh = (): Sheet => newSheet(coc, "Vera", "coc7").sheet;

  test("a derived slot cannot be written; its sources can", () => {
    expect(setSheetValue(coc, fresh(), "生命值上限", 99)).toEqual({ ok: false, code: "derived_slot" });
    const written = setSheetValue(coc, fresh(), "体质", 30);
    if (!written.ok) throw new Error("refused");
    expect(sheetValue(coc, written.sheet, "生命值上限")).toEqual({ kind: "value", value: 8, from: "derived" });
    expect(sheetValue(coc, written.sheet, "生命值")).toEqual({ kind: "value", value: 8, from: "sheet" });
  });

  test("type mismatches are refused", () => {
    expect(setSheetValue(coc, fresh(), "侦查", "high")).toEqual({ ok: false, code: "not_integer" });
    expect(setSheetValue(coc, fresh(), "职业", 3)).toEqual({ ok: false, code: "not_text" });
    expect(setSheetValue(coc, fresh(), "年龄", 1.5)).toEqual({ ok: false, code: "not_integer" });
  });

  test("a derived maximum cannot be raised through hit points", () => {
    expect(setHitPoints(coc, fresh(), { maximum: 20 })).toEqual({ ok: false, code: "maximum_is_derived" });
    expect(setHitPoints(coc, fresh(), { current: 30, allowRaiseMax: true })).toEqual({ ok: false, code: "maximum_is_derived" });
    const hurt = setHitPoints(coc, fresh(), { delta: -3 });
    expect(hurt.ok && [hurt.current, hurt.max]).toEqual([7, 10]);
    expect(() => setHitPoints(coc, fresh(), { delta: 0.5 })).toThrow(RangeError);
  });

  test("an edit keeps a wounded character wounded; creation re-derives pools", () => {
    const hurt = setHitPoints(coc, fresh(), { current: 3 });
    if (!hurt.ok) throw new Error("refused");
    const edited = setSheetValue(coc, hurt.sheet, "侦查", 60);
    expect(edited.ok && getHitPoints(coc, edited.sheet)).toEqual({ ok: true, current: 3, max: 10 });
    const created = refreshSheet(coc, hurt.sheet, { initializeVitals: true });
    expect(getHitPoints(coc, created.sheet)).toEqual({ ok: true, current: 10, max: 10 });
  });

  test("check values and unknown names", () => {
    const dnd = spec("dnd5e");
    const sheet = newSheet(dnd, "Kael", "dnd5e").sheet;
    const strong = setSheetValue(dnd, sheet, "力量", 16);
    if (!strong.ok) throw new Error("refused");
    expect(checkValue(dnd, strong.sheet, "力量")).toEqual({ kind: "value", value: 3, from: "derived" });
    expect(hasCheckValue(dnd, strong.sheet, "STRENGTH")).toBe(true);
    expect(hasCheckValue(dnd, strong.sheet, "祖传菜刀")).toBe(false);
  });
});

describe("labels", () => {
  const synth = spec("oraclesynth");
  test("a resource label resolves for the viewer, then en, then the id", () => {
    const sheet = newSheet(synth, "Ilya", "oraclesynth").sheet;
    const labels = (locale: string | null) => wireResources(synth, sheet, locale).resources.map((r) => r.label);
    expect(labels("zh-TW")).toEqual(["体力", "Fate"]);
    expect(labels("JA")).toEqual(["体力値", "Fate"]);
    expect(labels("fr")).toEqual(["HP", "Fate"]);
    expect(labels(null)).toEqual(["HP", "Fate"]);
    const onlyZh = pack(`
sheet:
  label: Z
  attributes: {V: 1}
  resources: [{id: v, label: {zh: 值}, value: V, max: V}]
`);
    expect(wireResources(onlyZh, newSheet(onlyZh, "", "").sheet, "en").resources[0]?.label).toBe("v");
  });

  test("display names use the viewer's table, else the canonical name", () => {
    expect(displayName(synth, "muscle", "zh_CN")).toBe("肌力");
    expect(displayName(synth, "nerve", "en")).toBe("nerve");
    expect(displayName(spec("coc7"), "侦查", "zh")).toBe("侦查");
    expect(displayName(spec("coc7"), "侦查", "en-GB")).toBe("Spot Hidden");
  });

  test("alias normalisation", () => {
    expect(normalizeAlias("  Spot_Hidden ")).toBe("spot hidden");
    expect(normalizeAlias("驾驶（飞行器）")).toBe("驾驶(飞行器)");
    expect(normalizeAlias("STRAßE")).toBe("strasse");
    expect(resolveName(spec("coc7"), "　侦查　")).toBe("侦查");
  });
});
