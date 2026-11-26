/**
 * The character sheet as data, and how one is read from loose input.
 *
 * A `Sheet` is plain JSON: it is stored and sent as is. Stat tables are ordered
 * `[name, value]` pair lists (see `table.ts` for why not objects) holding safe integers;
 * meta fields hold text or integers according to the pack's declared default. A sheet
 * never stores a derived attribute: those slots are computed from the pack on every read
 * (`evaluate.ts`), so storage cannot carry a stale copy.
 *
 * `parseSheet` is the boundary for anything that did not come from this module (a stored
 * row, a tool argument, an import): it settles every value to the sheet's types and
 * reports, as `SheetViolation`s, each value it could not keep. It never throws on content.
 */

import type { FieldValue, SheetSpec } from "./spec.ts";
import type { Entry, Table } from "./table.ts";
import { coerceInt } from "./text.ts";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface HitPoints {
  readonly current: number;
  readonly max: number;
}

export interface Sheet {
  readonly name: string;
  /** The system the sheet was made for, as the owner wrote it (resolving it is the
   * caller's business; the sheet layer is always handed the compiled spec). */
  readonly system: string;
  /** Attribute storage key → value. Never holds a derived attribute slot. */
  readonly attributes: Table<number>;
  readonly secondary: Table<number>;
  readonly skills: Table<number>;
  /** The pack's declared meta fields, every one present, in pack order. */
  readonly fields: Table<FieldValue>;
  /** Field-based hit points; null for a pack that keeps them in attributes (or has none). */
  readonly hitPoints: HitPoints | null;
  readonly equipment: readonly JsonValue[];
  readonly background: string;
  readonly notes: string;
  readonly avatar: JsonObject | null;
}

export type SheetSection =
  | "sheet"
  | "name"
  | "system"
  | "attributes"
  | "secondary"
  | "skills"
  | "fields"
  | "hitPoints"
  | "equipment"
  | "background"
  | "notes"
  | "avatar";

export type SheetViolationCode =
  /** A constrained value that is not a number; replaced by the range minimum. Also an
   * unconstrained one, which is dropped (`corrected` null). */
  | "attribute_not_numeric"
  | "attribute_below_min"
  | "attribute_above_max"
  | "skill_not_numeric"
  | "skill_below_min"
  | "skill_above_max"
  | "secondary_not_numeric"
  /** An integer field holding something else; reset to the pack's default. */
  | "field_not_numeric"
  /** A text field holding something else; reset to the pack's default. */
  | "field_not_text"
  /** A hit-point value that is not a number; read as unset. */
  | "hit_points_not_numeric"
  /** An entry this pack does not define (an undeclared field, hit points on a pack that
   * keeps them in attributes); dropped. */
  | "unknown_entry"
  /** A section of the wrong type (a list where a table belongs); read as empty. */
  | "malformed"
  /** The skill points spent exceed a creation budget (`budget` names it). */
  | "budget_exceeded"
  /** A point-buy sheet costs more than the point-buy budget. */
  | "point_buy_budget_exceeded";

/** One rule a sheet broke, as data; rendering a notice is the caller's job. */
export interface SheetViolation {
  readonly code: SheetViolationCode;
  readonly section: SheetSection;
  /** The entry's name within the section, or null for a whole-section finding. */
  readonly key: string | null;
  /** The value as found (for a clamp: after integer coercion; for a budget: points spent). */
  readonly original: unknown;
  /** What the value became, or null when it was dropped or nothing was changed. */
  readonly corrected: FieldValue | null;
  /** `[min, max]` for a range, the budget for a budget, else null. */
  readonly limit: readonly [number, number] | number | null;
  /** The budget id, for `budget_exceeded`. */
  readonly budget?: string;
}

export function violation(
  code: SheetViolationCode,
  section: SheetSection,
  key: string | null,
  original: unknown,
  corrected: FieldValue | null = null,
  limit: SheetViolation["limit"] = null,
): SheetViolation {
  return Object.freeze({ code, section, key, original, corrected, limit });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const MAX_JSON_DEPTH = 64;

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJson(item, depth + 1));
  return false;
}

/**
 * A sheet read from input but not yet settled: values are still raw, so validation can
 * clamp constrained entries against what was actually written before the rest is coerced.
 */
export interface SheetDraft {
  name: string;
  system: string;
  attributes: Entry<unknown>[];
  secondary: Entry<unknown>[];
  skills: Entry<unknown>[];
  /** Declared fields only, starting from the pack defaults. */
  fields: Entry<unknown>[];
  hitPoints: { current: unknown; max: unknown } | null;
  equipment: readonly JsonValue[];
  background: string;
  notes: string;
  avatar: JsonObject | null;
}

function readEntries(section: SheetSection, raw: unknown, out: SheetViolation[]): Entry<unknown>[] {
  if (raw === undefined || raw === null) return [];
  const entries: Entry<unknown>[] = [];
  const put = (key: string, value: unknown): void => {
    const at = entries.findIndex(([name]) => name === key);
    if (at >= 0) entries[at] = [key, value];
    else entries.push([key, value]);
  };
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) put(key, value);
    return entries;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string") put(item[0], item[1]);
      else out.push(violation("malformed", section, null, item));
    }
    return entries;
  }
  out.push(violation("malformed", section, null, raw));
  return [];
}

function readText(section: SheetSection, raw: unknown, out: SheetViolation[]): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  out.push(violation("malformed", section, null, raw));
  return "";
}

/** Read the structure of `input`; values stay raw. Structural findings go to `out`. */
export function readDraft(spec: SheetSpec, input: unknown, out: SheetViolation[]): SheetDraft {
  const shape = spec.shape;
  let source: Readonly<Record<string, unknown>> = {};
  if (isRecord(input)) source = input;
  else out.push(violation("malformed", "sheet", null, input));

  // A pure derivation is never stored; a copy arriving with the input is simply not kept.
  const attributes = readEntries("attributes", source.attributes, out).filter(([key]) => !shape?.derivedAttrs.has(key));

  const fields: Entry<unknown>[] = shape ? shape.fields.map(([key, value]) => [key, value]) : [];
  for (const [key, value] of readEntries("fields", source.fields, out)) {
    const at = fields.findIndex(([name]) => name === key);
    if (at >= 0) fields[at] = [key, value];
    else out.push(violation("unknown_entry", "fields", key, value));
  }

  let hitPoints: SheetDraft["hitPoints"] = null;
  const hpRaw = source.hitPoints;
  if (shape?.hitPoints) {
    hitPoints = { current: null, max: null };
    if (isRecord(hpRaw)) {
      hitPoints = { current: hpRaw.current, max: hpRaw.max };
      for (const key of Object.keys(hpRaw)) {
        if (key !== "current" && key !== "max") out.push(violation("unknown_entry", "hitPoints", key, hpRaw[key]));
      }
    } else if (hpRaw !== undefined && hpRaw !== null) {
      out.push(violation("malformed", "hitPoints", null, hpRaw));
    }
  } else if (hpRaw !== undefined && hpRaw !== null) {
    out.push(violation("unknown_entry", "hitPoints", null, hpRaw));
  }

  let equipment: readonly JsonValue[] = [];
  if (Array.isArray(source.equipment) && isJson(source.equipment)) equipment = source.equipment;
  else if (source.equipment !== undefined && source.equipment !== null) out.push(violation("malformed", "equipment", null, source.equipment));

  let avatar: JsonObject | null = null;
  if (isRecord(source.avatar) && isJson(source.avatar)) avatar = source.avatar as JsonObject;
  else if (source.avatar !== undefined && source.avatar !== null) out.push(violation("malformed", "avatar", null, source.avatar));

  return {
    name: readText("name", source.name, out),
    system: readText("system", source.system, out),
    attributes,
    secondary: readEntries("secondary", source.secondary, out),
    skills: readEntries("skills", source.skills, out),
    fields,
    hitPoints,
    equipment,
    background: readText("background", source.background, out),
    notes: readText("notes", source.notes, out),
    avatar,
  };
}

const NOT_NUMERIC = {
  attributes: "attribute_not_numeric",
  secondary: "secondary_not_numeric",
  skills: "skill_not_numeric",
} as const;

function settleTable(section: "attributes" | "secondary" | "skills", entries: readonly Entry<unknown>[], out: SheetViolation[]): Table<number> {
  const table: Entry<number>[] = [];
  for (const [key, raw] of entries) {
    const value = coerceInt(raw);
    if (value === null) out.push(violation(NOT_NUMERIC[section], section, key, raw));
    else table.push(Object.freeze([key, value] as const));
  }
  return Object.freeze(table);
}

/**
 * Hit points as one deterministic update: both bounds at least 0, the current value
 * within [0, max]; with `allowRaiseMax`, a current value above the maximum raises it.
 */
export function boundHitPoints(current: number, max: number, allowRaiseMax: boolean): HitPoints {
  let top = Math.max(0, max);
  const now = Math.max(0, current);
  if (allowRaiseMax && now > top) top = now;
  return Object.freeze({ current: Math.min(top, now), max: top });
}

/** Coerce a draft's values to the sheet's types. Every value not kept is reported. */
export function settleDraft(spec: SheetSpec, draft: SheetDraft, out: SheetViolation[]): Sheet {
  const shape = spec.shape;
  const attributes = settleTable("attributes", draft.attributes, out);
  const secondary = settleTable("secondary", draft.secondary, out);
  const skills = settleTable("skills", draft.skills, out);
  const fields: Entry<FieldValue>[] = [];
  for (const [key, raw] of draft.fields) {
    const fallback = shape?.fields.find(([name]) => name === key)?.[1];
    if (fallback === undefined) continue;
    if (typeof fallback === "string") {
      if (typeof raw === "string") fields.push(Object.freeze([key, raw] as const));
      else {
        out.push(violation("field_not_text", "fields", key, raw, fallback));
        fields.push(Object.freeze([key, fallback] as const));
      }
    } else {
      const value = coerceInt(raw);
      if (value !== null) fields.push(Object.freeze([key, value] as const));
      else {
        out.push(violation("field_not_numeric", "fields", key, raw, fallback));
        fields.push(Object.freeze([key, fallback] as const));
      }
    }
  }

  let hitPoints: HitPoints | null = null;
  if (shape?.hitPoints && draft.hitPoints) {
    const read = (key: "current" | "max", raw: unknown): number | null => {
      if (raw === undefined || raw === null) return null;
      const value = coerceInt(raw);
      if (value === null) out.push(violation("hit_points_not_numeric", "hitPoints", key, raw));
      return value;
    };
    let current = read("current", draft.hitPoints.current);
    let max = read("max", draft.hitPoints.max);
    if (current === null && max === null) {
      current = shape.hitPoints.current;
      max = shape.hitPoints.max;
    }
    // A lone value stands for both: a sheet that says "12 HP" means 12 of 12.
    hitPoints = boundHitPoints(current ?? max ?? 0, max ?? current ?? 0, true);
  }

  return Object.freeze({
    name: draft.name,
    system: draft.system,
    attributes,
    secondary,
    skills,
    fields: Object.freeze(fields),
    hitPoints,
    equipment: draft.equipment,
    background: draft.background,
    notes: draft.notes,
    avatar: draft.avatar,
  });
}

export interface ParsedSheet {
  readonly sheet: Sheet;
  readonly violations: readonly SheetViolation[];
}

/**
 * Read a sheet from loose input — the `Sheet` JSON shape, where a stat table may also be
 * a plain object (`{"侦查": 60}`) — without applying creation constraints or recomputing
 * anything. Sections that are missing are empty (a sheet that lists two skills HAS two
 * skills); fields missing from the input keep the pack's defaults.
 */
export function parseSheet(spec: SheetSpec, input: unknown): ParsedSheet {
  const out: SheetViolation[] = [];
  const draft = readDraft(spec, input, out);
  const sheet = settleDraft(spec, draft, out);
  return { sheet, violations: Object.freeze(out) };
}
