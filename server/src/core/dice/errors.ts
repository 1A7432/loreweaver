/**
 * The one error type of the dice engine, and its limits.
 *
 * Notation is typed by players and written by pack authors, so every failure carries a
 * stable machine `code` (callers branch on it and localize from it) and, where it points
 * at the text, a `position` in CODE POINTS (what a person counts, unlike UTF-16 units).
 * The `message` is only the code and position: there is no sentence here to translate.
 */

export type DiceErrorCode =
  /** Nothing but whitespace. */
  | "EMPTY"
  /** The text is not dice notation. `position` is where reading stopped. */
  | "SYNTAX"
  /** The notation is longer than `LIMITS.maxNotationLength`. */
  | "TOO_LONG"
  /** Parentheses or unary signs nest deeper than `LIMITS.maxDepth`. */
  | "TOO_DEEP"
  /** One roll would roll more dice than its budget (`LIMITS.maxDice`, or a lower `maxDice` option). */
  | "TOO_MANY_DICE"
  /** A die has more faces than `LIMITS.maxSides`. */
  | "TOO_MANY_SIDES"
  /** A die with no faces had to be rolled (`1d0`; `0d0` rolls nothing and is fine). */
  | "ZERO_SIDED_DIE"
  /** A success pool needs at least one die of at least two faces. */
  | "BAD_POOL"
  | "DIVISION_BY_ZERO"
  /** A number or an intermediate result is beyond `Number.MAX_SAFE_INTEGER`. */
  | "VALUE_TOO_LARGE"
  /** A `{name}` slot has no value in `params`. */
  | "MISSING_PARAM"
  /** A slot's value is not a safe integer, or makes a dice count or face count negative. */
  | "BAD_PARAM"
  /** A count given to a special roller (repeat times, tens dice) is out of its range. */
  | "BAD_COUNT";

export class DiceError extends Error {
  readonly code: DiceErrorCode;
  /** Code-point offset into the notation, when the failure points at the text. */
  readonly position: number | undefined;

  constructor(code: DiceErrorCode, position?: number) {
    super(position === undefined ? code : `${code} at ${position}`);
    this.name = "DiceError";
    this.code = code;
    this.position = position;
  }
}

/**
 * The engine's hard limits. The dice budget is the old engine's (1000 dice per roll,
 * counting rerolls and explosions); the rest only stop pathological input from costing
 * time or stack.
 */
export const LIMITS = {
  /** Dice rolled by one evaluation, including rerolls and explosions. */
  maxDice: 1000,
  /** Faces on one die; keeps a draw inside one 32-bit random output. */
  maxSides: 1_000_000_000,
  /** Code points of notation. */
  maxNotationLength: 1000,
  /** Nesting of parentheses and unary signs. */
  maxDepth: 64,
  /** Extra tens dice in a percentile roll; past a handful the kept digit is saturated anyway. */
  maxTensDice: 100,
  /** Rolls of one `rollRepeated` call. */
  maxRepeat: 20,
} as const;
