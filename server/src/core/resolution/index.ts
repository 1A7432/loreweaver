/**
 * Check resolution: how a rule pack's `resolution:` section rolls and grades a check.
 *
 * A check runs in three phases with hard boundaries. ROLL (`rollCheck`) is the only place
 * randomness enters, through the injected `RandomSource`. GRADE (`gradeCheck`) is a pure
 * function of the rolled values and the check's conditions: the first rule of the chosen
 * ladder whose condition holds gives the rank, and the margin follows. APPLY (what the
 * rank does to a character) is the callers' business. `performCheck` runs the first two.
 *
 * Outcomes are data (rank id, tier, flags, margin, targets); labels are never resolved
 * here — a caller localizes the rank id through the pack's labels.
 *
 * Rounding: one rule for the whole layer, truncation toward zero (`toInteger` in
 * `grade.ts`), for effective targets, margins and fractional parameter values.
 */

export { compileResolution, MAX_DIFFICULTIES, MAX_RANKS, MAX_VARIANTS, RESOLUTION_VERSION } from "./compile.ts";
export { ResolutionError, type ResolutionErrorCode, type ResolutionErrorDetails } from "./errors.ts";
export { effectiveTarget, gradeCheck, ladderFor, toInteger } from "./grade.ts";
export { type LuckSpend, type LuckSpendRequest, spendLuck } from "./luck.ts";
export {
  type CheckRequest,
  type CheckRollRequest,
  clampParams,
  type FavorResult,
  favorModifiers,
  type ModifierCounts,
  type ParamValues,
  performCheck,
  rollCheck,
} from "./roll.ts";
export * from "./types.ts";
