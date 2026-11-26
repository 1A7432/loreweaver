/**
 * `check_with_loss`: roll the system's check against an attribute (the room's house-rule
 * variant, no difficulty), then roll the loss dice the caller gave for that outcome and
 * deduct them from the attribute.
 *
 * Order of the arithmetic, as the format sets it: the rolled loss (never below 0); on a
 * fumble the pack's `fumble_loss` rule (`all`: the whole current value; `max`: the loss
 * notation's maximum); then the pack's `loss_ceiling`, last, so even a fumble rule stays
 * subject to it. The attribute ends at `max(0, value - loss)`.
 */

import { ABSENT, ExprError, type Resolver } from "../condexpr.ts";
import { DiceError, type DiceErrorCode, type DiceExpression, type Expr, parseDice, type Roll, rollExpression } from "../dice/index.ts";
import type { RandomSource } from "../random.ts";
import type { CheckOutcome, ResolutionErrorCode, RolledCheck } from "../resolution/index.ts";
import type { RulePack } from "../rulepacks/types.ts";
import { evaluateSheet, type Sheet, type SheetSpec, type WriteRefusal } from "../sheets/index.ts";
import { readAttribute, resolutionOf, rollAndGrade, subsystemOf, writeAttribute } from "./common.ts";
import type { LossCeiling } from "./spec.ts";

export interface LossCheckRequest {
  readonly sheet: Sheet;
  /** Loss notation applied on a successful check (`"0"`, `"1"`, `"1d4"`). */
  readonly successLoss: string;
  /** Loss notation applied on a failed check (`"1d6"`). */
  readonly failureLoss: string;
  /** The scene tag a pack's loss ceiling may read (`"fire"`); default empty. */
  readonly tag?: string;
  /** The room's house-rule ladder; null or unknown = the default ladder. */
  readonly variant?: string | null;
}

export type LossCheckRefusal =
  /** A loss notation that does not parse or cannot be rolled; `which` says which one. Refused before any roll when it does not parse. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "bad_loss"; readonly which: "success" | "failure"; readonly notation: string; readonly errorCode: DiceErrorCode }
  /** The sheet has no value in the stat's slot. */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "stat_unset"; readonly stat: string }
  /** The system's check could not be rolled or graded (e.g. a roll parameter without a default). */
  | { readonly ok: false; readonly subsystem: string; readonly refusal: "roll_failed"; readonly errorCode: ResolutionErrorCode };

export interface LossCheckResult {
  readonly ok: true;
  readonly subsystem: string;
  /** The attribute storage key rolled against and deducted from. */
  readonly stat: string;
  /** The value of the pack's `stat_max` slot; null when undeclared or unset. */
  readonly statMax: number | null;
  readonly check: RolledCheck;
  readonly outcome: CheckOutcome;
  /** Which loss notation the outcome chose, as given. */
  readonly lossFor: "success" | "failure";
  readonly lossNotation: string;
  readonly lossRoll: Roll;
  /** The rolled loss (the roll's total, at least 0), before the pack's rules. */
  readonly rolledLoss: number;
  /** The fumble rule that set the loss, or null when none applied. */
  readonly fumbleRule: "all" | "max" | null;
  /** The ceiling that capped the loss, or null when it did not hold or did not lower it. */
  readonly ceiling: number | null;
  /** The loss deducted. */
  readonly loss: number;
  readonly statBefore: number;
  readonly statAfter: number;
  /** The sheet with the new value (unchanged when the write was refused). */
  readonly sheet: Sheet;
  readonly writeRefused: WriteRefusal | null;
}

function parseLoss(text: string): { readonly ok: true; readonly expression: DiceExpression } | { readonly ok: false; readonly errorCode: DiceErrorCode } {
  try {
    return { ok: true, expression: parseDice(text.trim()) };
  } catch (error) {
    if (error instanceof DiceError) return { ok: false, errorCode: error.code };
    throw error;
  }
}

/**
 * The largest total a loss notation can roll, for the `max` fumble rule: defined for a
 * plain `NdM`, `NdM + K` (K at least 0) or a constant; null for anything else, which then
 * keeps the rolled loss (the reference rule, which no pack outgrew).
 */
export function lossMaximum(expression: DiceExpression): number | null {
  const plainDice = (node: Expr): number | null => {
    if (node.kind !== "dice" || node.ops.length > 0 || node.labels.length > 0) return null;
    if (node.sides.kind !== "int" || (node.count !== null && node.count.kind !== "int")) return null;
    return (node.count === null ? 1 : node.count.value) * node.sides.value;
  };
  const root = expression.root;
  if (root.kind === "number") return root.value;
  if (root.kind === "binary" && root.op === "+" && root.right.kind === "number" && root.right.value >= 0) {
    const dice = plainDice(root.left);
    return dice === null ? null : dice + root.right.value;
  }
  return plainDice(root);
}

/** Whether the pack's ceiling holds for this call. A condition that fails to evaluate never caps. */
function ceilingHolds(spec: SheetSpec, sheet: Sheet, ceiling: LossCeiling, tag: string): boolean {
  const evaluation = evaluateSheet(spec, sheet);
  const resolve: Resolver = (path) => {
    if (path === "tag") return tag;
    const name = path.startsWith("stat_data.") ? path.slice("stat_data.".length) : path;
    // The sheet's own value first (a trained skill), else the derivation, as every read does.
    if (evaluation.source.has(name)) return evaluation.source.get(name);
    if (evaluation.values.has(name)) return evaluation.values.get(name);
    return ABSENT;
  };
  try {
    return ceiling.when.test(resolve);
  } catch (error) {
    if (error instanceof ExprError) return false;
    throw error;
  }
}

export function runLossCheck(pack: RulePack, id: string, request: LossCheckRequest, random: RandomSource): LossCheckResult | LossCheckRefusal {
  const spec = subsystemOf(pack, id, "check_with_loss");
  const resolution = resolutionOf(pack, id);
  const sheetSpec = pack.sheet;
  const refused = { ok: false as const, subsystem: id };

  // Both notations are checked before anything is rolled: a bad request consumes no dice.
  const success = parseLoss(request.successLoss);
  if (!success.ok) return { ...refused, refusal: "bad_loss", which: "success", notation: request.successLoss, errorCode: success.errorCode };
  const failure = parseLoss(request.failureLoss);
  if (!failure.ok) return { ...refused, refusal: "bad_loss", which: "failure", notation: request.failureLoss, errorCode: failure.errorCode };

  const statBefore = readAttribute(sheetSpec, request.sheet, spec.stat);
  if (statBefore === null) return { ...refused, refusal: "stat_unset", stat: spec.stat };

  const graded = rollAndGrade(resolution, random, statBefore, request.variant);
  if (!graded.ok) return { ...refused, refusal: "roll_failed", errorCode: graded.errorCode };
  const { check, outcome } = graded.roll;

  const lossFor = outcome.rank.success ? "success" : "failure";
  const expression = lossFor === "success" ? success.expression : failure.expression;
  const notation = lossFor === "success" ? request.successLoss : request.failureLoss;
  let lossRoll: Roll;
  try {
    lossRoll = rollExpression(expression, random);
  } catch (error) {
    if (error instanceof DiceError) return { ...refused, refusal: "bad_loss", which: lossFor, notation, errorCode: error.code };
    throw error;
  }

  // A loss is never a gain: a notation that rolls below zero (`1d4-3`) loses nothing.
  const rolledLoss = Math.max(0, lossRoll.total);
  let loss = rolledLoss;
  let fumbleRule: "all" | "max" | null = null;
  if (outcome.rank.fumble && spec.fumbleLoss !== null) {
    fumbleRule = spec.fumbleLoss;
    if (spec.fumbleLoss === "all") {
      loss = statBefore;
    } else {
      const maximum = lossMaximum(expression);
      loss = maximum === null ? rolledLoss : Math.max(maximum, rolledLoss);
    }
  }
  let ceiling: number | null = null;
  if (spec.lossCeiling !== null && loss > spec.lossCeiling.value && ceilingHolds(sheetSpec, request.sheet, spec.lossCeiling, request.tag ?? "")) {
    ceiling = spec.lossCeiling.value;
    loss = ceiling;
  }

  const statAfter = Math.max(0, statBefore - loss);
  const written = writeAttribute(sheetSpec, request.sheet, spec.stat, statAfter);
  return Object.freeze({
    ok: true,
    subsystem: id,
    stat: spec.stat,
    statMax: spec.statMax === null ? null : readAttribute(sheetSpec, written.sheet, spec.statMax),
    check,
    outcome,
    lossFor,
    lossNotation: notation,
    lossRoll,
    rolledLoss,
    fumbleRule,
    ceiling,
    loss,
    statBefore,
    statAfter,
    sheet: written.sheet,
    writeRefused: written.refused,
  });
}
