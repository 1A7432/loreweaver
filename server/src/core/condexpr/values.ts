import { ExprError } from "./errors.ts";

/**
 * Values and the operators' semantics.
 *
 * Numbers are JavaScript doubles. The language has ONE number type (the reference
 * evaluator's `int`/`float` split is not carried over — see `strictEqual`); what IS
 * carried over is exactness: every arithmetic or function result must lie within
 * ±(2^53 − 1), where a double still represents each integer exactly, or the evaluation
 * fails with `NUMBER_RANGE` instead of returning a rounded integer. `NaN` and
 * `Infinity` never become values.
 */

export type Value = null | boolean | number | string | readonly Value[] | { readonly [key: string]: Value };

/** The longest string an expression may build (`+` concatenation). */
export const MAX_STRING_LENGTH = 65_536;
// Structural equality of resolver-supplied arrays/objects walks at most this deep and
// this many elements; past it the comparison is refused rather than left to run long.
const MAX_COMPARE_DEPTH = 32;
const MAX_COMPARE_ITEMS = 10_000;

const NUMERIC_STRING = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const INTEGER_STRING = /^[+-]?[0-9]+$/;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isCompound(value: Value): value is readonly Value[] | { readonly [key: string]: Value } {
  return typeof value === "object" && value !== null;
}

/** `-0` reads as `0` everywhere: `ceil(-0.5)` and `0 * -1` must not produce a value that
 * prints or divides differently from zero. */
function unsignedZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * A resolver's answer as a language value. `undefined` is null (the language's
 * `undefined` keyword is null too). Arrays and plain objects pass through as compound
 * values — they are truthy when non-empty and compare structurally — and are not
 * walked here: a large variable tree costs nothing unless an operator needs it.
 */
export function fromResolver(raw: unknown, position: number, path: string): Value {
  if (raw === undefined || raw === null) return null;
  switch (typeof raw) {
    case "boolean":
    case "string":
      return raw;
    case "number":
      if (!Number.isFinite(raw)) {
        throw new ExprError("BAD_VALUE", `${JSON.stringify(path)} resolved to a non-finite number`, position);
      }
      return unsignedZero(raw);
    case "object":
      if (Array.isArray(raw) || isPlainObject(raw)) return raw as Value;
      break;
    default:
      break;
  }
  throw new ExprError("BAD_VALUE", `${JSON.stringify(path)} resolved to an unsupported ${typeof raw}`, position);
}

/** JS-ish truthiness: `0`, `""`, null, `false`, an empty array and an empty object are
 * falsy (the reference counts an empty mapping falsy, as Python does). */
export function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isCompound(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** A result number, checked against the exact range. */
export function checkedNumber(value: number, position: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new ExprError("NUMBER_RANGE", "number out of range", position);
  }
  return unsignedZero(value);
}

/**
 * `value` as a number when it plainly is one, else null. A boolean is 0/1. A string
 * counts when it is a decimal numeral after trimming whitespace — `"7"`, `" 2.5 "`,
 * `"-3"`, `"1e3"` — and nothing looser: no hex, no `"Infinity"`, no empty string
 * (JavaScript's `Number()` would take all three). An integer numeral too large to be
 * exact is an error rather than a silently rounded number.
 */
export function asNumber(value: Value, position: number): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!NUMERIC_STRING.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || (INTEGER_STRING.test(text) && !Number.isSafeInteger(parsed))) {
    throw new ExprError("NUMBER_RANGE", `numeric string ${JSON.stringify(shorten(text))} is out of range`, position);
  }
  return unsignedZero(parsed);
}

/** A strict numeric operand (functions take numbers and booleans, never strings). */
export function numericArgument(value: Value, position: number, name: string): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  throw new ExprError("TYPE_MISMATCH", `${name}() expects a number, got ${describe(value)}`, position);
}

export function describe(value: Value): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `the string ${JSON.stringify(shorten(value))}`;
  return String(value);
}

function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * `===`: same type and same value. A boolean is never strictly equal to a number. Unlike
 * the reference, `2.0 === 2` holds: there is one number type, as in JavaScript (the
 * reference distinguished Python's `float` from `int` here, so `4 / 2 === 2` was false).
 * Arrays and objects compare structurally, element by element, by this same rule.
 */
export function strictEqual(left: Value, right: Value, position: number): boolean {
  if (!isCompound(left) || !isCompound(right)) return left === right;
  return structurallyEqual(left, right, position);
}

/**
 * `==`: strictly equal, or both sides read as numbers and the numbers are equal — so
 * `"5" == 5`, `true == 1` and `"1.0" == "1"` hold, while `"" == 0` and `null == 0` do not.
 */
export function looseEqual(left: Value, right: Value, position: number): boolean {
  if (strictEqual(left, right, position)) return true;
  const leftNumber = asNumber(left, position);
  if (leftNumber === null) return false;
  const rightNumber = asNumber(right, position);
  return rightNumber !== null && leftNumber === rightNumber;
}

// Iterative, so a hostile deeply nested variable tree cannot exhaust the stack.
function structurallyEqual(left: Value, right: Value, position: number): boolean {
  const stack: Array<[Value, Value, number]> = [[left, right, 0]];
  let visited = 0;
  while (stack.length > 0) {
    const [a, b, depth] = stack.pop()!;
    visited += 1;
    if (visited > MAX_COMPARE_ITEMS || depth > MAX_COMPARE_DEPTH) {
      throw new ExprError("VALUE_TOO_LARGE", "value too large to compare", position);
    }
    if (!isCompound(a) || !isCompound(b)) {
      if (a !== b) return false;
      continue;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) stack.push([a[index] as Value, b[index] as Value, depth + 1]);
      continue;
    }
    const recordA = a as { readonly [key: string]: Value };
    const recordB = b as { readonly [key: string]: Value };
    const keys = Object.keys(recordA);
    if (keys.length !== Object.keys(recordB).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(recordB, key)) return false;
      stack.push([recordA[key] as Value, recordB[key] as Value, depth + 1]);
    }
  }
  return true;
}

/** Code-point order, the reference's string order (JavaScript's `<` compares UTF-16
 * units, which ranks an astral character below U+E000–U+FFFF). */
function compareStrings(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const difference = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}

/**
 * `< <= > >=`: numerically when both sides read as numbers, lexically when both are
 * strings, and otherwise an ERROR — never JavaScript's silent `false`. `"abc" > 5`, an
 * absent name against a number, or an array against anything cannot be decided, and a
 * caller that gates on the answer must hear that instead of a guess.
 */
export function order(op: string, left: Value, right: Value, position: number): boolean {
  const leftNumber = asNumber(left, position);
  const rightNumber = leftNumber === null ? null : asNumber(right, position);
  let comparison: number;
  if (leftNumber !== null && rightNumber !== null) {
    comparison = leftNumber - rightNumber;
  } else if (typeof left === "string" && typeof right === "string") {
    comparison = compareStrings(left, right);
  } else {
    throw new ExprError("UNORDERABLE", `cannot order ${describe(left)} and ${describe(right)}`, position);
  }
  if (op === "<") return comparison < 0;
  if (op === "<=") return comparison <= 0;
  if (op === ">") return comparison > 0;
  return comparison >= 0;
}

/**
 * `+ - * / %`. Two strings `+` concatenate (even numeric ones: `"1" + "2"` is `"12"`);
 * otherwise both sides must read as numbers. `/` is true division (`7 / 2` is 3.5) and
 * `%` takes the sign of the divisor (`-7 % 3` is 2), as the reference's Python
 * operators did — rank ladders apply `%` to rolls a negative modifier can push below
 * zero, so the floored form is part of the recorded results.
 */
export function arithmetic(op: string, left: Value, right: Value, position: number): Value {
  if (op === "+" && typeof left === "string" && typeof right === "string") {
    if (left.length + right.length > MAX_STRING_LENGTH) {
      throw new ExprError("VALUE_TOO_LARGE", `string longer than ${MAX_STRING_LENGTH}`, position);
    }
    return left + right;
  }
  const a = asNumber(left, position);
  const b = a === null ? null : asNumber(right, position);
  if (a === null || b === null) {
    throw new ExprError("TYPE_MISMATCH", `cannot compute ${describe(left)} ${op} ${describe(right)}`, position);
  }
  switch (op) {
    case "+":
      return checkedNumber(a + b, position);
    case "-":
      return checkedNumber(a - b, position);
    case "*":
      return checkedNumber(a * b, position);
    case "/":
      if (b === 0) throw new ExprError("DIVISION_BY_ZERO", "division by zero", position);
      return checkedNumber(a / b, position);
    default: {
      if (b === 0) throw new ExprError("DIVISION_BY_ZERO", "modulo by zero", position);
      let remainder = a % b;
      if (remainder !== 0 && remainder < 0 !== b < 0) remainder += b;
      return checkedNumber(remainder, position);
    }
  }
}

export function negate(operand: Value, position: number): number {
  const number = asNumber(operand, position);
  if (number === null) throw new ExprError("TYPE_MISMATCH", `cannot negate ${describe(operand)}`, position);
  return checkedNumber(-number, position);
}
