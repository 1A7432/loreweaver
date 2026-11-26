// Maps each reference vector (`dice_vectors`, a call of the frozen Python `DiceRoller`)
// onto the new engine's API, replays the recorded draws, and returns the outcome in the
// vector's own shape, so a test can compare the fields that are BEHAVIOUR.
//
// Not compared, on purpose:
// - `text.*` (the localized `format_result` strings): rendering is the new engine's own
//   language-neutral format, and the "Result:" sentence belongs to callers.
// - `expression` (DiceResult: the text as typed; RollDetail: the lower-cased, substituted
//   text). The new engine reports a canonical notation instead; parsing is compared through
//   every other field.
// - the draws an ERROR row consumed: the new engine refuses an oversized dice group before
//   drawing (the old one drew up to the limit first). A successful row must consume exactly
//   its recorded draws.
import {
  type DiceErrorCode,
  DiceError,
  keptFaces,
  naturalCritical,
  primaryDice,
  type Roll,
  rollAdvantage,
  rollDice,
  rollPercentileTens,
  rollRepeated,
} from "../../../src/core/dice/index.ts";
import { ScriptedRandom, type ScriptedDraw } from "../../../src/core/random.ts";

export interface VectorRow {
  id: string;
  fn: string;
  args: Record<string, unknown>;
  draws: [number, number, number, number][];
  result: unknown;
  error: { class: string; message: string } | null;
}

export type Replay =
  | { kind: "skip"; reason: string }
  | { kind: "ok"; actual: unknown; expected: unknown; leftover: number }
  | { kind: "error"; actual: DiceErrorCode; expected: DiceErrorCode };

/**
 * Rows the new engine answers differently on purpose, with the ruling or decision behind
 * each. Matched on `fn` + the row's arguments.
 */
const PERCENT_EXPRESSIONS = new Set(["1d%", "d%", "2d%", "1d%+5", "2d%kh1", "1d%+1d10", "3d%kl1"]);

const COUNTING_EXPRESSIONS = new Set(["1d20>10", "1d20<10", "1d20>=10+0", "1d20<=10+0", "2d6>7", "2d20kh1>10", "1d6>1d6"]);

function deliberateSkip(row: VectorRow): string | null {
  const expr = typeof row.args.expression === "string" ? row.args.expression : null;
  const failed = row.error !== null;
  // The old engine read `d%` as the d20 library's tens die (0-90); these rows recorded that.
  if (expr !== null && PERCENT_EXPRESSIONS.has(expr)) return "d% is a d100 now";
  // The old engine compared the TOTAL for these; a comparison after a dice group now counts dice.
  if (expr !== null && COUNTING_EXPRESSIONS.has(expr)) return "a comparison after a dice group counts dice";
  if (expr !== null && ["roll_expression", "roll_advantage", "roll_disadvantage", "roll_repeat"].includes(row.fn)) {
    if (failed && expr.includes("!") && expr !== "!" && expr !== "1d6!!" && !expr.includes("!=")) {
      return "ruling 6: `!` explodes in every entry point (the old roll_expression refused it, so no draws were recorded)";
    }
    if (failed && /df/i.test(expr)) return "ruling 5: Fate dice mean the same in every entry point";
    if (failed && /[！-～]/u.test(expr)) return "decision: full-width ASCII forms read as ASCII (CJK input methods type them)";
  }
  if (row.fn === "roll_detail" && expr !== null) {
    const params = row.args.params as Record<string, unknown> | null;
    if (expr === "0df") return "ruling 3: 0dF rolls zero dice";
    if (expr === "1000df" || expr === "2df+10000") return "decision: one dice limit for all notation (the old Fate pattern capped digits at 3/4)";
    if (expr === "1000d10>=6") return "decision: a success pool is a pool at any count within the dice limit (the old pattern capped the count at 3 digits)";
    if (expr === "{POOL}d10>=6") return "decision: slot names are case-sensitive (the old engine lower-cased the whole text first)";
    if (params !== null && params.pool === -3) return "decision: a slot is a value, not text; a negative dice count is BAD_PARAM (the old text substitution produced `-3d10>=6`, a comparison)";
  }
  if (row.fn === "roll_fate" && typeof row.args.dice_count === "number" && row.args.dice_count <= 0) {
    return "ruling 3: zero Fate dice roll zero dice (the old roller rolled four for any count <= 0; a negative count has no notation)";
  }
  if (row.fn === "roll_for_check" && row.args.pack === "wod") {
    return "out of scope: parameter defaults and clamping are the rule pack's (roll_detail rows cover slots)";
  }
  return null;
}

/** Python `int(value)` as the old callers applied it to loosely-typed input; null = it raised. */
function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function scripted(row: VectorRow, fate: boolean): ScriptedRandom {
  const draws: ScriptedDraw[] = row.draws.map(([lo, hi, value, step]) =>
    // The old Fate die was `randint(1, 3) - 2`; the new one asks for -1..1 directly.
    fate && lo === 1 && hi === 3 ? { lo: -1, hi: 1, value: value - 2, step } : { lo, hi, value, step },
  );
  return new ScriptedRandom(draws);
}

function sidesNumber(sides: number | "F"): number {
  if (sides === "F") return 3;
  return sides;
}

/** The old `DiceResult` fields, derived from a new `Roll`. */
export function asDiceResult(roll: Roll, isCheck: boolean): Record<string, unknown> {
  const group = primaryDice(roll);
  const kept = group === null ? [] : keptFaces(group);
  const rolls = kept.length > 0 ? kept : [0];
  const pool = roll.root.kind === "pool";
  const check = pool ? false : isCheck;
  // Ruling 2: a dropped die keeps its face; the old record wrote 0 in its place.
  const zeroFilled = group === null ? [] : group.dice.map((die) => (die.kept ? die.face : 0));
  const critical = check && group !== null ? naturalCritical(group.sides, kept) : null;
  return {
    rolls,
    modifier: pool ? 0 : roll.total - rolls.reduce((a, b) => a + b, 0),
    dice_count: kept.length,
    dice_sides: group === null ? 0 : sidesNumber(group.sides),
    total: roll.total,
    is_check: check,
    all_rolls: pool ? null : zeroFilled.length > kept.length ? zeroFilled : rolls,
    critical_success: critical === "success",
    critical_failure: critical === "failure",
  };
}

const DICE_RESULT_FIELDS = ["rolls", "modifier", "dice_count", "dice_sides", "total", "is_check", "all_rolls", "critical_success", "critical_failure"];

function diceResultPair(expected: Record<string, unknown>, actual: Record<string, unknown>): [unknown, unknown] {
  const exp: Record<string, unknown> = {};
  for (const field of DICE_RESULT_FIELDS) {
    // The old record has no `all_rolls` for pools and Fate dice.
    if (field === "all_rolls" && expected.all_rolls === null) continue;
    // Decision: a die of fewer than two faces has no natural critical (the old engine
    // flagged a d1 check as a critical success AND a critical failure).
    const critical = field === "critical_success" || field === "critical_failure";
    exp[field] = critical && typeof expected.dice_sides === "number" && expected.dice_sides < 2 ? false : expected[field];
  }
  const act: Record<string, unknown> = {};
  for (const key of Object.keys(exp)) act[key] = actual[key];
  return [act, exp];
}

/** The old `RollDetail` fields (all but `expression`), derived from a new `Roll`. */
function asRollDetail(roll: Roll): Record<string, unknown> {
  const root = roll.root;
  const group = primaryDice(roll);
  const kept = group === null ? [] : keptFaces(group);
  const dice = kept.length > 0 ? kept : [0];
  if (root.kind === "pool") {
    return { dice, total: roll.total, modifiers: { threshold: root.threshold }, successes: root.successes, ones: root.ones };
  }
  const modifiers: Record<string, unknown> = {};
  const modifier = roll.total - dice.reduce((a, b) => a + b, 0);
  if (modifier !== 0) modifiers.modifier = modifier;
  const zeroFilled = group === null ? [] : group.dice.map((die) => (die.kept ? die.face : 0));
  if (zeroFilled.length > kept.length) modifiers.dice_all = zeroFilled;
  return { dice, total: roll.total, modifiers, successes: null, ones: null };
}

function withoutExpression(detail: Record<string, unknown>): Record<string, unknown> {
  const { expression: _expression, ...rest } = detail;
  return rest;
}

/** Which new code an old error class means for this row. */
function expectedCode(row: VectorRow): DiceErrorCode {
  const cls = row.error?.class;
  if (cls === "RollValueError") return "DIVISION_BY_ZERO";
  if (cls === "TooManyRolls") return "TOO_MANY_DICE";
  const expr = typeof row.args.expression === "string" ? row.args.expression : "";
  if (row.fn === "roll_repeat" && typeof row.args.times === "number" && (row.args.times < 1 || row.args.times > 20)) return "BAD_COUNT";
  if (expr.trim() === "") return "EMPTY";
  // The old roll_expression wrapped every d20 failure in one ValueError; these are the
  // rows whose cause was not a syntax error.
  if (["999999999d6", "1001d6", "500d6+501d6", "1d1e1", "2d1e1"].includes(expr)) return "TOO_MANY_DICE";
  if (expr === "1d0") return "ZERO_SIDED_DIE";
  if (["2d1>=1", "0d10>=6", "5d1>=1", "1d1>=1"].includes(expr)) return "BAD_POOL";
  if (row.fn === "roll_detail" && expr === "{pool}d10>={difficulty}") {
    const params = row.args.params as Record<string, unknown> | null;
    if (params === null || Object.keys(params).length === 0 || !("difficulty" in params)) return "MISSING_PARAM";
    if (pyInt(params.pool) === null) return "BAD_PARAM";
    if (params.pool === 0) return "BAD_POOL";
  }
  return "SYNTAX";
}

function coercedParams(raw: unknown): Map<string, number> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const params = new Map<string, number>();
  for (const [name, value] of Object.entries(raw)) params.set(name, pyInt(value) ?? Number.NaN);
  return params;
}

/** The old roll_explode: `e<sides>` after the LEADING dice token, the run capped by a dice budget. */
function explodeCall(expression: string, maxExplosions: number | null): { notation: string; maxDice: number } | null {
  const text = expression.trim().toLowerCase();
  const match = /^(\d*)d(\d+)/.exec(text);
  if (match === null) return null;
  const count = match[1] === "" || match[1] === undefined ? 1 : Number(match[1]);
  return { notation: `${text.slice(0, match[0].length)}!${text.slice(match[0].length)}`, maxDice: count * ((maxExplosions ?? 10) + 1) };
}

/** A minimal stand-in for the two built-in packs' resolution blocks the vectors use. */
const PACKS: Record<string, { roll: string; modifiers: Record<string, { roll?: string; tens?: "keep_lowest" | "keep_highest" }> }> = {
  coc7: { roll: "1d100", modifiers: { bonus: { tens: "keep_lowest" }, penalty: { tens: "keep_highest" } } },
  dnd5e: { roll: "1d20", modifiers: { advantage: { roll: "2d20kh1" }, disadvantage: { roll: "2d20kl1" } } },
};

function forCheck(row: VectorRow, random: ScriptedRandom): unknown {
  const pack = PACKS[row.args.pack as string];
  if (pack === undefined) throw new Error(`no pack stand-in for ${String(row.args.pack)}`);
  let notation = pack.roll;
  let net = 0;
  const applied: Record<string, number> = {};
  for (const [name, rawCount] of row.args.modifiers as [string, unknown][]) {
    const spec = pack.modifiers[name];
    const count = pyInt(rawCount) ?? 0;
    if (spec === undefined || count <= 0) continue;
    applied[name] = count;
    if (spec.roll !== undefined) notation = spec.roll;
    if (spec.tens === "keep_lowest") net += count;
    else if (spec.tens === "keep_highest") net -= count;
  }
  if (net !== 0) {
    const tens = rollPercentileTens(random, net);
    return {
      dice: [tens.total],
      total: tens.total,
      modifiers: { ...applied, base_roll: tens.base, extra_tens: tens.extraTens, final_tens: tens.finalTens },
      successes: null,
      ones: null,
    };
  }
  const detail = asRollDetail(rollDice(notation, random));
  return { ...detail, modifiers: { ...(detail.modifiers as object), ...applied } };
}

export function replay(row: VectorRow): Replay {
  const skip = deliberateSkip(row);
  if (skip !== null) return { kind: "skip", reason: skip };
  const args = row.args;
  const expr = typeof args.expression === "string" ? args.expression : "";
  const fate = row.fn === "roll_fate" || (row.fn === "roll_detail" && /df/i.test(expr));
  const random = scripted(row, fate);
  let actual: unknown;
  let expected: unknown = row.result;
  try {
    switch (row.fn) {
      case "roll_expression": {
        const [a, e] = diceResultPair(row.result as Record<string, unknown>, asDiceResult(rollDice(expr, random), args.is_check === true));
        actual = a;
        expected = e;
        break;
      }
      case "roll_detail":
        actual = asRollDetail(rollDice(expr, random, { params: coercedParams(args.params) }));
        expected = row.result === null ? null : withoutExpression(row.result as Record<string, unknown>);
        break;
      case "roll_advantage":
      case "roll_disadvantage": {
        const outcome = rollAdvantage(expr, random, row.fn === "roll_advantage" ? "advantage" : "disadvantage");
        const old = row.result as { kept: Record<string, unknown>; kept_index: number; candidates: Record<string, unknown>[] };
        const isCheck = args.is_check === true;
        const pairs = outcome.candidates.map((roll, i) => diceResultPair(old.candidates[i] ?? {}, asDiceResult(roll, isCheck)));
        const keptPair = diceResultPair(old.kept, asDiceResult(outcome.kept, isCheck));
        actual = { keptIndex: outcome.keptIndex, kept: keptPair[0], candidates: pairs.map((p) => p[0]) };
        expected = { keptIndex: old.kept_index, kept: keptPair[1], candidates: pairs.map((p) => p[1]) };
        break;
      }
      case "roll_explode": {
        const call = explodeCall(expr, args.max_explosions as number | null);
        if (call === null) return { kind: "skip", reason: "the old roll_explode's own leading-token pattern refused the text before any notation was read" };
        const [a, e] = diceResultPair(row.result as Record<string, unknown>, asDiceResult(rollDice(call.notation, random, { maxDice: call.maxDice }), false));
        actual = a;
        expected = e;
        break;
      }
      case "roll_fate": {
        const count = args.dice_count as number;
        const modifier = args.modifier as number;
        const notation = `${count}dF${modifier > 0 ? `+${modifier}` : modifier < 0 ? String(modifier) : ""}`;
        const [a, e] = diceResultPair(row.result as Record<string, unknown>, asDiceResult(rollDice(notation, random), false));
        actual = a;
        expected = e;
        break;
      }
      case "roll_repeat": {
        const rolls = rollRepeated(expr, args.times as number, random);
        const old = row.result as Record<string, unknown>[];
        const pairs = rolls.map((roll, i) => diceResultPair(old[i] ?? {}, asDiceResult(roll, false)));
        actual = pairs.map((p) => p[0]);
        expected = pairs.map((p) => p[1]);
        break;
      }
      case "roll_d100_tens_reroll": {
        const tens = rollPercentileTens(random, args.net as number);
        actual = { roll: tens.base, final_roll: tens.total, tens: tens.tens, ones: tens.ones, extra_tens: tens.extraTens, final_tens: tens.finalTens };
        break;
      }
      case "roll_for_check":
        actual = forCheck(row, random);
        expected = withoutExpression(row.result as Record<string, unknown>);
        break;
      default:
        throw new Error(`unknown fn ${row.fn}`);
    }
  } catch (error) {
    if (!(error instanceof DiceError)) throw error;
    if (row.error === null) throw new Error(`${row.id}: unexpected ${error.code}`);
    return { kind: "error", actual: error.code, expected: expectedCode(row) };
  }
  if (row.error !== null) throw new Error(`${row.id}: expected ${row.error.class}, the new engine succeeded`);
  return { kind: "ok", actual, expected, leftover: random.remaining };
}
