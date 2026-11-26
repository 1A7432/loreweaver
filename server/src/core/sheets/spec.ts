/**
 * The compiled sheet specification of one rule pack, and the compiler that builds it from
 * the pack's raw data.
 *
 * A pack describes its system's sheets as data: which storage slots exist, how canonical
 * stat names (`力量`, `hp`) map onto them, which slots are pure derivations, the current
 * pools ("vitals") and their maxima, the resource meters clients draw, the derived
 * formulas, defaults, aliases and display names, and the creation constraints validation
 * enforces. The engine holds none of it. Compiling checks all of it once, at pack load;
 * the result is frozen and shared by every sheet of that system.
 */

import type { CompiledExpr } from "../condexpr.ts";
import { SheetSpecError, type SheetSpecErrorCode } from "./errors.ts";
import { type BandValue, compileDerivedRule, compileFormula, type DerivedRule } from "./formulas.ts";
import type { Table } from "./table.ts";
import { normalizeAlias, normalizeLocale } from "./text.ts";

/**
 * What the sheet layer reads from a rule pack: the pack's top-level YAML mapping, as
 * parsed (e.g. by `core/yaml.ts`'s `loadYaml`, which guarantees that a mapping iterates
 * in its written order). Every key is optional; other keys of the pack are ignored here.
 *
 * - `defaults`: canonical name → integer, what an unset stat reads as in formulas.
 * - `alias`: canonical name → list of alternative names (any language).
 * - `display`: locale → (canonical name → display label).
 * - `derived`: derived name → formula entry, folded in written order.
 * - `sheet`: the sheet shape; a pack without one keeps bare name→value tables.
 * - `creation_constraints`: attribute/skill ranges, skill-point budgets, point-buy.
 */
export interface SheetPackSource {
  readonly defaults?: unknown;
  readonly alias?: unknown;
  readonly display?: unknown;
  readonly derived?: unknown;
  readonly sheet?: unknown;
  readonly creation_constraints?: unknown;
}

/** A meta field's value: text (`occupation`) or an integer (`level`). */
export type FieldValue = string | number;

export interface Vital {
  /** Attribute storage key of the current value (`HP`). */
  readonly key: string;
  /** Attribute storage key of its maximum (`HPMAX`). */
  readonly maxKey: string;
  /** How creation sets it: to the maximum, or by a formula (clamped into [0, max]). */
  readonly start: { readonly kind: "full" } | { readonly kind: "expr"; readonly expr: CompiledExpr };
}

export interface ResourceSpec {
  readonly id: string;
  /** Locale (normalised: lower case, `-`) → label. */
  readonly labels: ReadonlyMap<string, string>;
  /** `hit_points`: the sheet's hit points; `attributes`: two attribute slots. */
  readonly source: "attributes" | "hit_points";
  readonly valueKey: string;
  readonly maxKey: string;
}

export interface SheetShape {
  readonly label: string;
  /** Canonical name → storage key, per section. */
  readonly attrKeys: ReadonlyMap<string, string>;
  readonly skillKeys: ReadonlyMap<string, string>;
  readonly secondaryKeys: ReadonlyMap<string, string>;
  /** Canonical name → meta field name. */
  readonly fieldKeys: ReadonlyMap<string, string>;
  /** A fresh sheet's tables, in pack order. A field's type is its default's type. */
  readonly attributes: Table<number>;
  readonly secondary: Table<number>;
  readonly skills: Table<number>;
  readonly fields: Table<FieldValue>;
  /** Field-based hit points (current and maximum stored on the sheet), with their fresh values. */
  readonly hitPoints: { readonly current: number; readonly max: number } | null;
  /** Storage key → canonical name of the derived value it shows. Attribute slots are pure
   * derivations (never stored); skill and secondary slots keep a stored value that differs
   * from the derivation (a trained skill, an armour-adjusted AC). */
  readonly derivedAttrs: ReadonlyMap<string, string>;
  readonly derivedSkills: ReadonlyMap<string, string>;
  readonly derivedSecondary: ReadonlyMap<string, string>;
  /** Canonical name → the canonical name whose value a check on it rolls against. */
  readonly checkValues: ReadonlyMap<string, string>;
  readonly vitals: readonly Vital[];
  readonly resources: readonly ResourceSpec[];
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface AttributeConstraint extends Range {
  /** The creation roll's dice expression, for character generation (not run here). */
  readonly roll: string | null;
}

export type BudgetPart =
  | { readonly kind: "formula"; readonly expr: CompiledExpr }
  /** The best of several alternatives (occupation formula families). */
  | { readonly kind: "best"; readonly exprs: readonly CompiledExpr[] };

export interface Budget {
  readonly id: string;
  readonly parts: readonly BudgetPart[];
}

export interface PointBuy extends Range {
  readonly budget: number;
  /** Attribute value → cost; an unlisted value costs 0. */
  readonly costs: ReadonlyMap<number, number>;
}

export interface CreationConstraints {
  /** Attribute storage key → range, in pack order (also the creation roll order). */
  readonly attributes: ReadonlyMap<string, AttributeConstraint>;
  /** The range every non-derived skill must lie in, or null. */
  readonly skills: (Range & { readonly growthMax: number | null }) | null;
  readonly budgets: readonly Budget[];
  readonly pointBuy: PointBuy | null;
}

export interface SheetSpec {
  readonly packId: string;
  readonly defaults: ReadonlyMap<string, number>;
  /** Normalised alias → canonical name (each canonical name is its own alias). */
  readonly aliases: ReadonlyMap<string, string>;
  /** Locale (normalised) → canonical name → display label. */
  readonly displayNames: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly derived: readonly DerivedRule[];
  /** Null for a pack without a `sheet:` section: sheets keep bare tables, nothing derives
   * onto them and no resources are drawn. */
  readonly shape: SheetShape | null;
  readonly constraints: CreationConstraints;
}

/** At most this many resource meters per sheet (they share a client's status bar). */
export const MAX_RESOURCES = 8;

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class Reader {
  readonly packId: string;

  constructor(packId: string) {
    this.packId = packId;
  }

  fail(code: SheetSpecErrorCode, where: string, detail: string): never {
    throw new SheetSpecError(code, this.packId, where, detail);
  }

  /** A mapping, or `{}` when absent (`null`/undefined). */
  mapping(where: string, raw: unknown): Raw {
    if (raw === undefined || raw === null) return {};
    if (!isRecord(raw)) this.fail("BAD_SHAPE", where, "expected a mapping");
    return raw;
  }

  onlyKeys(where: string, raw: Raw, allowed: readonly string[]): void {
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) this.fail("UNKNOWN_KEY", where, `unknown key '${key}'`);
    }
  }

  int(where: string, raw: unknown, fallback?: number): number {
    if (raw === undefined && fallback !== undefined) return fallback;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
      this.fail("NOT_INTEGER", where, `expected an integer, got ${JSON.stringify(raw)}`);
    }
    return raw;
  }

  text(where: string, raw: unknown): string {
    if (typeof raw !== "string" || raw.trim() === "") this.fail("MISSING", where, "expected non-empty text");
    return raw;
  }

  /** A mapping of names to names (`attr_keys`), in written order. */
  names(where: string, raw: unknown): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(this.mapping(where, raw))) out.set(key, this.text(`${where}.${key}`, value));
    return out;
  }

  /** A mapping of names to integers (a fresh-sheet table), in written order. */
  ints(where: string, raw: unknown): Table<number> {
    return Object.entries(this.mapping(where, raw)).map(([key, value]) => Object.freeze([key, this.int(`${where}.${key}`, value)] as const));
  }

  range(where: string, raw: Raw, fallbackMin: number, fallbackMax: number): Range {
    const min = this.int(`${where}.min`, raw.min, fallbackMin);
    const max = this.int(`${where}.max`, raw.max, fallbackMax);
    if (min > max) this.fail("BAD_BOUND", where, `min ${min} is above max ${max}`);
    return { min, max };
  }

  /** A label: plain text (the `en` label) or a locale → text map. */
  labels(where: string, raw: unknown): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    if (typeof raw === "string") {
      if (raw.trim() === "") this.fail("MISSING", where, "empty label");
      out.set("en", raw.trim());
      return out;
    }
    if (!isRecord(raw)) this.fail("BAD_SHAPE", where, "a label is text or a locale map");
    for (const [locale, text] of Object.entries(raw)) {
      if (typeof text !== "string") this.fail("BAD_SHAPE", `${where}.${locale}`, "a label must be text");
      if (text.trim() !== "") out.set(normalizeLocale(locale), text.trim());
    }
    if (out.size === 0) this.fail("MISSING", where, "empty label map");
    return out;
  }
}

const SHEET_KEYS = [
  "label",
  "attr_keys",
  "skill_keys",
  "secondary_keys",
  "field_keys",
  "attributes",
  "skills",
  "secondary",
  "fields",
  "hit_points",
  "derived_skills",
  "derived_attrs",
  "derived_secondary",
  "check_values",
  "vitals",
  "resources",
] as const;

function compileShape(r: Reader, raw: unknown): SheetShape | null {
  if (raw === undefined || raw === null) return null;
  const sheet = r.mapping("sheet", raw);
  r.onlyKeys("sheet", sheet, SHEET_KEYS);

  const fields: [string, FieldValue][] = [];
  for (const [name, value] of Object.entries(r.mapping("sheet.fields", sheet.fields))) {
    if (typeof value === "string") fields.push([name, value]);
    else fields.push([name, r.int(`sheet.fields.${name}`, value)]);
  }

  let hitPoints: SheetShape["hitPoints"] = null;
  if (sheet.hit_points !== undefined && sheet.hit_points !== null) {
    const hp = r.mapping("sheet.hit_points", sheet.hit_points);
    r.onlyKeys("sheet.hit_points", hp, ["current", "max"]);
    hitPoints = Object.freeze({ current: r.int("sheet.hit_points.current", hp.current, 0), max: r.int("sheet.hit_points.max", hp.max, 0) });
  }

  const vitals: Vital[] = [];
  for (const [key, entry] of Object.entries(r.mapping("sheet.vitals", sheet.vitals))) {
    const where = `sheet.vitals.${key}`;
    const vital = r.mapping(where, entry);
    r.onlyKeys(where, vital, ["max_key", "start"]);
    const maxKey = r.text(`${where}.max_key`, vital.max_key);
    let start: Vital["start"];
    if (vital.start === undefined || vital.start === "full") {
      start = { kind: "full" };
    } else if (isRecord(vital.start)) {
      r.onlyKeys(`${where}.start`, vital.start, ["expr"]);
      start = { kind: "expr", expr: compileFormula(r.packId, `${where}.start.expr`, vital.start.expr) };
    } else {
      r.fail("BAD_SHAPE", `${where}.start`, "start is 'full' or {expr}");
    }
    vitals.push(Object.freeze({ key, maxKey, start: Object.freeze(start) }));
  }

  const resourcesRaw = sheet.resources ?? [];
  if (!Array.isArray(resourcesRaw)) r.fail("BAD_SHAPE", "sheet.resources", "expected a list");
  if (resourcesRaw.length > MAX_RESOURCES) r.fail("BAD_BOUND", "sheet.resources", `at most ${MAX_RESOURCES} resources`);
  const seenIds = new Set<string>();
  const resources = resourcesRaw.map((entry, i): ResourceSpec => {
    const where = `sheet.resources.${i}`;
    const resource = r.mapping(where, entry);
    r.onlyKeys(where, resource, ["id", "label", "source", "value", "max"]);
    const id = r.text(`${where}.id`, resource.id);
    if (seenIds.has(id)) r.fail("BAD_SHAPE", `${where}.id`, `duplicate resource id '${id}'`);
    seenIds.add(id);
    const source = resource.source ?? "attributes";
    if (source !== "attributes" && source !== "hit_points") {
      r.fail("BAD_SHAPE", `${where}.source`, "source is attributes or hit_points");
    }
    const labels = r.labels(`${where}.label`, resource.label);
    if (source === "hit_points") {
      // Reads the sheet's hit points wherever the pack keeps them (fields, or the HP/HPMAX
      // attributes), so it names no slots of its own.
      if (resource.value !== undefined || resource.max !== undefined) {
        r.fail("UNKNOWN_KEY", where, "a hit_points resource takes no value/max keys");
      }
      return Object.freeze({ id, labels, source, valueKey: "", maxKey: "" });
    }
    return Object.freeze({
      id,
      labels,
      source,
      valueKey: r.text(`${where}.value`, resource.value),
      maxKey: r.text(`${where}.max`, resource.max),
    });
  });

  return Object.freeze({
    label: r.text("sheet.label", sheet.label).trim(),
    attrKeys: r.names("sheet.attr_keys", sheet.attr_keys),
    skillKeys: r.names("sheet.skill_keys", sheet.skill_keys),
    secondaryKeys: r.names("sheet.secondary_keys", sheet.secondary_keys),
    fieldKeys: r.names("sheet.field_keys", sheet.field_keys),
    attributes: Object.freeze(r.ints("sheet.attributes", sheet.attributes)),
    secondary: Object.freeze(r.ints("sheet.secondary", sheet.secondary)),
    skills: Object.freeze(r.ints("sheet.skills", sheet.skills)),
    fields: Object.freeze(fields.map((entry) => Object.freeze(entry))),
    hitPoints,
    derivedAttrs: r.names("sheet.derived_attrs", sheet.derived_attrs),
    derivedSkills: r.names("sheet.derived_skills", sheet.derived_skills),
    derivedSecondary: r.names("sheet.derived_secondary", sheet.derived_secondary),
    checkValues: r.names("sheet.check_values", sheet.check_values),
    vitals: Object.freeze(vitals),
    resources: Object.freeze(resources),
  });
}

function compileConstraints(r: Reader, raw: unknown): CreationConstraints {
  // Other keys (standard arrays, archetype priorities, …) belong to other consumers of
  // the pack and are left alone.
  const section = r.mapping("creation_constraints", raw);

  const attributes = new Map<string, AttributeConstraint>();
  for (const [key, entry] of Object.entries(r.mapping("creation_constraints.attributes", section.attributes))) {
    const where = `creation_constraints.attributes.${key}`;
    const rule = r.mapping(where, entry);
    r.onlyKeys(where, rule, ["min", "max", "roll"]);
    const roll = rule.roll === undefined || rule.roll === null ? null : r.text(`${where}.roll`, rule.roll);
    attributes.set(key, Object.freeze({ ...r.range(where, rule, 0, 100), roll }));
  }

  let skills: CreationConstraints["skills"] = null;
  const skillSection = r.mapping("creation_constraints.skills", section.skills);
  if (skillSection.default !== undefined && skillSection.default !== null) {
    const where = "creation_constraints.skills.default";
    const rule = r.mapping(where, skillSection.default);
    r.onlyKeys(where, rule, ["min", "max", "growth_max"]);
    const growthMax = rule.growth_max === undefined ? null : r.int(`${where}.growth_max`, rule.growth_max);
    skills = Object.freeze({ ...r.range(where, rule, 0, 99), growthMax });
  }

  const budgets: Budget[] = [];
  for (const [id, entry] of Object.entries(r.mapping("creation_constraints.budgets", section.budgets))) {
    const where = `creation_constraints.budgets.${id}`;
    const rule = r.mapping(where, entry);
    r.onlyKeys(where, rule, ["parts"]);
    if (!Array.isArray(rule.parts) || rule.parts.length === 0) r.fail("MISSING", `${where}.parts`, "expected a non-empty list");
    const parts = rule.parts.map((part, i): BudgetPart => {
      const here = `${where}.parts.${i}`;
      if (isRecord(part)) {
        r.onlyKeys(here, part, ["max"]);
        if (!Array.isArray(part.max) || part.max.length === 0) r.fail("MISSING", `${here}.max`, "expected a non-empty list of formulas");
        return Object.freeze({
          kind: "best" as const,
          exprs: Object.freeze(part.max.map((formula, j) => compileFormula(r.packId, `${here}.max.${j}`, formula))),
        });
      }
      return Object.freeze({ kind: "formula" as const, expr: compileFormula(r.packId, here, part) });
    });
    budgets.push(Object.freeze({ id, parts: Object.freeze(parts) }));
  }

  let pointBuy: PointBuy | null = null;
  const methods = r.mapping("creation_constraints.methods", section.methods);
  if (methods.point_buy !== undefined && methods.point_buy !== null) {
    const where = "creation_constraints.methods.point_buy";
    const rule = r.mapping(where, methods.point_buy);
    r.onlyKeys(where, rule, ["budget", "min", "max", "costs"]);
    const costs = new Map<number, number>();
    for (const [value, cost] of Object.entries(r.mapping(`${where}.costs`, rule.costs))) {
      if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        r.fail("NOT_INTEGER", `${where}.costs.${value}`, "a cost key is an attribute value");
      }
      costs.set(Number(value), r.int(`${where}.costs.${value}`, cost));
    }
    pointBuy = Object.freeze({ ...r.range(where, rule, 0, 0), budget: r.int(`${where}.budget`, rule.budget, 0), costs });
  }

  return Object.freeze({ attributes, skills, budgets: Object.freeze(budgets), pointBuy });
}

/**
 * Compile the sheet-related sections of the rule pack `packId` (its parsed top-level
 * mapping). Throws `SheetSpecError` naming the offending key.
 */
export function compileSheetSpec(packId: string, pack: SheetPackSource): SheetSpec {
  const r: Reader = new Reader(packId);
  if (!isRecord(pack)) r.fail("BAD_SHAPE", "(root)", "a rule pack is a mapping");

  const defaults = new Map<string, number>();
  for (const [name, value] of Object.entries(r.mapping("defaults", pack.defaults))) defaults.set(name, r.int(`defaults.${name}`, value));

  // Later entries win a collision (two canonical names claiming one alias), as the
  // written order is the author's last word.
  const aliases = new Map<string, string>();
  for (const [canonical, variants] of Object.entries(r.mapping("alias", pack.alias))) {
    aliases.set(normalizeAlias(canonical), canonical);
    if (variants === null || variants === undefined) continue;
    if (!Array.isArray(variants)) r.fail("BAD_SHAPE", `alias.${canonical}`, "expected a list of names");
    variants.forEach((variant, i) => {
      if (typeof variant !== "string") r.fail("BAD_SHAPE", `alias.${canonical}.${i}`, "an alias is text");
      aliases.set(normalizeAlias(variant), canonical);
    });
  }

  const displayNames = new Map<string, ReadonlyMap<string, string>>();
  for (const [locale, table] of Object.entries(r.mapping("display", pack.display))) {
    const names = new Map<string, string>();
    for (const [name, label] of Object.entries(r.mapping(`display.${locale}`, table))) {
      if (typeof label !== "string") r.fail("BAD_SHAPE", `display.${locale}.${name}`, "a display name is text");
      names.set(name, label);
    }
    const key = normalizeLocale(locale);
    displayNames.set(key, new Map([...(displayNames.get(key) ?? []), ...names]));
  }

  const derived = Object.entries(r.mapping("derived", pack.derived)).map(([name, entry]) => compileDerivedRule(packId, name, entry));

  return Object.freeze({
    packId,
    defaults,
    aliases,
    displayNames,
    derived: Object.freeze(derived),
    shape: compileShape(r, pack.sheet),
    constraints: compileConstraints(r, pack.creation_constraints),
  });
}

export type { BandValue, DerivedRule };
