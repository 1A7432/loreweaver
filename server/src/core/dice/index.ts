/**
 * The dice engine: notation players and packs write, parsed once and rolled against an
 * injected `RandomSource` (see `../random.ts`). Pure: no I/O, no clock, no global state.
 */

export { DiceError, type DiceErrorCode, LIMITS } from "./errors.ts";
export type { RollOptions } from "./evaluate.ts";
export { rollExpression } from "./evaluate.ts";
export { formatExpr, parseDice } from "./parse.ts";
export { keptFaces, naturalCritical, primaryDice, renderRoll } from "./render.ts";
export { type AdvantageRoll, type PercentileRoll, rollAdvantage, rollDice, rollPercentileTens, rollRepeated } from "./rollers.ts";
export type * from "./types.ts";
