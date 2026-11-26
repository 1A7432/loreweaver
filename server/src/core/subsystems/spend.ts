/**
 * `resource_spend_adjust`: spend points of an attribute (Luck) to lower an already
 * recorded check's roll by as many points, re-graded through the pack's ladder with the
 * check's own target, variant and difficulty. Nothing is rolled: the spend is arithmetic
 * over a recorded roll, so it is replayable.
 *
 * Which check is "the most recent one" is the caller's (it keeps the session record); this
 * flow is handed that check. Eligibility is pack data, not engine vocabulary: a spend may
 * not adjust a check on its own resource or on the stat of any `check_with_loss`
 * subsystem of the pack (the Luck and Sanity checks in CoC), in any spelling the pack's
 * aliases know.
 */

import { type CheckOutcome, gradeCheck, type LuckSpend, ResolutionError, type ResolutionErrorCode, spendLuck } from "../resolution/index.ts";
import type { RulePack } from "../rulepacks/types.ts";
import { resolveName, type Sheet, type SheetSpec, type WriteRefusal } from "../sheets/index.ts";
import { normalizeAlias } from "../sheets/text.ts";
import { readAttribute, resolutionOf, subsystemOf, writeAttribute } from "./common.ts";

/** The recorded check a spend adjusts, as the caller's session record holds it. */
export interface RecordedCheck {
  /** The stat the check was on, as recorded (a canonical name, an alias or a storage key). */
  readonly skill: string;
  readonly target: number;
  /** The check's current roll (already lowered, if points were spent on it before). */
  readonly roll: number;
  readonly variant?: string | null;
  readonly difficulty?: string | null;
  /** Points spent on this check before; default 0. */
  readonly spent?: number;
  /** The roll before any spend, when the record keeps it. */
  readonly rawRoll?: number | null;
}

export interface SpendRequest {
  readonly sheet: Sheet;
  /** Points to spend: a positive integer. */
  readonly points: number;
  /** The check to adjust; null when the caller has none. */
  readonly check: RecordedCheck | null;
}

type Refused<R extends string, Facts = object> = { readonly ok: false; readonly subsystem: string; readonly refusal: R } & Facts;

export type SpendRefusal =
  | Refused<"invalid_points", { readonly points: number }>
  | Refused<"stat_unset", { readonly stat: string }>
  | Refused<"insufficient", { readonly points: number; readonly available: number }>
  | Refused<"no_check">
  | Refused<"ineligible", { readonly skill: string }>
  /** A fumble cannot be bought off. */
  | Refused<"fumble", { readonly roll: number }>
  /** The spend would take the roll below 1; `maxPoints` is the most that can be spent. */
  | Refused<"exceeds_roll", { readonly points: number; readonly roll: number; readonly maxPoints: number }>
  /** Re-grading failed (`errorCode` is the resolution layer's). */
  | Refused<"roll_failed", { readonly errorCode: ResolutionErrorCode }>;

export interface SpendResult {
  readonly ok: true;
  readonly subsystem: string;
  readonly stat: string;
  readonly points: number;
  readonly statBefore: number;
  readonly statAfter: number;
  /** Rolls and ranks before and after. */
  readonly spend: LuckSpend;
  /** The adjusted check, graded again (margin, effective target). */
  readonly outcome: CheckOutcome;
  /** What the caller writes back into its record of the check. */
  readonly check: { readonly roll: number; readonly rawRoll: number; readonly spent: number };
  readonly sheet: Sheet;
  readonly writeRefused: WriteRefusal | null;
}

/** The canonical name of an attribute storage key (`LUC` → `幸运`), if the pack maps one. */
function canonicalOfSlot(spec: SheetSpec, key: string): string | null {
  for (const [canonical, slot] of spec.shape?.attrKeys ?? []) if (slot === key) return canonical;
  return resolveName(spec, key);
}

/** Whether `skill` names one of the pack's protected stats: this resource or any loss-check stat. */
function ineligible(pack: RulePack, resource: string, skill: string): boolean {
  const slots = new Set([resource]);
  for (const spec of pack.subsystems.values()) if (spec.template === "check_with_loss") slots.add(spec.stat);
  const typed = normalizeAlias(skill);
  const canonical = resolveName(pack.sheet, skill);
  for (const slot of slots) {
    if (typed === normalizeAlias(slot)) return true;
    const protectedName = canonicalOfSlot(pack.sheet, slot);
    if (protectedName !== null && (canonical === protectedName || typed === normalizeAlias(protectedName))) return true;
  }
  return false;
}

export function runResourceSpend(pack: RulePack, id: string, request: SpendRequest): SpendResult | SpendRefusal {
  const spec = subsystemOf(pack, id, "resource_spend_adjust");
  const resolution = resolutionOf(pack, id);
  const refused = { ok: false as const, subsystem: id };
  const { points, check } = request;

  if (!Number.isSafeInteger(points) || points <= 0) return { ...refused, refusal: "invalid_points", points };
  const available = readAttribute(pack.sheet, request.sheet, spec.stat);
  if (available === null) return { ...refused, refusal: "stat_unset", stat: spec.stat };
  if (points > available) return { ...refused, refusal: "insufficient", points, available };
  if (check === null) return { ...refused, refusal: "no_check" };
  if (ineligible(pack, spec.stat, check.skill)) return { ...refused, refusal: "ineligible", skill: check.skill };

  const options = { target: check.target, variant: check.variant ?? null, difficulty: check.difficulty ?? null };
  // A recorded roll is graded as a roll of the system's die showing that value.
  const grade = (roll: number) => gradeCheck(resolution, { total: roll, dice: [roll] }, options);
  let spend: LuckSpend;
  let outcome: CheckOutcome;
  try {
    spend = spendLuck({ roll: check.roll, points, alreadySpent: check.spent ?? 0, grade: (roll) => grade(roll).rank });
    outcome = grade(spend.afterRoll);
  } catch (error) {
    if (!(error instanceof ResolutionError)) throw error;
    if (error.code === "LUCK_FUMBLE") return { ...refused, refusal: "fumble", roll: check.roll };
    if (error.code === "LUCK_EXCEEDS_ROLL") return { ...refused, refusal: "exceeds_roll", points, roll: check.roll, maxPoints: Math.max(0, check.roll - 1) };
    return { ...refused, refusal: "roll_failed", errorCode: error.code };
  }

  const statAfter = available - points;
  const written = writeAttribute(pack.sheet, request.sheet, spec.stat, statAfter);
  return Object.freeze({
    ok: true,
    subsystem: id,
    stat: spec.stat,
    points,
    statBefore: available,
    statAfter,
    spend,
    outcome,
    check: Object.freeze({ roll: spend.afterRoll, rawRoll: check.rawRoll ?? check.roll, spent: spend.totalSpent }),
    sheet: written.sheet,
    writeRefused: written.refused,
  });
}
