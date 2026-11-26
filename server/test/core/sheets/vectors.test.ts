// The sheet layer against the reference vectors. Every comparison goes through
// `adapter.ts`, whose header lists what is not compared and why; each test pins the
// number of cells compared and skipped per reason, so a change in coverage is visible.
import { describe, expect, test } from "bun:test";

import {
  checkValue,
  coerceInt,
  computeDerived,
  type DerivedValue,
  displayName,
  evaluateSheet,
  getHitPoints,
  hasCheckValue,
  newSheet,
  parseSheet,
  refreshSheet,
  resolveName,
  resourceLabels,
  type Sheet,
  type SheetSpec,
  type StatRead,
  setHitPoints,
  setSheetValue,
  sheetValue,
  validateSheet,
  wireResources,
} from "../../../src/core/sheets/index.ts";
import { readReference } from "../../reference.ts";
import {
  COLLISION_CASES,
  check,
  coercedInput,
  derivedAttrKeys,
  type Json,
  LEGACY_HP_CASES,
  type LegacySheet,
  legacyInt,
  legacyView,
  legacyViolation,
  settleLegacy,
  skip,
  spec,
  specForSystem,
  staleDerivedKeys,
  type Tally,
  tally,
  toInput,
  withoutAttributes,
} from "./adapter.ts";

interface ProbeRow {
  kind: "probe_names";
  pack: string;
  names: string[];
  canonical: string[];
  resolved: (string | null)[];
}
interface CaseRow {
  kind: "sheet_case";
  pack: string;
  case: string;
  input: LegacySheet;
  loaded: LegacySheet;
  canonical_values: Record<string, Json>;
  derived: Record<string, Json>;
  hit_points: [number, number];
  refreshed: Record<string, LegacySheet>;
  probe: { value: Json[]; check_value: Json[]; has_check: boolean[] };
  wire: Record<"loaded" | "refreshed", { locale: string | null; resources: Json[] }[]>;
  validate: { initialize_vitals: boolean; creation_method: string | null; result: { sheet: LegacySheet; violations: Json[] } }[];
}

const caseRows = readReference<ProbeRow | CaseRow>("sheets_cases");
const probes = new Map(caseRows.filter((r): r is ProbeRow => r.kind === "probe_names").map((r) => [r.pack, r]));
const cases = caseRows.filter((r): r is CaseRow => r.kind === "sheet_case");

function loaded(sheetSpec: SheetSpec, row: CaseRow): Sheet {
  return parseSheet(sheetSpec, toInput(sheetSpec, row.input)).sheet;
}

function readNumber(read: StatRead): number | string {
  switch (read.kind) {
    case "value":
      return read.value;
    case "text":
      return legacyInt(read.text);
    case "unset":
      return 0;
    case "failed":
      return `failed: ${read.issue.code}`;
  }
}

function mapOf(values: Record<string, Json>): Map<string, DerivedValue> {
  const out = new Map<string, DerivedValue>();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" || typeof value === "string") out.set(key, value);
  }
  return out;
}

function objectOf(values: ReadonlyMap<string, DerivedValue>): Record<string, Json> {
  return Object.fromEntries(values);
}

/** Every comparison matched, and the coverage is what it was: `compared` cells, and
 * `skipped` cells per reason (each reason is explained in adapter.ts or at its skip). */
function pin(t: Tally, compared: number, skipped: Record<string, number> = {}): void {
  expect(t.mismatches.slice(0, 10)).toEqual([]);
  expect({ compared: t.compared, skipped: t.skipped }).toEqual({ compared, skipped });
}

describe("sheets_cases", () => {
  test("names resolve through the alias tables", () => {
    const t = tally();
    for (const probe of probes.values()) {
      const sheetSpec = spec(probe.pack);
      probe.names.forEach((name, i) => check(t, `${probe.pack} resolve ${JSON.stringify(name)}`, resolveName(sheetSpec, name), probe.resolved[i]));
    }
    pin(t, 297);
  });

  test("loaded sheets, canonical values, derived values and hit points", () => {
    const t = tally();
    for (const row of cases) {
      const sheetSpec = spec(row.pack);
      const label = `${row.pack}/${row.case}`;
      if (coercedInput(sheetSpec, row.input)) {
        skip(t, "coerced input", 4);
        continue;
      }
      if (LEGACY_HP_CASES.has(row.case)) {
        skip(t, "2.x legacy hit-point slots", 4);
        continue;
      }
      const sheet = loaded(sheetSpec, row);
      const derivedKeys = derivedAttrKeys(sheetSpec);
      check(t, `${label} loaded`, withoutAttributes(legacyView(sheetSpec, sheet, false), derivedKeys), withoutAttributes(row.loaded, derivedKeys));

      // The derivation engine on the old engine's own canonical values.
      check(t, `${label} derived (old inputs)`, objectOf(computeDerived(sheetSpec, mapOf(row.canonical_values)).values), row.derived);

      if (COLLISION_CASES.has(row.case)) {
        skip(t, "canonical-name collision", 2);
      } else {
        const evaluation = evaluateSheet(sheetSpec, sheet);
        const derivedCanonicals = new Set(sheetSpec.shape?.derivedAttrs.values() ?? []);
        const expected = Object.fromEntries(Object.entries(row.canonical_values).filter(([name]) => !derivedCanonicals.has(name)));
        const actual = Object.fromEntries([...evaluation.source].filter(([name]) => !(sheetSpec.shape?.hitPoints && (name === "hp" || name === "hpmax"))));
        check(t, `${label} canonical values`, actual, expected);
        check(t, `${label} derived`, objectOf(evaluation.values), row.derived);
      }

      const stale = staleDerivedKeys(sheetSpec, row.loaded, sheet);
      if (!sheetSpec.shape?.hitPoints && (stale.has("HPMAX") || stale.has("HP"))) {
        skip(t, "stale derived slot (loaded)");
      } else {
        const hp = getHitPoints(sheetSpec, sheet);
        check(t, `${label} hit points`, hp.ok ? [hp.current, hp.max] : hp, row.hit_points);
      }
    }
    pin(t, 388, { "coerced input": 32, "2.x legacy hit-point slots": 8, "canonical-name collision": 4, "stale derived slot (loaded)": 13 });
  });

  test("refresh in all four modes", () => {
    const t = tally();
    for (const row of cases) {
      const sheetSpec = spec(row.pack);
      if (coercedInput(sheetSpec, row.input) || LEGACY_HP_CASES.has(row.case) || COLLISION_CASES.has(row.case)) {
        skip(t, "see loaded", 4);
        continue;
      }
      const sheet = loaded(sheetSpec, row);
      for (const init of [false, true]) {
        for (const keep of [false, true]) {
          const result = refreshSheet(sheetSpec, sheet, { initializeVitals: init, preserveTrained: keep });
          expect(result.issues).toEqual([]);
          check(t, `${row.pack}/${row.case} init${+init}_keep${+keep}`, legacyView(sheetSpec, result.sheet, true), row.refreshed[`init${+init}_keep${+keep}`]);
        }
      }
    }
    pin(t, 316, { "see loaded": 48 });
  });

  test("probes: value, check value, has check", () => {
    const t = tally();
    for (const row of cases) {
      const sheetSpec = spec(row.pack);
      const probe = probes.get(row.pack);
      if (!probe) throw new Error("no probe row");
      if (coercedInput(sheetSpec, row.input) || LEGACY_HP_CASES.has(row.case) || COLLISION_CASES.has(row.case)) {
        skip(t, "see loaded", probe.names.length * 3);
        continue;
      }
      const sheet = loaded(sheetSpec, row);
      const stale = staleDerivedKeys(sheetSpec, row.loaded, sheet);
      const readsStale = (name: string): boolean => {
        const shape = sheetSpec.shape;
        if (!shape) return false;
        const attr = shape.attrKeys.get(name);
        if (attr !== undefined && stale.has(attr)) return true;
        return !shape.hitPoints && (name === "hp" || name === "hpmax") && (stale.has("HP") || stale.has("HPMAX"));
      };
      // A skill stored under its canonical name although the pack declares another storage
      // key for it (`求生` stored, `生存` declared): the old `sheet_value` looked only at the
      // declared key and fell through to the derivation; the new read takes the stored value.
      const rawUnderCanonical = (name: string): boolean => {
        const key = sheetSpec.shape?.skillKeys.get(name);
        return key !== undefined && key !== name && sheet.skills.some(([skill]) => skill === name);
      };
      // `has_check` on a derived attribute slot's own key (`KNOW`): the old answer depended
      // on whether a stale copy happened to be stored.
      const namesStaleSlot = (name: string): boolean => stale.has(name) && !sheet.attributes.some(([key]) => key === name);
      probe.names.forEach((name, i) => {
        const canonical = probe.canonical[i] ?? name;
        const label = `${row.pack}/${row.case} ${JSON.stringify(name)}`;
        const target = sheetSpec.shape?.checkValues.get(canonical) ?? canonical;
        if (readsStale(canonical)) skip(t, "stale derived slot (loaded)");
        else if (rawUnderCanonical(canonical)) skip(t, "skill stored under its canonical name");
        else check(t, `${label} value`, readNumber(sheetValue(sheetSpec, sheet, canonical)), row.probe.value[i]);
        if (readsStale(target)) skip(t, "stale derived slot (loaded)");
        else if (rawUnderCanonical(target)) skip(t, "skill stored under its canonical name");
        else check(t, `${label} check value`, readNumber(checkValue(sheetSpec, sheet, canonical)), row.probe.check_value[i]);
        if (namesStaleSlot(name)) skip(t, "stale derived slot (loaded)");
        else check(t, `${label} has check`, hasCheckValue(sheetSpec, sheet, name), row.probe.has_check[i]);
      });
    }
    pin(t, 23590, { "stale derived slot (loaded)": 167, "see loaded": 3555, "skill stored under its canonical name": 6 });
  });

  test("wire resources, loaded and refreshed, every locale", () => {
    const t = tally();
    for (const row of cases) {
      const sheetSpec = spec(row.pack);
      if (coercedInput(sheetSpec, row.input) || LEGACY_HP_CASES.has(row.case) || COLLISION_CASES.has(row.case)) {
        skip(t, "see loaded", row.wire.loaded.length + row.wire.refreshed.length);
        continue;
      }
      const sheet = loaded(sheetSpec, row);
      const stale = staleDerivedKeys(sheetSpec, row.loaded, sheet);
      const affected = new Set(
        (sheetSpec.shape?.resources ?? [])
          .filter((r) => stale.has(r.valueKey) || stale.has(r.maxKey) || (r.source === "hit_points" && !sheetSpec.shape?.hitPoints && (stale.has("HP") || stale.has("HPMAX"))))
          .map((r) => r.id),
      );
      const refreshed = refreshSheet(sheetSpec, sheet).sheet;
      for (const entry of row.wire.loaded) {
        const keep = (r: unknown): boolean => !affected.has((r as { id: string }).id);
        if (affected.size > 0) skip(t, "stale derived slot (loaded)");
        check(t, `${row.pack}/${row.case} wire loaded ${entry.locale}`, wireResources(sheetSpec, sheet, entry.locale).resources.filter(keep), entry.resources.filter(keep));
      }
      for (const entry of row.wire.refreshed) {
        check(t, `${row.pack}/${row.case} wire refreshed ${entry.locale}`, wireResources(sheetSpec, refreshed, entry.locale).resources, entry.resources);
      }
    }
    pin(t, 1106, { "stale derived slot (loaded)": 140, "see loaded": 168 });
  });

  test("validation in six modes", () => {
    const t = tally();
    for (const row of cases) {
      const sheetSpec = spec(row.pack);
      if (LEGACY_HP_CASES.has(row.case)) {
        skip(t, "2.x legacy hit-point slots", row.validate.length * 2);
        continue;
      }
      for (const mode of row.validate) {
        if (row.case === "hp_strings") {
          // The old load read `"8"`/`"12"` hit points as unset and fell back to the pack's
          // 8/8; the new boundary reads integer text as the integer (8/12).
          skip(t, "integer text in hit points", 2);
          continue;
        }
        const label = `${row.pack}/${row.case} validate init=${mode.initialize_vitals} method=${mode.creation_method}`;
        const result = validateSheet(sheetSpec, toInput(sheetSpec, row.input), {
          initializeVitals: mode.initialize_vitals,
          creationMethod: mode.creation_method,
        });
        expect(result.issues).toEqual([]);
        const violations = result.violations.map(legacyViolation).filter((v) => v !== null);
        check(t, `${label} violations`, skillsSorted(violations), skillsSorted(mode.result.violations));
        if (COLLISION_CASES.has(row.case)) {
          skip(t, "canonical-name collision");
          continue;
        }
        const actualSheet = legacyView(sheetSpec, result.sheet, true);
        const expectedSheet = settleLegacy(sheetSpec, mode.result.sheet);
        if (coercedInput(sheetSpec, row.input)) {
          // The old derived slots were computed from the raw values (`GRIT: 4.8` gave
          // `ceil(4.8 / 2)`); the new ones from the settled integers.
          const derivedKeys = derivedAttrKeys(sheetSpec);
          check(t, `${label} sheet`, withoutAttributes(actualSheet, derivedKeys), withoutAttributes(expectedSheet, derivedKeys));
          if (derivedKeys.length > 0) skip(t, "derived slots computed from unsettled input");
          continue;
        }
        check(t, `${label} sheet`, actualSheet, expectedSheet);
      }
    }
    pin(t, 1044, {
      "derived slots computed from unsettled input": 18,
      "canonical-name collision": 12,
      "2.x legacy hit-point slots": 24,
      "integer text in hit points": 12,
    });
  });
});

// Attribute clamps follow the pack's order and are compared in order. Skill clamps follow
// the sheet's own order, which the vectors (written with sorted keys) do not preserve, so
// they are compared as a sorted run.
function skillsSorted(violations: Json[]): Json[] {
  const key = (v: Json): string => JSON.stringify(v, Object.keys(v as object).sort());
  const isSkill = (v: Json): boolean => String((v as { code: string }).code).startsWith("skill_");
  const skills = violations.filter(isSkill).map(key).sort();
  let i = 0;
  return violations.map((v) => (isSkill(v) ? JSON.parse(skills[i++] ?? "null") : JSON.parse(key(v))));
}

describe("sheets_derived", () => {
  interface DerivedRow {
    pack: string;
    values: Record<string, Json>;
    derived: Record<string, Json>;
  }
  const rows = readReference<DerivedRow>("sheets_derived");

  // The old engine read `true` as 1 and kept `12.7` as a float inside formulas; the new
  // boundary reads neither as that number (a boolean is not a stat, a fraction is
  // truncated). Every other odd input (numeric text, junk text, null, lists, objects)
  // reads the same way on both sides: as the number, or as unset.
  const divergent = (value: Json): boolean =>
    typeof value === "boolean" || (typeof value === "number" && (!Number.isInteger(value) || !Number.isSafeInteger(value)));

  test("the derivation sweep", () => {
    const t = tally();
    for (const row of rows) {
      if (Object.values(row.values).some(divergent)) {
        skip(t, "boolean or fractional input");
        continue;
      }
      const values = new Map<string, DerivedValue>();
      for (const [key, raw] of Object.entries(row.values)) {
        const value = typeof raw === "string" || typeof raw === "number" ? coerceInt(raw) : null;
        if (value !== null) values.set(key, value);
      }
      const result = computeDerived(spec(row.pack), values);
      expect(result.issues).toEqual([]);
      check(t, `${row.pack} ${JSON.stringify(row.values)}`, objectOf(result.values), row.derived);
    }
    pin(t, 1308, { "boolean or fractional input": 48 });
  });
});

describe("sheets_aliases", () => {
  const rows = readReference<Record<string, Json>>("sheets_aliases");

  test("resolve_skill", () => {
    const t = tally();
    for (const row of rows.filter((r) => r.kind === "resolve_skill")) {
      check(t, `${row.pack} ${JSON.stringify(row.name)}`, resolveName(spec(row.pack as string), row.name as string), row.canonical);
    }
    pin(t, 2473);
  });

  test("resource_label_map", () => {
    const t = tally();
    for (const row of rows.filter((r) => r.kind === "resource_label_map")) {
      const labels = resourceLabels(specForSystem(row.system as string), row.locale as string | null);
      check(t, `${row.system} ${row.locale}`, Object.fromEntries(labels), row.labels);
    }
    pin(t, 49);
  });
});

describe("rules_pack_meta display names", () => {
  interface MetaRow {
    pack: string;
    display_names: { locale: string | null; names: Record<string, string> }[];
  }
  test("display names per locale", () => {
    const t = tally();
    for (const row of readReference<MetaRow>("rules_pack_meta")) {
      const sheetSpec = spec(row.pack);
      for (const entry of row.display_names) {
        for (const [name, expected] of Object.entries(entry.names)) {
          const actual = displayName(sheetSpec, name, entry.locale);
          check(t, `${row.pack} ${entry.locale} ${name}`, actual, expected);
        }
      }
    }
    pin(t, 1056);
  });
});

describe("sheets_ops", () => {
  const ops = readReference<Record<string, Json>>("sheets_ops");
  const caseByKey = new Map(cases.map((row) => [`${row.pack}/${row.case}`, row]));

  test("set_sheet_value", () => {
    const t = tally();
    for (const op of ops.filter((r) => r.kind === "set_sheet_value")) {
      const sheetSpec = spec(op.pack as string);
      const row = caseByKey.get(`${op.pack}/${op.case}`);
      if (!row) throw new Error("missing case");
      if (LEGACY_HP_CASES.has(row.case)) {
        skip(t, "2.x legacy hit-point slots");
        continue;
      }
      const base = loaded(sheetSpec, row);
      const label = `${op.pack}/${op.case} ${op.canonical}=${JSON.stringify(op.value)}`;
      const result = setSheetValue(sheetSpec, base, op.canonical as string, op.value as number | string);
      const derivedKeys = derivedAttrKeys(sheetSpec);
      const expected = withoutAttributes(op.sheet_after as LegacySheet, derivedKeys);
      if (!result.ok) {
        // A pure derivation cannot be written; the old engine wrote it and its own refresh
        // overwrote it at once, so its sheet_after is the refreshed sheet.
        check(t, `${label} refused`, result.code, "derived_slot");
        check(t, `${label} unchanged`, withoutAttributes(legacyView(sheetSpec, refreshSheet(sheetSpec, base).sheet, false), derivedKeys), expected);
        skip(t, "refused: derived slot (refusal checked)");
        continue;
      }
      check(t, label, withoutAttributes(legacyView(sheetSpec, result.sheet, false), derivedKeys), expected);
    }
    pin(t, 221, { "refused: derived slot (refusal checked)": 10, "2.x legacy hit-point slots": 24 });
  });

  test("set_hit_points", () => {
    const t = tally();
    for (const op of ops.filter((r) => r.kind === "set_hit_points")) {
      const sheetSpec = spec(op.pack as string);
      const row = caseByKey.get(`${op.pack}/${op.case}`);
      if (!row) throw new Error("missing case");
      if (LEGACY_HP_CASES.has(row.case)) {
        skip(t, "2.x legacy hit-point slots");
        continue;
      }
      const base = loaded(sheetSpec, row);
      const operation = op.operation as Record<string, Json>;
      // Text amounts (`"6"`) are the caller's to parse; the API takes integers.
      const num = (key: string): number | undefined => (operation[key] === undefined ? undefined : (coerceInt(operation[key]) ?? undefined));
      const update = { current: num("current"), maximum: num("maximum"), delta: num("delta"), allowRaiseMax: operation.allow_raise_max === true };
      if (!sheetSpec.shape?.hitPoints && staleDerivedKeys(sheetSpec, row.loaded, base).has("HPMAX")) {
        // The old update started from the stale stored HPMAX; the new one from the derived maximum.
        skip(t, "stale derived slot (loaded)");
        continue;
      }
      const before = getHitPoints(sheetSpec, base);
      const result = setHitPoints(sheetSpec, base, update);
      const label = `${op.pack}/${op.case} ${JSON.stringify(operation)}`;
      const expectedResult = op.result as [number, number];
      if (!result.ok) {
        check(t, `${label} refused`, [result.code, before.ok && before.max !== expectedResult[1]], ["maximum_is_derived", true]);
        skip(t, "refused: derived maximum (refusal checked)");
        continue;
      }
      const derivedKeys = derivedAttrKeys(sheetSpec);
      check(t, label, [result.current, result.max], expectedResult);
      check(t, `${label} sheet`, withoutAttributes(legacyView(sheetSpec, result.sheet, false), derivedKeys), withoutAttributes(op.sheet_after as LegacySheet, derivedKeys));
    }
    pin(t, 284, { "2.x legacy hit-point slots": 21, "refused: derived maximum (refusal checked)": 10, "stale derived slot (loaded)": 21 });
  });

  test("new_sheet", () => {
    const t = tally();
    for (const op of ops.filter((r) => r.kind === "new_sheet")) {
      const sheetSpec = specForSystem(op.system as string);
      const created = newSheet(sheetSpec, op.name as string, op.system as string);
      expect(created.issues).toEqual([]);
      check(t, `new ${op.system}`, legacyView(sheetSpec, created.sheet, true), op.sheet);
    }
    pin(t, 9);
  });

  test("generate_character rows need the dice engine", () => {
    expect(ops.filter((r) => r.kind === "generate_character").length).toBe(41);
  });
});
