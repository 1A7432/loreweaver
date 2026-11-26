/**
 * The entry points callers roll through: a notation, the same notation twice keeping the
 * better or worse (advantage), several times over, and the percentile roll with extra tens
 * dice that d100 systems call bonus and penalty dice.
 */

import type { RandomSource } from "../random.ts";
import { DiceError, LIMITS } from "./errors.ts";
import { type RollOptions, rollExpression } from "./evaluate.ts";
import { parseDice } from "./parse.ts";
import type { DiceExpression, Roll } from "./types.ts";

function parsed(notation: string | DiceExpression): DiceExpression {
  return typeof notation === "string" ? parseDice(notation) : notation;
}

/** Parses (when given text) and rolls dice notation. */
export function rollDice(notation: string | DiceExpression, random: RandomSource, options?: RollOptions): Roll {
  return rollExpression(parsed(notation), random, options);
}

export interface AdvantageRoll {
  readonly kept: Roll;
  readonly keptIndex: 0 | 1;
  readonly candidates: readonly [Roll, Roll];
}

/**
 * Rolls the notation twice and keeps the higher (`advantage`) or lower (`disadvantage`)
 * total; the first roll wins a tie. Rolling the whole notation twice, rather than
 * rewriting it to `2d20kh1`, works for any notation and leaves each roll a single-die
 * roll, so a natural critical can still be read off the kept one.
 */
export function rollAdvantage(
  notation: string | DiceExpression,
  random: RandomSource,
  mode: "advantage" | "disadvantage",
  options?: RollOptions,
): AdvantageRoll {
  const expression = parsed(notation);
  const first = rollExpression(expression, random, options);
  const second = rollExpression(expression, random, options);
  const takeSecond = mode === "advantage" ? second.total > first.total : second.total < first.total;
  return { kept: takeSecond ? second : first, keptIndex: takeSecond ? 1 : 0, candidates: [first, second] };
}

/** Rolls the notation `times` times (1 to `LIMITS.maxRepeat`), each with its own dice budget. */
export function rollRepeated(notation: string | DiceExpression, times: number, random: RandomSource, options?: RollOptions): Roll[] {
  if (!Number.isSafeInteger(times) || times < 1 || times > LIMITS.maxRepeat) throw new DiceError("BAD_COUNT");
  const expression = parsed(notation);
  const rolls: Roll[] = [];
  for (let i = 0; i < times; i++) rolls.push(rollExpression(expression, random, options));
  return rolls;
}

export interface PercentileRoll {
  /** The d100 as first rolled (1-100). */
  readonly base: number;
  /** Its tens digit (0-9; 100 reads as tens 0, ones 0). */
  readonly tens: number;
  readonly ones: number;
  /** The extra tens dice (0-9 each), in the order rolled. */
  readonly extraTens: readonly number[];
  /** The tens digit kept among `tens` and `extraTens`. */
  readonly finalTens: number;
  /** The d100 made of `finalTens` and `ones` (1-100). */
  readonly total: number;
}

/**
 * A d100 with `|net|` extra tens dice sharing the one ones die: `net > 0` keeps the tens
 * digit giving the LOWEST d100, `net < 0` the highest (opposing modifiers are expected to
 * have cancelled into `net` already). Candidates are compared by the d100 they make, not
 * by bare digit, because tens 0 with ones 0 is 100, the largest roll. More than
 * `LIMITS.maxTensDice` extra dice are not rolled: the kept digit is saturated long before.
 */
export function rollPercentileTens(random: RandomSource, net: number): PercentileRoll {
  if (!Number.isSafeInteger(net)) throw new DiceError("BAD_COUNT");
  const base = random.nextInt(1, 100);
  const ones = base % 10;
  const tens = Math.floor(base / 10) % 10;
  const valueOf = (candidate: number): number => (candidate === 0 && ones === 0 ? 100 : candidate * 10 + ones);
  const extraTens: number[] = [];
  const extra = Math.min(Math.abs(net), LIMITS.maxTensDice);
  for (let i = 0; i < extra; i++) extraTens.push(random.nextInt(0, 9));
  let finalTens = tens;
  for (const candidate of extraTens) {
    // Strict comparison keeps the earliest candidate on a tie, the original die first.
    if (net > 0 ? valueOf(candidate) < valueOf(finalTens) : valueOf(candidate) > valueOf(finalTens)) finalTens = candidate;
  }
  return { base, tens, ones, extraTens, finalTens, total: valueOf(finalTens) };
}
