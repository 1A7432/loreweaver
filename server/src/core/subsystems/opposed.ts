/**
 * `opposed`: two sides each roll the system's check against their own value; the better
 * outcome TIER wins, a tie in tier goes to the higher value, and equal values are a tie.
 *
 * Each side brings its own sheet (an NPC opposing a player character is a second sheet),
 * or a value the caller states for it. A side's value is the TARGET its check is graded
 * against, whatever the pack's target kind: that is the template as the reference engine
 * ran it, including for a `dc` system, where it grades "skill value as DC".
 */

import type { RandomSource } from "../random.ts";
import type { CheckOutcome, ResolutionErrorCode, RolledCheck } from "../resolution/index.ts";
import type { RulePack } from "../rulepacks/types.ts";
import type { Sheet } from "../sheets/index.ts";
import { lookupStat, resolutionOf, rollAndGrade, subsystemOf } from "./common.ts";

export interface OpposedSide {
  /** The side's skill as typed (any alias); also the label a caller shows. */
  readonly skill: string;
  /** The side's sheet; needed unless `value` is given. */
  readonly sheet?: Sheet | null;
  /** A value stated for this side instead of reading its sheet. */
  readonly value?: number | null;
}

export interface OpposedRequest {
  readonly active: OpposedSide;
  readonly passive: OpposedSide;
  /** The room's house-rule ladder; null or unknown = the default ladder. */
  readonly variant?: string | null;
}

export type Side = "active" | "passive";

export type OpposedRefusal =
  /** The side names a skill nothing knows, or has neither a sheet nor a value. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "unknown_skill"; readonly side: Side; readonly skill: string }
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "not_numeric"; readonly side: Side; readonly skill: string }
  /** A stated value that is not a safe integer. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "invalid_value"; readonly side: Side; readonly value: number }
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "roll_failed"; readonly errorCode: ResolutionErrorCode };

export interface OpposedSideResult {
  /** As the caller gave it. */
  readonly skill: string;
  /** The canonical name it resolved to; null when the value was stated. */
  readonly canonical: string | null;
  readonly value: number;
  readonly check: RolledCheck;
  readonly outcome: CheckOutcome;
}

export interface OpposedResult {
  readonly ok: true;
  readonly subsystem: string;
  readonly active: OpposedSideResult;
  readonly passive: OpposedSideResult;
  readonly winner: Side | "tie";
  /** What decided it: the outcome tiers, the values (tiers were equal), or nothing (a tie). */
  readonly decidedBy: "tier" | "value" | null;
}

type SideValue = { readonly ok: true; readonly canonical: string | null; readonly value: number } | OpposedRefusal;

function sideValue(pack: RulePack, id: string, side: Side, given: OpposedSide): SideValue {
  if (given.value !== undefined && given.value !== null) {
    if (!Number.isSafeInteger(given.value)) return { ok: false, subsystem: id, refusal: "invalid_value", side, value: given.value };
    return { ok: true, canonical: null, value: given.value };
  }
  if (given.sheet === undefined || given.sheet === null) return { ok: false, subsystem: id, refusal: "unknown_skill", side, skill: given.skill };
  const found = lookupStat(pack.sheet, given.sheet, given.skill, true);
  if (found.ok) return { ok: true, canonical: found.canonical, value: found.value };
  return { ok: false, subsystem: id, refusal: found.reason === "unknown" ? "unknown_skill" : "not_numeric", side, skill: given.skill };
}

export function runOpposedCheck(pack: RulePack, id: string, request: OpposedRequest, random: RandomSource): OpposedResult | OpposedRefusal {
  subsystemOf(pack, id, "opposed");
  const resolution = resolutionOf(pack, id);
  // Both values are settled before any die is rolled: a refused request consumes none.
  const active = sideValue(pack, id, "active", request.active);
  if (!active.ok) return active;
  const passive = sideValue(pack, id, "passive", request.passive);
  if (!passive.ok) return passive;

  const first = rollAndGrade(resolution, random, active.value, request.variant);
  if (!first.ok) return { ok: false, subsystem: id, refusal: "roll_failed", errorCode: first.errorCode };
  const second = rollAndGrade(resolution, random, passive.value, request.variant);
  if (!second.ok) return { ok: false, subsystem: id, refusal: "roll_failed", errorCode: second.errorCode };

  const tierActive = first.roll.outcome.rank.tier;
  const tierPassive = second.roll.outcome.rank.tier;
  let winner: Side | "tie";
  let decidedBy: "tier" | "value" | null;
  if (tierActive !== tierPassive) {
    winner = tierActive > tierPassive ? "active" : "passive";
    decidedBy = "tier";
  } else if (active.value !== passive.value) {
    winner = active.value > passive.value ? "active" : "passive";
    decidedBy = "value";
  } else {
    winner = "tie";
    decidedBy = null;
  }
  const result = (given: OpposedSide, value: { canonical: string | null; value: number }, graded: typeof first.roll): OpposedSideResult =>
    Object.freeze({ skill: given.skill, canonical: value.canonical, value: value.value, check: graded.check, outcome: graded.outcome });
  return Object.freeze({
    ok: true,
    subsystem: id,
    active: result(request.active, active, first.roll),
    passive: result(request.passive, passive, second.roll),
    winner,
    decidedBy,
  });
}
