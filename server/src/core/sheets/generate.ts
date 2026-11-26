/**
 * Rolling a new character from the pack's creation constraints.
 *
 * Every attribute whose constraint declares a creation `roll` is rolled, in the pack's
 * declaration order (that order is what makes a seeded or scripted generation
 * reproducible), on a fresh sheet; then the sheet is refreshed as at creation (current
 * pools set from their starts, derived slots seeded cleanly) and validated against the
 * pack's ranges, as every stat write path is.
 *
 * Randomness comes only from the injected `RandomSource`. The rolls are returned as the
 * dice engine's own results, so a caller can show them.
 */

import { type DiceExpression, parseDice, type Roll, rollExpression } from "../dice/index.ts";
import type { RandomSource } from "../random.ts";
import type { FormulaIssue } from "./formulas.ts";
import { newSheet, refreshSheet } from "./refresh.ts";
import type { Sheet, SheetViolation } from "./sheet.ts";
import type { SheetSpec } from "./spec.ts";
import { tableWith } from "./table.ts";
import { validateSheet } from "./validate.ts";

export interface GenerateOptions {
  /** The new character's name. */
  readonly name: string;
  /** The system written on the sheet (normally the pack id). */
  readonly system: string;
}

/** One creation roll: which attribute slot it set, and the dice engine's result. */
export interface AttributeRoll {
  /** The attribute storage key (`STR`). */
  readonly key: string;
  readonly roll: Roll;
}

export interface GeneratedCharacter {
  readonly sheet: Sheet;
  /** In the order they were rolled (the pack's declaration order). */
  readonly rolls: readonly AttributeRoll[];
  /** What validation corrected: a roll outside its declared range is clamped into it. */
  readonly violations: readonly SheetViolation[];
  /** Derived formulas that failed while refreshing or validating the new sheet. */
  readonly issues: readonly FormulaIssue[];
}

/**
 * The creation rolls of `spec`, parsed. A notation that does not parse throws the dice
 * engine's `DiceError`: that is a defect of the pack, and a pack compiled through the
 * rule-pack loader has had every creation roll parsed already.
 */
export function creationRolls(spec: SheetSpec): readonly { readonly key: string; readonly expression: DiceExpression }[] {
  const out: { key: string; expression: DiceExpression }[] = [];
  for (const [key, constraint] of spec.constraints.attributes) {
    if (constraint.roll !== null) out.push({ key, expression: parseDice(constraint.roll) });
  }
  return out;
}

/**
 * A new character of `spec`'s system with every creation roll made. A derived attribute
 * slot is never stored, so a roll declared on one is made (it consumes its dice, keeping
 * the roll order the pack declared) but not written; the rule-pack loader refuses such a
 * pack in the first place.
 */
export function generateCharacter(spec: SheetSpec, random: RandomSource, options: GenerateOptions): GeneratedCharacter {
  const fresh = newSheet(spec, options.name, options.system);
  const derived = spec.shape?.derivedAttrs;
  let attributes = fresh.sheet.attributes;
  const rolls: AttributeRoll[] = [];
  for (const { key, expression } of creationRolls(spec)) {
    const roll = rollExpression(expression, random);
    rolls.push(Object.freeze({ key, roll }));
    if (derived?.has(key) !== true) attributes = tableWith(attributes, key, roll.total);
  }
  // Creation: every current pool starts from its declared start, and a derived skill or
  // secondary slot is seeded from its derivation rather than kept as a trained value.
  const refreshed = refreshSheet(spec, Object.freeze({ ...fresh.sheet, attributes }), { initializeVitals: true, preserveTrained: false });
  const validated = validateSheet(spec, refreshed.sheet, { initializeVitals: true, creationMethod: "rolled" });
  return Object.freeze({
    sheet: validated.sheet,
    rolls: Object.freeze(rolls),
    violations: validated.violations,
    // Validation refreshes again and reports each failing formula once; the passes before
    // it evaluated the same formulas on the same sources.
    issues: validated.issues,
  });
}
