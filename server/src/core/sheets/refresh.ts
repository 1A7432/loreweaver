/**
 * Bringing a sheet's stored slots in line with the pack after its source values changed,
 * and making a fresh sheet.
 */

import { attributeSlot, evaluateSheet } from "./evaluate.ts";
import { evaluateInteger, type FormulaIssue } from "./formulas.ts";
import type { Sheet } from "./sheet.ts";
import type { SheetSpec } from "./spec.ts";
import { type Entry, type Table, tableGet, tableWith, tableWithout } from "./table.ts";

export interface RefreshOptions {
  /** Creation: set every current pool from its declared start (default false: an edit
   * keeps current pools and only clamps them to their maxima, so editing a skill never
   * heals a wounded character). A pool that has no value yet is always initialised. */
  readonly initializeVitals?: boolean;
  /** Keep a stored derived-skill or derived-secondary value that differs from its
   * derivation, as a trained skill / manual override (default true). False at creation
   * seeds cleanly. */
  readonly preserveTrained?: boolean;
}

export interface Refreshed {
  readonly sheet: Sheet;
  readonly issues: readonly FormulaIssue[];
}

/**
 * The sheet with its derived slots settled:
 * - a derived skill or secondary slot is dropped when it equals its derivation (an
 *   untrained copy would turn into a false "trained" override the moment its source
 *   changed) or when `preserveTrained` is off; a differing value stays as an override;
 * - each vital is clamped into [0, max] (or initialised, see `RefreshOptions`).
 * A slot whose derivation failed is left as it is, and the failure is reported.
 */
export function refreshSheet(spec: SheetSpec, sheet: Sheet, options: RefreshOptions = {}): Refreshed {
  const shape = spec.shape;
  if (shape === null) return { sheet, issues: [] };
  const initialize = options.initializeVitals ?? false;
  const preserve = options.preserveTrained ?? true;
  const evaluation = evaluateSheet(spec, sheet);
  const issues: FormulaIssue[] = [...evaluation.issues];

  const settle = (table: Table<number>, slots: ReadonlyMap<string, string>): Table<number> => {
    let out = table;
    for (const [key, canonical] of slots) {
      const derived = evaluation.values.get(canonical);
      if (derived === undefined) continue;
      const stored = tableGet(out, key);
      if (stored === undefined) continue;
      if (preserve && stored !== derived) continue;
      out = tableWithout(out, key);
    }
    return out;
  };
  const skills = settle(sheet.skills, shape.derivedSkills);
  const secondary = settle(sheet.secondary, shape.derivedSecondary);

  let attributes = sheet.attributes;
  for (const vital of shape.vitals) {
    const maxRead = attributeSlot(spec, sheet, evaluation, vital.maxKey);
    // Without a known maximum there is nothing to clamp against; the pool is left alone
    // rather than squeezed to 0.
    if (maxRead.kind !== "value") continue;
    const max = maxRead.value;
    const current = tableGet(attributes, vital.key);
    let next: number | undefined = current;
    if (initialize || current === undefined) {
      if (vital.start.kind === "full") {
        next = max;
      } else {
        const start = evaluateInteger("vital", vital.key, vital.start.expr, evaluation.lookup);
        if (start.ok) next = start.value;
        else issues.push(start.issue);
      }
    }
    if (next === undefined) continue;
    attributes = tableWith(attributes, vital.key, Math.max(0, Math.min(max, next)));
  }

  const changed = skills !== sheet.skills || secondary !== sheet.secondary || attributes !== sheet.attributes;
  return { sheet: changed ? Object.freeze({ ...sheet, skills, secondary, attributes }) : sheet, issues };
}

function copyTable<V>(table: Table<V>): Table<V> {
  return Object.freeze(table.map((entry): Entry<V> => Object.freeze([entry[0], entry[1]] as const)));
}

/**
 * A fresh sheet of `spec`'s system: the pack's starting tables and fields, current pools
 * initialised from their starts. A pack without a sheet shape gives empty tables.
 * (Rolling attributes for a new character needs the dice engine and is not done here.)
 */
export function newSheet(spec: SheetSpec, name: string, system: string): Refreshed {
  const shape = spec.shape;
  const blank: Sheet = Object.freeze({
    name,
    system,
    attributes: shape ? copyTable(shape.attributes) : [],
    secondary: shape ? copyTable(shape.secondary) : [],
    skills: shape ? copyTable(shape.skills) : [],
    fields: shape ? copyTable(shape.fields) : [],
    hitPoints: shape?.hitPoints ? Object.freeze({ ...shape.hitPoints }) : null,
    equipment: [],
    background: "",
    notes: "",
    avatar: null,
  });
  return refreshSheet(spec, blank, { initializeVitals: true, preserveTrained: false });
}
