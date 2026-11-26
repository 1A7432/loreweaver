/**
 * The ROLL step of a check, and the arithmetic around it: clamping the pack's roll
 * parameters, netting favourable/unfavourable counts onto the pack's modifier names, and
 * rolling through the dice engine with the injected `RandomSource` (the only randomness).
 *
 * The roll step always passes the pack's parameters through. The reference engine's
 * shared roll-and-grade helper did not, so a pool check through it always rolled the
 * declared defaults (one die at difficulty 6); here a caller's `params` reach the dice.
 */

import { DiceError, type DiceExpression, keptFaces, primaryDice, rollDice, rollPercentileTens } from "../dice/index.ts";
import type { RandomSource } from "../random.ts";
import { ResolutionError } from "./errors.ts";
import { effectiveTarget, gradeCheck } from "./grade.ts";
import { type CheckDefaults, FrozenMap, type GradeOptions, type PerformedCheck, type Resolution, type RolledCheck } from "./types.ts";

/** Caller-supplied roll parameter values, keyed by parameter id. */
export type ParamValues = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;

/** Roll modifier counts by name, applied in iteration order. */
export type ModifierCounts = Iterable<readonly [string, number]>;

const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;

/**
 * A parameter value as an integer, or null when it is not one. Numbers truncate toward
 * zero (3.9 is 3), as the reference's `int()` did; a string must be a plain decimal
 * integer, padding allowed (`" 8 "`), nothing looser (`"12abc"`, `"0x10"`, `"1e3"`).
 * A value past the safe range only has to keep its sign: it is clamped into a range of
 * safe integers right after.
 */
function parameterInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) + 0 : null;
  if (typeof value === "string" && INTEGER_TEXT.test(value)) return Number(value.trim()) + 0;
  return null;
}

function lookup(values: ParamValues | null | undefined, id: string): unknown {
  if (values === null || values === undefined) return undefined;
  if (values instanceof Map || values instanceof FrozenMap) return values.get(id);
  const record = values as Readonly<Record<string, unknown>>;
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

/**
 * Each declared parameter: the caller's value, else the declared default, as an integer
 * clamped into `[min, max]`, in declared order. Keys the pack does not declare are
 * ignored. A parameter given as `null`, or absent with no default, is `MISSING_PARAM`;
 * a value that is not an integer (a boolean, a list, `"x"`) is `INVALID_PARAM`.
 */
export function clampParams(resolution: Resolution, values?: ParamValues | null): FrozenMap<string, number> {
  const clamped: [string, number][] = [];
  for (const spec of resolution.params.values()) {
    const given = lookup(values, spec.id);
    const raw = given === undefined ? spec.default : given;
    if (raw === null) throw new ResolutionError("MISSING_PARAM", `no value for roll parameter ${JSON.stringify(spec.id)}`, { param: spec.id });
    const value = parameterInteger(raw);
    if (value === null) throw new ResolutionError("INVALID_PARAM", `roll parameter ${JSON.stringify(spec.id)} must be an integer`, { param: spec.id });
    clamped.push([spec.id, Math.min(spec.max, Math.max(spec.min, value))]);
  }
  return new FrozenMap(clamped);
}

export interface FavorResult {
  /** The modifier counts to roll with: empty, or one name. */
  readonly modifiers: FrozenMap<string, number>;
  /** The modifier name that applied; null when the counts cancel or the pack names none. */
  readonly applied: string | null;
}

/**
 * Nets favourable against unfavourable counts and routes the net to the pack's declared
 * modifier name: two bonus and one penalty is one bonus, never both. Counts must be
 * safe integers (negative counts simply net).
 */
export function favorModifiers(check: Pick<CheckDefaults, "favorable" | "unfavorable">, favorable: number, unfavorable: number): FavorResult {
  for (const count of [favorable, unfavorable]) {
    if (!Number.isSafeInteger(count)) throw new ResolutionError("INVALID_COUNT", `a favourable/unfavourable count must be a safe integer, got ${String(count)}`);
  }
  const net = favorable - unfavorable;
  if (net > 0 && check.favorable) return Object.freeze({ modifiers: new FrozenMap([[check.favorable, net]]), applied: check.favorable });
  if (net < 0 && check.unfavorable) return Object.freeze({ modifiers: new FrozenMap([[check.unfavorable, -net]]), applied: check.unfavorable });
  return Object.freeze({ modifiers: new FrozenMap<string, number>(), applied: null });
}

export interface CheckRollRequest {
  /** Roll modifier counts by declared name; a count of 0 or less does nothing. */
  readonly modifiers?: ModifierCounts | null;
  /** Values for the pack's roll parameters (see `clampParams`). */
  readonly params?: ParamValues | null;
}

/**
 * Rolls one check. Modifiers apply in the order given: a `roll` override replaces the
 * notation (when two do, the later wins), `tens_reroll` counts net into extra percentile
 * tens dice (keep-lowest positive, keep-highest negative). A non-zero net rolls the
 * percentile d100 with that many extra tens dice instead of the notation.
 */
export function rollCheck(resolution: Resolution, random: RandomSource, request: CheckRollRequest = {}): RolledCheck {
  const params = clampParams(resolution, request.params);
  let notation: DiceExpression = resolution.roll;
  let net = 0;
  const applied = new Map<string, number>();
  for (const [name, count] of request.modifiers ?? []) {
    const spec = resolution.modifiers.get(name);
    if (spec === undefined) throw new ResolutionError("UNKNOWN_MODIFIER", `the pack declares no roll modifier ${JSON.stringify(name)}`);
    if (!Number.isSafeInteger(count)) throw new ResolutionError("INVALID_COUNT", `the count of modifier ${JSON.stringify(name)} must be a safe integer`);
    if (count <= 0) continue;
    applied.set(name, (applied.get(name) ?? 0) + count);
    if (spec.roll !== null) notation = spec.roll;
    if (spec.tensReroll === "keep_lowest") net += count;
    else if (spec.tensReroll === "keep_highest") net -= count;
  }
  const modifiers = new FrozenMap(applied);

  try {
    if (net !== 0) {
      const percentile = rollPercentileTens(random, net);
      return Object.freeze({
        notation: notation.notation,
        roll: null,
        percentile,
        dice: Object.freeze([percentile.total]),
        total: percentile.total,
        successes: null,
        ones: null,
        modifiers,
        params,
      });
    }
    // The dice engine reads slot values from a real `Map` (or a plain record).
    const roll = rollDice(notation, random, { params: new Map(params) });
    const group = primaryDice(roll);
    const pool = roll.root.kind === "pool" ? roll.root : null;
    return Object.freeze({
      notation: notation.notation,
      roll,
      percentile: null,
      dice: Object.freeze(group === null ? [] : keptFaces(group)),
      total: roll.total,
      successes: pool === null ? null : pool.successes,
      ones: pool === null ? null : pool.ones,
      modifiers,
      params,
    });
  } catch (error) {
    if (error instanceof DiceError) throw new ResolutionError("ROLL_FAILED", `the dice engine refused the roll (${error.message})`, { cause: error });
    throw error;
  }
}

export interface CheckRequest extends CheckRollRequest, GradeOptions {}

/**
 * Rolls a check and grades it. A system that compares against a target (`skill`, `dc`)
 * rolled without one is left UNGRADED (`outcome: null`); a `target: none` system always
 * grades, since its ladder never needs one.
 */
export function performCheck(resolution: Resolution, random: RandomSource, request: CheckRequest = {}): PerformedCheck {
  const modifier = request.modifier ?? 0;
  if (!Number.isSafeInteger(modifier)) throw new ResolutionError("INVALID_MODIFIER", `modifier must be a safe integer, got ${String(modifier)}`);
  // Validate the target (and run its difficulty transform) BEFORE rolling, so a bad
  // request consumes no randomness.
  effectiveTarget(resolution, request.target, request.difficulty);
  const rolled = rollCheck(resolution, random, request);
  const hasTarget = request.target !== undefined && request.target !== null;
  const outcome = hasTarget || resolution.targetKind === "none" ? gradeCheck(resolution, rolled, request) : null;
  return Object.freeze({ rolled, total: rolled.total + modifier, outcome });
}
