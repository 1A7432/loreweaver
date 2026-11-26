/**
 * Grading an already-rolled check: a PURE function of (rolled values, target, variant,
 * difficulty, modifier). No randomness and no state, which is what makes house-rule
 * variants, re-grading after a Luck spend, replay and exhaustive rulebook tables possible.
 *
 * A target the caller does not have is ABSENT from the expressions' namespace, never a
 * stand-in 0: a 0 turns `roll >= target` into a tautology, and the reference engine once
 * graded every side of a dc contest a success that way. A ladder that needs the target
 * then fails with `TARGET_REQUIRED`; one that never reads it (a success pool) grades.
 */

import { ABSENT, type CompiledExpr, ExprError, type Resolver, truthy, type Value } from "../condexpr.ts";
import { ResolutionError } from "./errors.ts";
import type { CheckOutcome, GradeOptions, Ladder, Rank, Resolution, RolledValues } from "./types.ts";

/**
 * THE rounding rule of this layer: a fractional effective target or margin is truncated
 * toward zero (`thirds` of -4 is -1, not -2), as the reference engine's `int()` did and
 * its recorded vectors show. Booleans read as 0/1. Anything else is not a number.
 */
export function toInteger(value: Value): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "number") return null;
  // `+ 0` folds -0 (from truncating -0.5) into 0.
  return Math.trunc(value) + 0;
}

function assertInteger(value: unknown, code: "INVALID_TARGET" | "INVALID_ROLL" | "INVALID_MODIFIER", what: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ResolutionError(code, `${what} must be a safe integer, got ${String(value)}`);
  }
}

function optionalCount(value: number | null | undefined, what: string): number | null {
  if (value === undefined || value === null) return null;
  assertInteger(value, "INVALID_ROLL", what);
  return value;
}

/** Runs a pack expression, turning a failure into this layer's error. */
function run(expr: CompiledExpr, resolve: Resolver, missing: () => string | null, path: string): Value {
  try {
    return expr.evaluate(resolve, { absent: "error" });
  } catch (error) {
    if (!(error instanceof ExprError)) throw error;
    const name = missing();
    if (error.code === "ABSENT_NAME" && name !== null) {
      if (name === "target" || name === "raw_target") {
        throw new ResolutionError("TARGET_REQUIRED", `${path} reads ${name}, and this check has no target`, { cause: error });
      }
      throw new ResolutionError("DIE_MISSING", `${path} reads ${name}, beyond the faces this roll kept`, { cause: error });
    }
    throw new ResolutionError("EXPRESSION_FAILED", `${path} failed: ${error.message}`, { cause: error });
  }
}

/**
 * The difficulty-adjusted target: what the roll actually has to beat. Null when there is
 * no target. An unknown or empty difficulty id leaves the target unchanged.
 */
export function effectiveTarget(resolution: Resolution, target: number | null | undefined, difficulty?: string | null): number | null {
  if (target === undefined || target === null) return null;
  assertInteger(target, "INVALID_TARGET", "target");
  const transform = difficulty ? resolution.difficulties.get(difficulty)?.target : undefined;
  if (transform === undefined || transform === null) return target;
  // Compile time guaranteed the transform reads only these two names.
  const resolve: Resolver = (path) => (path === "target" || path === "raw_target" ? target : ABSENT);
  const value = toInteger(run(transform, resolve, () => null, `difficulty ${difficulty}`));
  if (value === null) throw new ResolutionError("EXPRESSION_FAILED", `difficulty ${difficulty} did not yield a number`);
  return value;
}

/** The ladder a variant id selects; an id the pack does not declare grades by the default. */
export function ladderFor(resolution: Resolution, variant?: string | null): { readonly variant: string | null; readonly ladder: Ladder } {
  const ladder = variant ? resolution.variants.get(variant) : undefined;
  return ladder === undefined ? { variant: null, ladder: resolution.ladder } : { variant: variant ?? null, ladder };
}

/** PURE: grade one rolled check. */
export function gradeCheck(resolution: Resolution, rolled: RolledValues, options: GradeOptions = {}): CheckOutcome {
  const modifier = options.modifier ?? 0;
  assertInteger(modifier, "INVALID_MODIFIER", "modifier");
  assertInteger(rolled.total, "INVALID_ROLL", "total");
  const dice = rolled.dice;
  for (const face of dice) assertInteger(face, "INVALID_ROLL", "a die face");
  // Outside a pool these read 0, as the reference did: a ladder that compares `successes`
  // in a non-pool system is the pack's choice, and no pack can tell absence apart here.
  const successes = optionalCount(rolled.successes, "successes") ?? 0;
  const ones = optionalCount(rolled.ones, "ones") ?? 0;
  const rawTarget = options.target ?? null;
  const target = effectiveTarget(resolution, rawTarget, options.difficulty);
  const roll = rolled.total + modifier;
  assertInteger(roll, "INVALID_ROLL", "total plus modifier");

  let missing: string | null = null;
  const resolve: Resolver = (path) => {
    switch (path) {
      case "roll":
        return roll;
      case "modifier":
        return modifier;
      case "successes":
        return successes;
      case "ones":
        return ones;
      case "target":
        if (target !== null) return target;
        break;
      case "raw_target":
        if (rawTarget !== null) return rawTarget;
        break;
      default:
        // Compile time admitted only `dice.<canonical index>` beyond the names above.
        if (path.startsWith("dice.")) {
          const face = dice[Number(path.slice(5))];
          if (face !== undefined) return face;
        }
    }
    missing = path;
    return ABSENT;
  };
  const lastMissing = (): string | null => missing;

  const { variant, ladder } = ladderFor(resolution, options.variant);
  let rank: Rank | null = null;
  for (let index = 0; index < ladder.length; index++) {
    const rule = ladder[index]!;
    if (rule.when === null) {
      rank = rule.rank;
      break;
    }
    const value = run(rule.when, resolve, lastMissing, `rank rule ${index} (${rule.rank.id})`);
    if (truthy(value)) {
      rank = rule.rank;
      break;
    }
  }
  // Compilation guarantees an unconditional last rule, so a rank is always found.
  if (rank === null) throw new ResolutionError("EXPRESSION_FAILED", "the ladder resolved no rank");

  let margin: number | null;
  if (resolution.margin !== null) {
    margin = toInteger(run(resolution.margin, resolve, lastMissing, "margin"));
    if (margin === null) throw new ResolutionError("EXPRESSION_FAILED", "margin did not yield a number");
  } else if (target === null) {
    margin = null;
  } else {
    margin = resolution.compare === "<=" ? target - roll : roll - target;
  }
  return Object.freeze({ rank, margin, target: rawTarget, effectiveTarget: target, roll, variant });
}
