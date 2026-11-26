// Maps the reference vectors (`sheets_*`, `rules_pack_meta`, recorded from the frozen
// Python engine) onto the new sheet API, and turns the new results back into the
// vectors' 2.x shapes so whole sheets can be compared.
//
// The 2.x sheet dict (`attributes`, `secondary_attributes`, `hp_current`, `hp_max`, …)
// is only a vector format here: `toInput` maps it to the new `Sheet` input shape and
// `legacyView` maps a new `Sheet` back. Timestamps are not in the vectors.
//
// What is NOT compared, and why, is decided by the classifiers below (each one names a
// deliberate deviation of the new layer; the tests pin how many cells each one skips):
// - `coercedInput`: the case's input holds values that are not integers of the right
//   type (`"65"`, `12.7`, `true`, `"abc"`, a text level). The old engine kept them raw on
//   the loaded sheet and read them three different ways (0 in direct reads, the pack
//   default in formulas, the range minimum in validation); the new `parseSheet` settles
//   them once at the boundary. Only `validate` is compared for such cases (after the
//   same settling is applied to the old output), since validation is where the old
//   engine settled them too.
// - `staleDerivedKeys`: a derived attribute slot (`HPMAX`, `IDEA`, …) whose stored copy on
//   the loaded sheet differs from its derivation, or is missing. The old reads (`sheet_value`,
//   hit points, resource meters) returned the stale stored copy; the new layer never
//   stores derived slots and always derives. Cells that read such a slot are skipped on
//   the LOADED sheet (on refreshed sheets both sides agree and are compared).
// - `LEGACY_HP_CASES`: hit points recovered from the 2.x legacy slots (`生命值` secondary,
//   `HP`/`HPMAX` attributes on a field-hit-point pack). 3.0 reads no 2.x formats.
// - `COLLISION_CASES`: a value stored under a canonical name (`体质` attribute, `信用评级`
//   skill) next to its declared slot (`CON`, `信用`); the old canonical namespace let
//   whichever key came later in the dict win, the new one lets the declared slot win.
// - Further cell-level reasons (integer text in hit points, a skill stored under its
//   canonical name, writes refused instead of silently undone, the not-generated
//   characters) are explained where the test skips them.
// - `hp`/`hpmax` in `canonical_values`: the new namespace includes field hit points, so a
//   formula reading `hp` sees the real value instead of the pack default.
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  coerceInt,
  compileSheetSpec,
  evaluateSheet,
  type FieldValue,
  parseSheet,
  type Sheet,
  type SheetSpec,
  type SheetViolation,
} from "../../../src/core/sheets/index.ts";
import { loadYaml } from "../../../src/core/yaml.ts";
import { readReference } from "../../reference.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type LegacySheet = { [key: string]: Json };

const REPO = join(import.meta.dir, "..", "..", "..", "..");

function synthYaml(id: string): string {
  const row = readReference<{ kind: string; pack: string; yaml: string }>("rules_synthetic").find(
    (r) => r.kind === "pack" && r.pack === id,
  );
  if (!row) throw new Error(`no literal pack ${id}`);
  return row.yaml;
}

export function packYaml(id: string): string {
  return id === "oraclesynth" ? synthYaml(id) : readFileSync(join(REPO, "rulepacks", `${id}.yaml`), "utf8");
}

let specCache: Map<string, SheetSpec> | null = null;

/** The four packs the vectors use, compiled. */
export function specs(): Map<string, SheetSpec> {
  if (specCache === null) {
    specCache = new Map();
    for (const id of ["coc7", "dnd5e", "wod", "oraclesynth"]) {
      specCache.set(id, compileSheetSpec(id, loadYaml(packYaml(id)) as Record<string, unknown>));
    }
  }
  return specCache;
}

export function spec(id: string): SheetSpec {
  const found = specs().get(id);
  if (!found) throw new Error(`unknown pack ${id}`);
  return found;
}

/** A spec for a system no pack resolves (bare tables). */
export const NO_PACK: SheetSpec = compileSheetSpec("none", {});

/** The system spellings the vectors use, resolved the way the rule-pack loader will. */
export function specForSystem(system: string): SheetSpec {
  const key = system.trim().toLowerCase();
  const table: Record<string, string> = {
    coc: "coc7",
    coc7: "coc7",
    "call of cthulhu": "coc7",
    dnd: "dnd5e",
    dnd5e: "dnd5e",
    wod: "wod",
    "world of darkness": "wod",
    oraclesynth: "oraclesynth",
  };
  const id = Object.hasOwn(table, key) ? table[key] : undefined;
  return id === undefined ? NO_PACK : spec(id);
}

/** A 2.x sheet dict → the new input shape. */
export function toInput(sheetSpec: SheetSpec, old: LegacySheet): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: old.name,
    system: old.system,
    attributes: old.attributes,
    secondary: old.secondary_attributes,
    skills: old.skills,
    fields: old.fields,
    equipment: old.equipment,
    background: old.background,
    notes: old.notes,
    avatar: old.avatar,
  };
  // Only a pack with field hit points has them; the old engine ignored the two keys
  // everywhere else.
  if (sheetSpec.shape?.hitPoints) input.hitPoints = { current: old.hp_current ?? null, max: old.hp_max ?? null };
  return input;
}

function object(table: readonly (readonly [string, FieldValue])[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of table) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * A new sheet in the 2.x dict shape. With `derivedAttributes`, the derived attribute slots
 * are filled in from the derivation, as the old `refresh_sheet` wrote them into storage.
 */
export function legacyView(sheetSpec: SheetSpec, sheet: Sheet, derivedAttributes: boolean): LegacySheet {
  const attributes = object(sheet.attributes);
  if (derivedAttributes && sheetSpec.shape) {
    const evaluation = evaluateSheet(sheetSpec, sheet);
    for (const [key, canonical] of sheetSpec.shape.derivedAttrs) {
      const value = evaluation.values.get(canonical);
      if (value !== undefined) attributes[key] = value;
    }
  }
  return {
    name: sheet.name,
    system: sheet.system,
    attributes,
    secondary_attributes: object(sheet.secondary),
    skills: object(sheet.skills),
    fields: object(sheet.fields),
    hp_current: sheet.hitPoints?.current ?? null,
    hp_max: sheet.hitPoints?.max ?? null,
    equipment: sheet.equipment as Json[],
    background: sheet.background,
    notes: sheet.notes,
    avatar: sheet.avatar as Json,
  };
}

/** `sheet` without the given attribute keys (derived slots never stored in 3.0). */
export function withoutAttributes(sheet: LegacySheet, keys: Iterable<string>): LegacySheet {
  const attributes = { ...(sheet.attributes as Record<string, Json>) };
  for (const key of keys) delete attributes[key];
  return { ...sheet, attributes };
}

export function derivedAttrKeys(sheetSpec: SheetSpec): string[] {
  return [...(sheetSpec.shape?.derivedAttrs.keys() ?? [])];
}

function isInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Whether the 2.x input holds any value the new boundary has to settle. */
export function coercedInput(sheetSpec: SheetSpec, old: LegacySheet): boolean {
  for (const section of ["attributes", "secondary_attributes", "skills"]) {
    const table = old[section];
    if (table && typeof table === "object" && Object.values(table).some((value) => !isInt(value))) return true;
  }
  const fields = (old.fields ?? {}) as Record<string, Json>;
  for (const [name, fallback] of sheetSpec.shape?.fields ?? []) {
    if (!Object.hasOwn(fields, name)) continue;
    const value = fields[name];
    if (typeof fallback === "string" ? typeof value !== "string" : !isInt(value)) return true;
  }
  if (sheetSpec.shape?.hitPoints) {
    for (const key of ["hp_current", "hp_max"]) if (old[key] !== null && old[key] !== undefined && !isInt(old[key])) return true;
  }
  return false;
}

export const LEGACY_HP_CASES: ReadonlySet<string> = new Set(["hp_legacy_secondary", "hp_legacy_attributes"]);
export const COLLISION_CASES: ReadonlySet<string> = new Set(["chinese_keys_in_attributes", "credit_bridge"]);

/** Derived attribute slots whose stored copy on the old LOADED sheet is stale or missing. */
export function staleDerivedKeys(sheetSpec: SheetSpec, loaded: LegacySheet, sheet: Sheet): Set<string> {
  const stale = new Set<string>();
  const shape = sheetSpec.shape;
  if (!shape) return stale;
  const evaluation = evaluateSheet(sheetSpec, sheet);
  const stored = loaded.attributes as Record<string, Json>;
  for (const [key, canonical] of shape.derivedAttrs) {
    const derived = evaluation.values.get(canonical);
    if (!Object.hasOwn(stored, key) || stored[key] !== derived) stale.add(key);
  }
  return stale;
}

/** The old `_int_or` reading of a value: integers as is, integer text parsed, else 0. */
export function legacyInt(value: FieldValue): number {
  return typeof value === "number" ? value : (coerceInt(value) ?? 0);
}

const SECTION_PATH: Record<string, string> = { secondary: "secondary_attributes" };

/** A new violation in the old `{code, path, original, corrected, limit}` shape, or null
 * for a code the old engine did not have. */
export function legacyViolation(v: SheetViolation): Json | null {
  const old = [
    "attribute_not_numeric",
    "attribute_below_min",
    "attribute_above_max",
    "skill_not_numeric",
    "skill_below_min",
    "skill_above_max",
    "point_buy_budget_exceeded",
  ];
  let code: string;
  if (v.code === "budget_exceeded") code = `${v.budget}_exceeded`;
  else if (old.includes(v.code) && !(v.code.endsWith("_not_numeric") && v.corrected === null)) code = v.code;
  // A dropped unconstrained value is new: the old engine kept it on the sheet unreported.
  else return null;
  const section = SECTION_PATH[v.section] ?? v.section;
  return {
    code,
    path: v.key === null ? section : `${section}.${v.key}`,
    original: v.original as Json,
    corrected: v.corrected,
    limit: Array.isArray(v.limit) ? [...v.limit] : (v.limit as Json),
  };
}

/** The old validated sheet with the new boundary's settling applied (identity for a sheet
 * that holds only integers of the right type). */
export function settleLegacy(sheetSpec: SheetSpec, old: LegacySheet): LegacySheet {
  const derived = new Set(derivedAttrKeys(sheetSpec));
  const settled = parseSheet(sheetSpec, toInput(sheetSpec, withoutAttributes(old, derived))).sheet;
  const view = legacyView(sheetSpec, settled, false);
  const attributes = view.attributes as Record<string, Json>;
  const oldAttributes = old.attributes as Record<string, Json>;
  for (const key of derived) if (Object.hasOwn(oldAttributes, key)) attributes[key] = oldAttributes[key] as Json;
  return view;
}

export interface Tally {
  compared: number;
  skipped: Record<string, number>;
  mismatches: string[];
}

export function tally(): Tally {
  return { compared: 0, skipped: {}, mismatches: [] };
}

export function skip(t: Tally, reason: string, count = 1): void {
  t.skipped[reason] = (t.skipped[reason] ?? 0) + count;
}

/** Structural equality on JSON (object key order ignored). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((key) => Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

export function check(t: Tally, label: string, actual: unknown, expected: unknown): void {
  t.compared += 1;
  if (!same(actual, expected)) {
    t.mismatches.push(`${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}
