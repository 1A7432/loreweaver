/**
 * `improvement_check`: the experience roll. A skill below the pack's cap is rolled
 * against; a roll above its value (or above `auto_success_above`, when the pack sets one)
 * grows it by the growth roll, up to the cap.
 *
 * The skill is found through the sheet layer, like any stat: the typed name resolves
 * through the pack's aliases, is read from its declared storage slot (so `信用评级` reads
 * the `信用` skill), a derived skill reads its derivation, and the grown value is written
 * back to that same slot. A name nothing knows is refused, never grown from 0.
 */

import type { Roll } from "../dice/index.ts";
import { rollExpression } from "../dice/index.ts";
import type { RandomSource } from "../random.ts";
import type { RulePack } from "../rulepacks/types.ts";
import type { Sheet, WriteRefusal } from "../sheets/index.ts";
import { lookupStat, subsystemOf, writeStat } from "./common.ts";

export interface ImprovementRequest {
  readonly sheet: Sheet;
  /** The skill as typed (any alias). */
  readonly skill: string;
}

export type ImprovementRefusal =
  /** No alias names it and the sheet holds nothing under it (an empty name included). */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "unknown_skill"; readonly skill: string }
  /** It reads as text (a meta field) or its formula failed. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "not_numeric"; readonly skill: string }
  /** Already at or above the cap: nothing is rolled. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "at_cap"; readonly skill: string; readonly value: number; readonly cap: number };

export interface ImprovementResult {
  readonly ok: true;
  readonly subsystem: string;
  /** The canonical name the skill resolved to. */
  readonly skill: string;
  readonly before: number;
  /** The improvement roll. */
  readonly roll: Roll;
  readonly grew: boolean;
  /** The growth roll; null when the skill did not grow. */
  readonly growthRoll: Roll | null;
  /** The value after growth (equal to `before` without it), capped. */
  readonly after: number;
  readonly sheet: Sheet;
  readonly writeRefused: WriteRefusal | null;
}

export function runImprovementCheck(pack: RulePack, id: string, request: ImprovementRequest, random: RandomSource): ImprovementResult | ImprovementRefusal {
  const spec = subsystemOf(pack, id, "improvement_check");
  const found = lookupStat(pack.sheet, request.sheet, request.skill, false);
  if (!found.ok) {
    return { ok: false, subsystem: id, refusal: found.reason === "unknown" ? "unknown_skill" : "not_numeric", skill: request.skill };
  }
  const { canonical, value } = found;
  if (value >= spec.cap) return { ok: false, subsystem: id, refusal: "at_cap", skill: canonical, value, cap: spec.cap };

  const roll = rollExpression(spec.roll, random);
  const grew = roll.total > value || (spec.autoSuccessAbove !== null && roll.total > spec.autoSuccessAbove);
  if (!grew) {
    return Object.freeze({ ok: true, subsystem: id, skill: canonical, before: value, roll, grew, growthRoll: null, after: value, sheet: request.sheet, writeRefused: null });
  }
  const growthRoll = rollExpression(spec.improve, random);
  const after = Math.min(spec.cap, value + growthRoll.total);
  const written = writeStat(pack.sheet, request.sheet, canonical, after);
  return Object.freeze({ ok: true, subsystem: id, skill: canonical, before: value, roll, grew, growthRoll, after, sheet: written.sheet, writeRefused: written.refused });
}
