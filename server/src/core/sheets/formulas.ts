/**
 * The pack's formulas over a sheet's canonical names: the `derived:` section (a DAG folded
 * in declaration order), creation budgets and vital start values.
 *
 * Every formula is compiled at pack load with the same explicit function set, so a
 * formula that cannot compile is a pack error then, not a silent 0 later. A formula that
 * fails while EVALUATING (division by zero, text where a number belongs, a non-integer
 * result, an input whose own formula failed) yields a `FormulaIssue`, and the value is
 * absent: it is never replaced by 0.
 *
 * A name a formula reads resolves to: the sheet's own value, else an earlier derived
 * result, else the pack's declared default, else 0. That fallback is the pack format's
 * documented meaning of an unset stat (a partial sheet derives like a fresh one), not
 * error suppression.
 */

import { type CompiledExpr, compile, ExprError, type ExprErrorCode, type FunctionName } from "../condexpr.ts";
import { SheetSpecError } from "./errors.ts";

/** The functions every sheet formula may call. `if(cond, a, b)` is eager. */
export const FORMULA_FUNCTIONS: readonly FunctionName[] = Object.freeze(["floor", "ceil", "min", "max", "abs", "if"]);

/** A derived result: an integer, or text (`"1d4"`, a band name). */
export type DerivedValue = number | string;

export type FormulaKind = "derived" | "budget" | "vital";

export type FormulaIssueCode =
  /** The expression itself failed (`exprCode` says how: division by zero, unorderable, …). */
  | "evaluation_failed"
  /** It read a name whose own derived formula failed. */
  | "input_failed"
  /** A number was required to be an integer and was not, or text stood where a number belongs. */
  | "not_integer"
  /** A sum or quotient left the exact integer range ±(2^53 − 1). */
  | "out_of_range"
  /** A `sum_ranges` total fell in no band and there is no `else`. */
  | "no_band"
  /** The expression produced a boolean, null or a compound value. */
  | "bad_result";

export interface FormulaIssue {
  readonly kind: FormulaKind;
  /** The derived name, budget id or vital storage key. */
  readonly name: string;
  readonly code: FormulaIssueCode;
  /** The expression language's code for `evaluation_failed`, else null. */
  readonly exprCode: ExprErrorCode | null;
  /** English diagnostic for the pack author. */
  readonly detail: string;
}

type FormatPart = { readonly text: string } | { readonly value: true };

/** A compiled `format:` template: literal text around the result. */
export type Format = readonly FormatPart[];

export interface ExprValue {
  readonly expr: CompiledExpr;
  readonly format: Format | null;
}

export type BandValue = { readonly kind: "literal"; readonly value: DerivedValue } | ({ readonly kind: "expr" } & ExprValue);

export interface Band {
  readonly lo: number;
  readonly hi: number;
  readonly value: BandValue;
}

export type DerivedRule =
  | { readonly kind: "copy_of"; readonly name: string; readonly of: string }
  | { readonly kind: "half_of"; readonly name: string; readonly of: string }
  | { readonly kind: "floor_div"; readonly name: string; readonly of: string; readonly by: number }
  | ({ readonly kind: "expr"; readonly name: string } & ExprValue)
  | {
      readonly kind: "sum_ranges";
      readonly name: string;
      readonly of: readonly string[];
      readonly bands: readonly Band[];
      readonly otherwise: BandValue | null;
    };

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function onlyKeys(packId: string, where: string, raw: Raw, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new SheetSpecError("UNKNOWN_KEY", packId, where, `unknown key '${key}' (allowed: ${allowed.join(", ")})`);
    }
  }
}

function requireInt(packId: string, where: string, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    throw new SheetSpecError("NOT_INTEGER", packId, where, `expected an integer, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function requireName(packId: string, where: string, raw: unknown): string {
  if (typeof raw !== "string" || raw === "") {
    throw new SheetSpecError("BAD_SHAPE", packId, where, "expected a non-empty stat name");
  }
  return raw;
}

/** Compile one formula text with the sheet function set. */
export function compileFormula(packId: string, where: string, raw: unknown): CompiledExpr {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new SheetSpecError("MISSING", packId, where, "expected a non-empty formula");
  }
  try {
    return compile(raw, { functions: FORMULA_FUNCTIONS });
  } catch (error) {
    if (error instanceof ExprError) {
      throw new SheetSpecError("BAD_FORMULA", packId, where, `bad formula ${JSON.stringify(raw)}: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * A `format:` template in the subset of Python's `str.format` packs use: `{}` or `{0}`
 * is the result, `{{` and `}}` are literal braces. Anything else in braces (a field name,
 * a format spec) is refused, so a template can never mean something different here.
 */
export function compileFormat(packId: string, where: string, raw: unknown): Format {
  if (typeof raw !== "string") throw new SheetSpecError("BAD_SHAPE", packId, where, "format must be a string");
  const parts: FormatPart[] = [];
  let text = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === "{" && next === "{") {
      text += "{";
      i += 1;
    } else if (ch === "}" && next === "}") {
      text += "}";
      i += 1;
    } else if (ch === "{") {
      const close = raw.indexOf("}", i);
      const field = close < 0 ? null : raw.slice(i + 1, close);
      if (field !== "" && field !== "0") {
        throw new SheetSpecError("BAD_FORMAT", packId, where, `unsupported placeholder in ${JSON.stringify(raw)}; use {}`);
      }
      if (text !== "") parts.push({ text });
      text = "";
      parts.push({ value: true });
      i = close;
    } else if (ch === "}") {
      throw new SheetSpecError("BAD_FORMAT", packId, where, `single '}' in ${JSON.stringify(raw)}; write '}}'`);
    } else {
      text += ch;
    }
  }
  if (text !== "") parts.push({ text });
  return Object.freeze(parts);
}

function compileExprValue(packId: string, where: string, raw: unknown): ExprValue {
  if (typeof raw === "string") return { expr: compileFormula(packId, where, raw), format: null };
  if (!isRecord(raw)) throw new SheetSpecError("BAD_SHAPE", packId, where, "expected a formula or {expr, format}");
  onlyKeys(packId, where, raw, ["expr", "format"]);
  return Object.freeze({
    expr: compileFormula(packId, `${where}.expr`, raw.expr),
    format: raw.format === undefined ? null : compileFormat(packId, `${where}.format`, raw.format),
  });
}

function compileBandValue(packId: string, where: string, raw: unknown): BandValue {
  if (typeof raw === "string") return { kind: "literal", value: raw };
  if (typeof raw === "number") return { kind: "literal", value: requireInt(packId, where, raw) };
  if (isRecord(raw)) return Object.freeze({ kind: "expr" as const, ...compileExprValue(packId, where, raw) });
  throw new SheetSpecError("BAD_SHAPE", packId, where, "a band value is text, an integer or {expr, format}");
}

const DERIVED_KINDS = ["copy_of", "half_of", "floor_div", "expr", "sum_ranges"] as const;

/** Compile one `derived:` entry. */
export function compileDerivedRule(packId: string, name: string, raw: unknown): DerivedRule {
  const where = `derived.${name}`;
  if (!isRecord(raw)) throw new SheetSpecError("BAD_SHAPE", packId, where, "a derived entry must be a mapping");
  if (Object.hasOwn(raw, "computer") || Object.hasOwn(raw, "computer_group")) {
    throw new SheetSpecError(
      "UNSUPPORTED_COMPUTER",
      packId,
      where,
      "engine-side computers are not available to packs; express the value as a formula",
    );
  }
  const kinds = DERIVED_KINDS.filter((kind) => Object.hasOwn(raw, kind));
  const kind = kinds[0];
  if (kind === undefined || kinds.length > 1) {
    throw new SheetSpecError("BAD_SHAPE", packId, where, `expected exactly one of ${DERIVED_KINDS.join(", ")}`);
  }
  switch (kind) {
    case "copy_of":
    case "half_of":
      onlyKeys(packId, where, raw, [kind]);
      return Object.freeze({ kind, name, of: requireName(packId, `${where}.${kind}`, raw[kind]) });
    case "floor_div": {
      onlyKeys(packId, where, raw, [kind]);
      const params = raw.floor_div;
      if (!isRecord(params)) throw new SheetSpecError("BAD_SHAPE", packId, `${where}.floor_div`, "needs {of, by}");
      onlyKeys(packId, `${where}.floor_div`, params, ["of", "by"]);
      const by = requireInt(packId, `${where}.floor_div.by`, params.by);
      if (by === 0) throw new SheetSpecError("BAD_BOUND", packId, `${where}.floor_div.by`, "cannot divide by 0");
      return Object.freeze({ kind, name, of: requireName(packId, `${where}.floor_div.of`, params.of), by });
    }
    case "expr":
      return Object.freeze({ kind, name, ...compileExprValue(packId, where, raw) });
    case "sum_ranges": {
      onlyKeys(packId, where, raw, [kind]);
      const params = raw.sum_ranges;
      const at = `${where}.sum_ranges`;
      if (!isRecord(params)) throw new SheetSpecError("BAD_SHAPE", packId, at, "needs {of, ranges, else?}");
      onlyKeys(packId, at, params, ["of", "ranges", "else"]);
      if (!Array.isArray(params.of) || params.of.length === 0) {
        throw new SheetSpecError("BAD_SHAPE", packId, `${at}.of`, "expected a non-empty list of stat names");
      }
      const of = params.of.map((item, i) => requireName(packId, `${at}.of.${i}`, item));
      if (!Array.isArray(params.ranges)) throw new SheetSpecError("BAD_SHAPE", packId, `${at}.ranges`, "expected a list");
      const bands = params.ranges.map((entry, i): Band => {
        const here = `${at}.ranges.${i}`;
        if (!Array.isArray(entry) || entry.length !== 3) {
          throw new SheetSpecError("BAD_SHAPE", packId, here, "a band is [lo, hi, value]");
        }
        const lo = requireInt(packId, `${here}.0`, entry[0]);
        const hi = requireInt(packId, `${here}.1`, entry[1]);
        return Object.freeze({ lo, hi, value: compileBandValue(packId, `${here}.2`, entry[2]) });
      });
      const otherwise = params.else === undefined ? null : compileBandValue(packId, `${at}.else`, params.else);
      return Object.freeze({ kind, name, of: Object.freeze(of), bands: Object.freeze(bands), otherwise });
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluating
// ---------------------------------------------------------------------------

/** Thrown inside an evaluation and turned into an issue at its edge. */
class Failure extends Error {
  readonly code: FormulaIssueCode;
  readonly exprCode: ExprErrorCode | null;

  constructor(code: FormulaIssueCode, detail: string, exprCode: ExprErrorCode | null = null) {
    super(detail);
    this.code = code;
    this.exprCode = exprCode;
  }
}

/** How a formula reads a name: a value, or the marker that its own formula failed. */
export type Lookup = (name: string) => DerivedValue | typeof FAILED;
export const FAILED: unique symbol = Symbol("sheets.failed");

function readInt(lookup: Lookup, name: string): number {
  const value = lookup(name);
  if (value === FAILED) throw new Failure("input_failed", `reads '${name}', whose formula failed`);
  if (typeof value !== "number") throw new Failure("not_integer", `reads '${name}', which is text (${JSON.stringify(value)})`);
  return value;
}

function exact(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw new Failure("out_of_range", `${what} is outside the exact integer range`);
  return value === 0 ? 0 : value;
}

/** Floor division on exact integers (Python's `//`), immune to double rounding. */
export function floorDiv(dividend: number, divisor: number): number {
  const a = BigInt(dividend);
  const b = BigInt(divisor);
  let quotient = a / b;
  if (a % b !== 0n && a < 0n !== b < 0n) quotient -= 1n;
  return exact(Number(quotient), "quotient");
}

function runExpr(value: ExprValue, lookup: Lookup): DerivedValue {
  let result: unknown;
  try {
    result = value.expr.evaluate((path) => {
      const read = lookup(path);
      if (read === FAILED) throw new Failure("input_failed", `reads '${path}', whose formula failed`);
      return read;
    });
  } catch (error) {
    if (error instanceof ExprError) throw new Failure("evaluation_failed", error.message, error.code);
    throw error;
  }
  let out: DerivedValue;
  if (typeof result === "number") {
    if (!Number.isInteger(result)) throw new Failure("not_integer", `result ${result} is not an integer`);
    out = exact(result, "result");
  } else if (typeof result === "string") {
    out = result;
  } else {
    throw new Failure("bad_result", `result ${JSON.stringify(result)} is neither a number nor text`);
  }
  if (value.format === null) return out;
  return value.format.map((part) => ("text" in part ? part.text : String(out))).join("");
}

function runBand(value: BandValue, lookup: Lookup): DerivedValue {
  return value.kind === "literal" ? value.value : runExpr(value, lookup);
}

function evaluateRule(rule: DerivedRule, lookup: Lookup): DerivedValue {
  switch (rule.kind) {
    case "copy_of":
      return readInt(lookup, rule.of);
    case "half_of":
      return floorDiv(readInt(lookup, rule.of), 2);
    case "floor_div":
      return floorDiv(readInt(lookup, rule.of), rule.by);
    case "expr":
      return runExpr(rule, lookup);
    case "sum_ranges": {
      let total = 0;
      for (const name of rule.of) total = exact(total + readInt(lookup, name), "sum");
      for (const band of rule.bands) {
        if (band.lo <= total && total <= band.hi) return runBand(band.value, lookup);
      }
      if (rule.otherwise === null) throw new Failure("no_band", `total ${total} falls in no band and there is no else`);
      return runBand(rule.otherwise, lookup);
    }
  }
}

export interface DerivedFold {
  /** Every derived name that evaluated, in declaration order (including names the sheet
   * also stores: their DERIVED value, e.g. a trained skill's untrained base). */
  readonly values: ReadonlyMap<string, DerivedValue>;
  /** Derived names whose formula failed. */
  readonly failed: ReadonlySet<string>;
  readonly issues: readonly FormulaIssue[];
  /**
   * The namespace after the fold: the sheet's own value, else the derived result, else
   * the pack default, else 0 — or `FAILED` for a name only a failed formula would supply.
   */
  readonly lookup: Lookup;
}

/**
 * Fold the derived rules over `source` in declaration order. Each result joins the
 * namespace for later rules, but a value the sheet itself carries always wins as a
 * reference (a trained skill over its derived base). The pipeline is
 * `source → (modifier layer) → derived`; the modifier layer is a reserved, empty
 * insertion point for future effects.
 */
export function foldDerived(
  rules: readonly DerivedRule[],
  source: ReadonlyMap<string, DerivedValue>,
  defaults: ReadonlyMap<string, number>,
): DerivedFold {
  const namespace = new Map<string, DerivedValue>(source);
  const blocked = new Set<string>();
  const values = new Map<string, DerivedValue>();
  const failed = new Set<string>();
  const issues: FormulaIssue[] = [];
  const lookup: Lookup = (name) => {
    const value = namespace.get(name);
    if (value !== undefined) return value;
    if (blocked.has(name)) return FAILED;
    return defaults.get(name) ?? 0;
  };
  for (const rule of rules) {
    try {
      const value = evaluateRule(rule, lookup);
      values.set(rule.name, value);
      if (!source.has(rule.name)) namespace.set(rule.name, value);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      failed.add(rule.name);
      if (!source.has(rule.name)) blocked.add(rule.name);
      issues.push(Object.freeze({ kind: "derived", name: rule.name, code: error.code, exprCode: error.exprCode, detail: error.message }));
    }
  }
  return { values, failed, issues, lookup };
}

export type IntegerOutcome = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly issue: FormulaIssue };

/** Evaluate a standalone formula (a budget part, a vital start) that must yield an integer. */
export function evaluateInteger(kind: FormulaKind, name: string, expr: CompiledExpr, lookup: Lookup): IntegerOutcome {
  try {
    const value = runExpr({ expr, format: null }, lookup);
    if (typeof value !== "number") throw new Failure("not_integer", `result ${JSON.stringify(value)} is text`);
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return { ok: false, issue: Object.freeze({ kind, name, code: error.code, exprCode: error.exprCode, detail: error.message }) };
  }
}
