/**
 * `opposed`: two sides each roll the system's check; the subsystem's `settle` decides how
 * the two rolls are compared.
 *
 * - `outcome` (roll-under systems, CoC): each side is graded against its own value as the
 *   target; the better rank TIER wins, a tie in tier goes to the higher value, and equal
 *   values are a tie.
 * - `total` (meet-the-target systems, D&D 5e): each side's value is the modifier on its
 *   roll, as in an ordinary check; the higher total wins and equal totals are a tie ("the
 *   situation remains the same"). Neither side is graded: a contest has no DC, so there is
 *   no success or failure rank.
 *
 * Each side brings its own sheet (an NPC opposing a player character is a second sheet),
 * or a value the caller states for it, and may carry roll modifiers (advantage) that apply
 * to its own roll.
 */

import type { RandomSource } from "../random.ts";
import {
  type CheckOutcome,
  gradeCheck,
  type ModifierCounts,
  type Resolution,
  ResolutionError,
  type ResolutionErrorCode,
  type RolledCheck,
  rollCheck,
} from "../resolution/index.ts";
import type { RulePack } from "../rulepacks/types.ts";
import type { Sheet } from "../sheets/index.ts";
import { lookupStat, resolutionOf, subsystemOf } from "./common.ts";
import type { OpposedSettle } from "./spec.ts";

export interface OpposedSide {
  /** The side's skill as typed (any alias); also the label a caller shows. */
  readonly skill: string;
  /** The side's sheet; needed unless `value` is given. */
  readonly sheet?: Sheet | null;
  /** A value stated for this side instead of reading its sheet. */
  readonly value?: number | null;
  /** Roll modifiers for this side's roll (`advantage`), by the pack's declared names. */
  readonly modifiers?: ModifierCounts | null;
}

export interface OpposedRequest {
  readonly active: OpposedSide;
  readonly passive: OpposedSide;
  /** The room's house-rule ladder (outcome settling only); null or unknown = the default ladder. */
  readonly variant?: string | null;
}

export type Side = "active" | "passive";

export type OpposedRefusal =
  /** The side names a skill nothing knows, or has neither a sheet nor a value. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "unknown_skill"; readonly side: Side; readonly skill: string }
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "not_numeric"; readonly side: Side; readonly skill: string }
  /** A stated value that is not a safe integer. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "invalid_value"; readonly side: Side; readonly value: number }
  /** A roll modifier the pack does not declare, or a count that is not a safe integer. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "invalid_modifier"; readonly side: Side; readonly modifier: string }
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "roll_failed"; readonly errorCode: ResolutionErrorCode };

export interface OpposedSideResult {
  /** As the caller gave it. */
  readonly skill: string;
  /** The canonical name it resolved to; null when the value was stated. */
  readonly canonical: string | null;
  readonly value: number;
  readonly check: RolledCheck;
  /** The dice total plus, when settling by total, the value. */
  readonly total: number;
  /** The graded rank (outcome settling); null when settling by total, which grades nothing. */
  readonly outcome: CheckOutcome | null;
}

export interface OpposedResult {
  readonly ok: true;
  readonly subsystem: string;
  readonly settle: OpposedSettle;
  readonly active: OpposedSideResult;
  readonly passive: OpposedSideResult;
  readonly winner: Side | "tie";
  /** What decided it: the outcome tiers, the values (tiers were equal), the totals, or nothing (a tie). */
  readonly decidedBy: "tier" | "value" | "total" | null;
}

type Settled = { readonly canonical: string | null; readonly value: number; readonly modifiers: readonly (readonly [string, number])[] };

function settleSide(pack: RulePack, resolution: Resolution, id: string, side: Side, given: OpposedSide): { readonly ok: true; readonly side: Settled } | OpposedRefusal {
  // Modifiers are checked first, so a refused request consumes no dice.
  const modifiers = [...(given.modifiers ?? [])];
  for (const [name, count] of modifiers) {
    if (!resolution.modifiers.has(name) || !Number.isSafeInteger(count)) return { ok: false, subsystem: id, refusal: "invalid_modifier", side, modifier: name };
  }
  if (given.value !== undefined && given.value !== null) {
    if (!Number.isSafeInteger(given.value)) return { ok: false, subsystem: id, refusal: "invalid_value", side, value: given.value };
    return { ok: true, side: { canonical: null, value: given.value, modifiers } };
  }
  if (given.sheet === undefined || given.sheet === null) return { ok: false, subsystem: id, refusal: "unknown_skill", side, skill: given.skill };
  const found = lookupStat(pack.sheet, given.sheet, given.skill, true);
  if (found.ok) return { ok: true, side: { canonical: found.canonical, value: found.value, modifiers } };
  return { ok: false, subsystem: id, refusal: found.reason === "unknown" ? "unknown_skill" : "not_numeric", side, skill: given.skill };
}

export function runOpposedCheck(pack: RulePack, id: string, request: OpposedRequest, random: RandomSource): OpposedResult | OpposedRefusal {
  const spec = subsystemOf(pack, id, "opposed");
  const resolution = resolutionOf(pack, id);
  const active = settleSide(pack, resolution, id, "active", request.active);
  if (!active.ok) return active;
  const passive = settleSide(pack, resolution, id, "passive", request.passive);
  if (!passive.ok) return passive;

  const roll = (given: OpposedSide, side: Settled): OpposedSideResult => {
    const check = rollCheck(resolution, random, { modifiers: side.modifiers });
    if (spec.settle === "total") {
      return Object.freeze({ skill: given.skill, canonical: side.canonical, value: side.value, check, total: check.total + side.value, outcome: null });
    }
    const outcome = gradeCheck(resolution, check, { target: side.value, variant: request.variant ?? null });
    return Object.freeze({ skill: given.skill, canonical: side.canonical, value: side.value, check, total: check.total, outcome });
  };
  let first: OpposedSideResult;
  let second: OpposedSideResult;
  try {
    first = roll(request.active, active.side);
    second = roll(request.passive, passive.side);
  } catch (error) {
    if (error instanceof ResolutionError) return { ok: false, subsystem: id, refusal: "roll_failed", errorCode: error.code };
    throw error;
  }

  let winner: Side | "tie" = "tie";
  let decidedBy: OpposedResult["decidedBy"] = null;
  if (spec.settle === "total") {
    if (first.total !== second.total) {
      winner = first.total > second.total ? "active" : "passive";
      decidedBy = "total";
    }
  } else {
    const tierActive = (first.outcome as CheckOutcome).rank.tier;
    const tierPassive = (second.outcome as CheckOutcome).rank.tier;
    if (tierActive !== tierPassive) {
      winner = tierActive > tierPassive ? "active" : "passive";
      decidedBy = "tier";
    } else if (first.value !== second.value) {
      winner = first.value > second.value ? "active" : "passive";
      decidedBy = "value";
    }
  }
  return Object.freeze({ ok: true, subsystem: id, settle: spec.settle, active: first, passive: second, winner, decidedBy });
}
