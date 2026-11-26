/**
 * Reading and writing one stat by name, hit points, and the name/label lookups.
 */

import { attributeSlot, evaluateSheet, HP_NAME, HPMAX_NAME, issueFor, type SheetEvaluation } from "./evaluate.ts";
import type { FormulaIssue } from "./formulas.ts";
import { refreshSheet } from "./refresh.ts";
import { boundHitPoints, type HitPoints, type Sheet } from "./sheet.ts";
import type { FieldValue, SheetSpec } from "./spec.ts";
import { tableGet, tableHas, tableWith } from "./table.ts";
import { normalizeAlias, normalizeLocale, pickLabel } from "./text.ts";

/** The canonical name a typed stat name stands for, by the pack's alias table, or null. */
export function resolveName(spec: SheetSpec, name: string): string | null {
  return spec.aliases.get(normalizeAlias(name)) ?? null;
}

/**
 * A canonical name's display label for `locale` (its full tag, then its base language),
 * else the name itself. Deliberately no `en` fallback: canonical names are already names
 * in the pack's own language, and a pack lists only the ones that read differently
 * (coc7's `zh` table holds two entries because `乔装` already IS the Chinese label), so an
 * `en` fallback would show a Chinese table English names.
 */
export function displayName(spec: SheetSpec, name: string, locale: string | null | undefined): string {
  const tag = typeof locale === "string" ? normalizeLocale(locale) : "";
  if (tag === "") return name;
  for (const candidate of new Set([tag, tag.split("-", 1)[0] ?? tag])) {
    const label = spec.displayNames.get(candidate)?.get(name);
    if (label !== undefined) return label;
  }
  return name;
}

export type StatRead =
  | { readonly kind: "value"; readonly value: number; readonly from: "sheet" | "derived" | "default" }
  /** A text field (`occupation`) or a text derived value (`DB` = `"1d4"`). */
  | { readonly kind: "text"; readonly text: string; readonly from: "sheet" | "derived" }
  | { readonly kind: "failed"; readonly issue: FormulaIssue }
  /** Nothing on the sheet, no derivation, no pack default. */
  | { readonly kind: "unset" };

function readIn(spec: SheetSpec, evaluation: SheetEvaluation, name: string): StatRead {
  const own = evaluation.source.get(name);
  if (own !== undefined) return typeof own === "number" ? { kind: "value", value: own, from: "sheet" } : { kind: "text", text: own, from: "sheet" };
  const derived = evaluation.values.get(name);
  if (derived !== undefined) {
    return typeof derived === "number" ? { kind: "value", value: derived, from: "derived" } : { kind: "text", text: derived, from: "derived" };
  }
  const issue = issueFor(evaluation, name);
  if (issue !== undefined) return { kind: "failed", issue };
  const fallback = spec.defaults.get(name);
  return fallback === undefined ? { kind: "unset" } : { kind: "value", value: fallback, from: "default" };
}

/**
 * The current value of the canonical stat `name` on `sheet`: its stored value, else its
 * derivation (always recomputed, never read from storage), else the pack default.
 */
export function sheetValue(spec: SheetSpec, sheet: Sheet, name: string, evaluation?: SheetEvaluation): StatRead {
  return readIn(spec, evaluation ?? evaluateSheet(spec, sheet), name);
}

/**
 * The value a CHECK on `name` rolls against: usually the stat itself; the pack's
 * `check_values` bridge redirects names whose check reads another stat (an ability
 * check rolling its modifier).
 */
export function checkValue(spec: SheetSpec, sheet: Sheet, name: string, evaluation?: SheetEvaluation): StatRead {
  return sheetValue(spec, sheet, spec.shape?.checkValues.get(name) ?? name, evaluation);
}

/**
 * Whether `name` (as typed) names something a check can roll on: a stat the pack's alias
 * table knows, or an entry this sheet itself stores (a custom skill). Anything else is an
 * unknown name, and a check on it should be refused rather than rolled against 0.
 */
export function hasCheckValue(spec: SheetSpec, sheet: Sheet, name: string): boolean {
  if (resolveName(spec, name) !== null) return true;
  if (tableHas(sheet.skills, name) || tableHas(sheet.attributes, name)) return true;
  const shape = spec.shape;
  if (shape === null) return false;
  // A derived attribute slot is never stored but always present: it derives.
  if (shape.derivedAttrs.has(name)) return true;
  // Secondary values (speed, carrying capacity) are not check targets.
  const attr = shape.attrKeys.get(name);
  const skill = shape.skillKeys.get(name);
  return (
    (attr !== undefined && (tableHas(sheet.attributes, attr) || shape.derivedAttrs.has(attr))) ||
    (skill !== undefined && tableHas(sheet.skills, skill))
  );
}

// ---------------------------------------------------------------------------
// Hit points
// ---------------------------------------------------------------------------

/** Where a pack without field hit points keeps them: these two attribute slots. */
export const HP_ATTRIBUTE = "HP";
export const HPMAX_ATTRIBUTE = "HPMAX";

export type HitPointsRead = ({ readonly ok: true } & HitPoints) | { readonly ok: false; readonly issue: FormulaIssue };

/**
 * Authoritative `(current, max)` hit points. Field-based packs read the sheet's hit
 * points; others read the `HP` / `HPMAX` attribute slots (either may be a vital or a
 * derivation). A lone value stands for both; none is 0 of 0; the current value is
 * reported clamped into [0, max].
 */
export function getHitPoints(spec: SheetSpec, sheet: Sheet, evaluation?: SheetEvaluation): HitPointsRead {
  if (spec.shape?.hitPoints) {
    const hp = sheet.hitPoints ?? { current: 0, max: 0 };
    return { ok: true, ...boundHitPoints(hp.current, hp.max, false) };
  }
  const ev = evaluation ?? evaluateSheet(spec, sheet);
  const current = attributeSlot(spec, sheet, ev, HP_ATTRIBUTE);
  const max = attributeSlot(spec, sheet, ev, HPMAX_ATTRIBUTE);
  if (current.kind === "failed") return { ok: false, issue: current.issue };
  if (max.kind === "failed") return { ok: false, issue: max.issue };
  if (current.kind === "missing" && max.kind === "missing") return { ok: true, current: 0, max: 0 };
  const top = max.kind === "value" ? max.value : Math.max(0, current.kind === "value" ? current.value : 0);
  const now = current.kind === "value" ? current.value : top;
  return { ok: true, ...boundHitPoints(now, top, false) };
}

export interface HitPointsUpdate {
  /** Set the current value (before `delta`). */
  readonly current?: number;
  readonly maximum?: number;
  /** Added to the current value (damage is negative). */
  readonly delta?: number;
  /** Let a current value above the maximum raise the maximum (default false: clamp). */
  readonly allowRaiseMax?: boolean;
}

export type WriteRefusal =
  /** The slot is a pure derivation; it changes only through its sources. */
  | "derived_slot"
  /** The maximum hit points are derived and this update would change them. */
  | "maximum_is_derived"
  /** A stat slot takes an integer. */
  | "not_integer"
  /** A text field takes text. */
  | "not_text"
  /** A derivation this write depends on failed (see `issue`). */
  | "formula_failed";

export type HitPointsWrite =
  | ({ readonly ok: true; readonly sheet: Sheet } & HitPoints)
  | { readonly ok: false; readonly code: WriteRefusal; readonly issue?: FormulaIssue };

function requireInt(what: string, value: number | undefined): void {
  if (value !== undefined && !Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer, got ${value}`);
}

/**
 * Apply one hit-point update: the maximum (at least 0) and current value (at least 0)
 * are set, `delta` is added, a current value above the maximum raises it only with
 * `allowRaiseMax`, and the current value ends within [0, max].
 * Throws `RangeError` for a non-integer argument (a caller bug, not content).
 */
export function setHitPoints(spec: SheetSpec, sheet: Sheet, update: HitPointsUpdate): HitPointsWrite {
  requireInt("current", update.current);
  requireInt("maximum", update.maximum);
  requireInt("delta", update.delta);
  const evaluation = evaluateSheet(spec, sheet);
  const before = getHitPoints(spec, sheet, evaluation);
  if (!before.ok) return { ok: false, code: "formula_failed", issue: before.issue };
  const max = update.maximum === undefined ? before.max : Math.max(0, update.maximum);
  let current = update.current === undefined ? before.current : Math.max(0, update.current);
  if (update.delta !== undefined) current += update.delta;
  if (!Number.isSafeInteger(current)) throw new RangeError("hit points left the exact integer range");
  const after = boundHitPoints(current, max, update.allowRaiseMax ?? false);

  if (spec.shape?.hitPoints) return { ok: true, sheet: Object.freeze({ ...sheet, hitPoints: after }), ...after };
  let attributes = tableWith(sheet.attributes, HP_ATTRIBUTE, after.current);
  if (spec.shape?.derivedAttrs.has(HPMAX_ATTRIBUTE)) {
    if (after.max !== before.max) return { ok: false, code: "maximum_is_derived" };
  } else {
    attributes = tableWith(attributes, HPMAX_ATTRIBUTE, after.max);
  }
  return { ok: true, sheet: Object.freeze({ ...sheet, attributes }), ...after };
}

// ---------------------------------------------------------------------------
// Writing one stat
// ---------------------------------------------------------------------------

export type ValueWrite =
  | { readonly ok: true; readonly sheet: Sheet; readonly issues: readonly FormulaIssue[] }
  | { readonly ok: false; readonly code: WriteRefusal; readonly issue?: FormulaIssue };

/**
 * Write the canonical stat `name` into its declared storage slot: an attribute slot (then
 * the sheet is refreshed, so derived slots and vital clamps follow), field hit points, a
 * secondary slot, a meta field (refreshed too), or else a skill (through the pack's skill
 * storage key, so a custom skill is simply added). No range is applied: creation ranges
 * are `validateSheet`'s job. `name` must already be canonical (see `resolveName`).
 */
export function setSheetValue(spec: SheetSpec, sheet: Sheet, name: string, value: FieldValue): ValueWrite {
  const shape = spec.shape;
  const field = shape?.fieldKeys.get(name);
  if (shape !== null && field !== undefined) {
    const fallback = tableGet(shape.fields, field);
    if (typeof fallback === "string" && typeof value !== "string") return { ok: false, code: "not_text" };
    if (typeof fallback !== "string" && !Number.isSafeInteger(value)) return { ok: false, code: "not_integer" };
    return refreshed(spec, { ...sheet, fields: tableWith(sheet.fields, field, value) });
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return { ok: false, code: "not_integer" };
  if (shape === null) return { ok: true, sheet: Object.freeze({ ...sheet, skills: tableWith(sheet.skills, name, value) }), issues: [] };

  const attr = shape.attrKeys.get(name);
  if (attr !== undefined) {
    if (shape.derivedAttrs.has(attr)) return { ok: false, code: "derived_slot" };
    return refreshed(spec, { ...sheet, attributes: tableWith(sheet.attributes, attr, value) });
  }
  if (shape.hitPoints !== null && (name === HP_NAME || name === HPMAX_NAME)) {
    const write = setHitPoints(spec, sheet, name === HP_NAME ? { current: value, allowRaiseMax: true } : { maximum: value });
    return write.ok ? { ok: true, sheet: write.sheet, issues: [] } : write;
  }
  const secondary = shape.secondaryKeys.get(name);
  if (secondary !== undefined) {
    return { ok: true, sheet: Object.freeze({ ...sheet, secondary: tableWith(sheet.secondary, secondary, value) }), issues: [] };
  }
  const skill = shape.skillKeys.get(name) ?? name;
  return { ok: true, sheet: Object.freeze({ ...sheet, skills: tableWith(sheet.skills, skill, value) }), issues: [] };
}

function refreshed(spec: SheetSpec, sheet: Sheet): ValueWrite {
  const result = refreshSheet(spec, Object.freeze(sheet));
  return { ok: true, sheet: result.sheet, issues: result.issues };
}

/** `resource id → label` for `locale` (an empty map for a pack without resources). */
export function resourceLabels(spec: SheetSpec, locale: string | null | undefined): ReadonlyMap<string, string> {
  return new Map((spec.shape?.resources ?? []).map((resource) => [resource.id, pickLabel(resource.labels, locale, resource.id)]));
}
