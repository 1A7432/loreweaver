/**
 * Reading a sheet in the pack's canonical names, and the derived values computed from it.
 *
 * Derived values are never stored: each read evaluates them from the sheet's source
 * values, so a changed attribute shows in every value derived from it at once.
 */

import { type DerivedValue, type FormulaIssue, foldDerived, type Lookup } from "./formulas.ts";
import type { Sheet } from "./sheet.ts";
import type { SheetSpec } from "./spec.ts";
import { type Table, tableGet, tableMap } from "./table.ts";

/** The canonical names of field-based hit points (current, maximum). */
export const HP_NAME = "hp";
export const HPMAX_NAME = "hpmax";

/**
 * The sheet's SOURCE values under the pack's canonical names. Where several slots claim
 * one canonical name, the more specific one wins, lowest first: an undeclared skill
 * named like it, the declared skill slot, the declared secondary slot, an undeclared
 * attribute named like it, the declared attribute slot, field hit points, the declared
 * meta field. (A stray `体质` attribute next to the declared `CON` slot therefore never
 * changes what `体质` reads.) Derived attribute slots are not stored, so not read.
 * A pack without a sheet shape reads its attributes, then its skills, by their own names.
 */
export function canonicalValues(spec: SheetSpec, sheet: Sheet): Map<string, DerivedValue> {
  const values = new Map<string, DerivedValue>();
  const shape = spec.shape;
  if (shape === null) {
    for (const [key, value] of sheet.attributes) values.set(key, value);
    for (const [key, value] of sheet.skills) values.set(key, value);
    return values;
  }
  const declared = (table: Table<number>, keys: ReadonlyMap<string, string>, undeclared: boolean): void => {
    const stored = tableMap(table);
    if (undeclared) {
      const claimed = new Set(keys.values());
      for (const [key, value] of table) if (!claimed.has(key)) values.set(key, value);
    }
    for (const [canonical, key] of keys) {
      const value = stored.get(key);
      if (value !== undefined) values.set(canonical, value);
    }
  };
  declared(sheet.skills, shape.skillKeys, true);
  declared(sheet.secondary, shape.secondaryKeys, false);
  declared(sheet.attributes, shape.attrKeys, true);
  if (shape.hitPoints !== null && sheet.hitPoints !== null) {
    values.set(HP_NAME, sheet.hitPoints.current);
    values.set(HPMAX_NAME, sheet.hitPoints.max);
  }
  for (const [canonical, field] of shape.fieldKeys) {
    const value = tableGet(sheet.fields, field);
    if (value !== undefined) values.set(canonical, value);
  }
  return values;
}

export interface DerivedValues {
  /** Every derived name that evaluated, in the pack's declaration order. */
  readonly values: ReadonlyMap<string, DerivedValue>;
  readonly failed: ReadonlySet<string>;
  readonly issues: readonly FormulaIssue[];
}

/**
 * The pack's derived values for a set of canonical source values (often partial: a
 * missing name reads as the pack default, then 0).
 */
export function computeDerived(spec: SheetSpec, values: ReadonlyMap<string, DerivedValue>): DerivedValues {
  const fold = foldDerived(spec.derived, values, spec.defaults);
  return { values: fold.values, failed: fold.failed, issues: fold.issues };
}

export interface SheetEvaluation extends DerivedValues {
  readonly source: ReadonlyMap<string, DerivedValue>;
  /** The effective namespace: the sheet's value, else the derived one, else the pack
   * default, else 0; `FAILED` for a name only a failed formula supplies. */
  readonly lookup: Lookup;
}

export function evaluateSheet(spec: SheetSpec, sheet: Sheet): SheetEvaluation {
  const source = canonicalValues(spec, sheet);
  const fold = foldDerived(spec.derived, source, spec.defaults);
  return { source, values: fold.values, failed: fold.failed, issues: fold.issues, lookup: fold.lookup };
}

/** The issue explaining why `name`'s derived value is missing. */
export function issueFor(evaluation: DerivedValues, name: string): FormulaIssue | undefined {
  return evaluation.issues.find((issue) => issue.name === name);
}

export type AttributeRead =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly issue: FormulaIssue };

/**
 * One attribute SLOT by storage key: a derived slot evaluates (a text result counts as
 * missing — a meter cannot draw "1d4"), any other slot reads storage.
 */
export function attributeSlot(spec: SheetSpec, sheet: Sheet, evaluation: SheetEvaluation, key: string): AttributeRead {
  const canonical = spec.shape?.derivedAttrs.get(key);
  if (canonical === undefined) {
    const value = tableGet(sheet.attributes, key);
    return value === undefined ? { kind: "missing" } : { kind: "value", value };
  }
  const value = evaluation.values.get(canonical);
  if (typeof value === "number") return { kind: "value", value };
  const issue = issueFor(evaluation, canonical);
  return issue ? { kind: "failed", issue } : { kind: "missing" };
}
