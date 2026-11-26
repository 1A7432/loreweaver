/**
 * Spending Luck on an already-rolled check: lowering the roll by the points spent and
 * re-grading it. Pure arithmetic over a caller-supplied `grade` (the room's resolution
 * bound to the check's own target, variant and difficulty: a pure `gradeCheck`), so the
 * spend is replayable. Which checks qualify and which resource pays are the caller's
 * (pack subsystem data); updating the stored check record is the caller's too.
 */

import { ResolutionError } from "./errors.ts";
import type { Rank } from "./types.ts";

export interface LuckSpendRequest {
  /** The check's current roll (already lowered, if Luck was spent on it before). */
  readonly roll: number;
  /** Points to spend now: a positive integer. */
  readonly points: number;
  /** Points spent on this check before; default 0. */
  readonly alreadySpent?: number;
  /** Grades a roll value under the check's own conditions. */
  readonly grade: (roll: number) => Rank;
}

export interface LuckSpend {
  readonly beforeRoll: number;
  readonly afterRoll: number;
  readonly before: Rank;
  readonly after: Rank;
  /** `alreadySpent` plus this spend. */
  readonly totalSpent: number;
}

export function spendLuck(request: LuckSpendRequest): LuckSpend {
  const { roll, points } = request;
  if (!Number.isSafeInteger(points) || points <= 0) {
    throw new ResolutionError("LUCK_POINTS_NOT_POSITIVE", `Luck points must be a positive integer, got ${String(points)}`);
  }
  if (!Number.isSafeInteger(roll)) throw new ResolutionError("INVALID_ROLL", `roll must be a safe integer, got ${String(roll)}`);
  const before = request.grade(roll);
  // A fumble cannot be bought off, and a roll can never be lowered below 1.
  if (before.fumble) throw new ResolutionError("LUCK_FUMBLE", "a fumbled check cannot be adjusted with Luck");
  if (points >= roll) throw new ResolutionError("LUCK_EXCEEDS_ROLL", `spending ${points} would take the roll ${roll} below 1`);
  const alreadySpent = request.alreadySpent ?? 0;
  if (!Number.isSafeInteger(alreadySpent) || alreadySpent < 0) {
    throw new ResolutionError("INVALID_COUNT", `Luck already spent must be a non-negative integer, got ${String(alreadySpent)}`);
  }
  const afterRoll = roll - points;
  return Object.freeze({ beforeRoll: roll, afterRoll, before, after: request.grade(afterRoll), totalSpent: alreadySpent + points });
}
