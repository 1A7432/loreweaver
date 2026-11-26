/**
 * Dice notation -> `DiceExpression`.
 *
 * One grammar for every entry point (players' rolls and pack expressions alike):
 *
 *   expr        := comparison
 *   comparison  := additive (("==" | "!=" | ">=" | "<=" | ">" | "<") additive)*
 *   additive    := multiplicative (("+" | "-") multiplicative)*
 *   multiplicative := unary (("*" | "x" | "×" | "//" | "/" | "%") unary)*
 *   unary       := ("+" | "-") unary | atom
 *   atom        := (dice | set | number | slot) label*
 *   dice        := int? "d" (int | "%" | "f") diceop*        (no spaces inside)
 *   diceop      := ("rr" | "ro" | "ra" | "e" | "k" | "p") selector | ("mi" | "ma") int | "!"
 *   set         := "(" [expr ("," expr)* [","]] ")" (("k" | "p") selector)*
 *   selector    := ["h" | "l" | ">" | "<"] int
 *   int         := digits | "{" name "}"
 *   label       := "[" text "]"
 *
 * Decisions carried by this grammar:
 * - SUCCESS POOLS. A `>`, `>=`, `<` or `<=` whose left operand is a dice group (its
 *   operators and labels included: `5d10!>7`, `6d10kh3>=8`) COUNTS the kept dice
 *   meeting the condition; the right operand, any expression, is the threshold
 *   (`5d10>{difficulty}`, `4dF>-1`). The line is the left operand itself: anything
 *   else there compares VALUES and yields 1 or 0. So `(5d10)>6` compares the sum (the
 *   parentheses make it a group, not a dice group), and so do `2d6+3>8` and
 *   `1d20+5>=15` (comparison binds loosest, so the `+3` / `+5` makes the left operand an
 *   arithmetic expression), and `3+5d10>6`. A pool is an ordinary value inside larger
 *   notation: `(5d10>6)+1` adds one to the count. `==` and `!=` always compare values,
 *   after a dice group too: `3d6==10` is 1 when the sum is 10.
 * - A bare `k` keeps the highest (`4d6k3` is `4d6kh3`), the common table meaning; a bare
 *   `p` and the other operators select dice EQUAL to the number.
 * - `x`, `X` and `×` multiply (`3d6x5`), as character-creation formulas write it.
 * - `!` explodes on the die's highest face, anywhere a dice operator may stand; `!!` is
 *   refused rather than guessed (other tools read it as compounding).
 * - Letters are case-insensitive outside labels and slot names. Full-width ASCII forms
 *   (U+FF01-U+FF5E) and the ideographic space read as their ASCII counterparts, because
 *   CJK input methods produce them (`１d20＋5`). Labels keep their text as typed.
 * - `d%` is `d100` (1-100) and is written back as `d100`.
 * - A count may be omitted: `d20` is one die, but a bare `dF` is FOUR Fate dice (the
 *   Fate standard roll); an explicit count means what it says (`1dF`, `0dF`).
 * - Whitespace is allowed between tokens, never inside a dice group.
 */

import { DiceError, LIMITS } from "./errors.ts";
import type { BinaryOp, ComparisonOp, DiceExpr, DiceExpression, DiceOp, DiceOpName, Expr, IntTerm, Selector, SelectorCategory, SidesTerm } from "./types.ts";

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);
const COMPARISONS: readonly ComparisonOp[] = ["==", "!=", ">=", "<=", ">", "<"];
const SLOT_NAME_START = /^[\p{L}_]$/u;
const SLOT_NAME_PART = /^[\p{L}\p{N}_]$/u;

/** One code point as the grammar reads it: full-width forms folded to ASCII, letters lower-cased. */
function fold(cp: string): string {
  const code = cp.codePointAt(0) ?? 0;
  if (code === 0x3000) return " ";
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0).toLowerCase();
  if (code === 0xd7) return "x";
  return cp.toLowerCase();
}

class Parser {
  readonly #raw: readonly string[];
  readonly #src: readonly string[];
  #pos = 0;
  #depth = 0;

  constructor(text: string) {
    this.#raw = Array.from(text);
    this.#src = this.#raw.map(fold);
  }

  parse(): Expr {
    if (this.#raw.length > LIMITS.maxNotationLength) throw new DiceError("TOO_LONG", LIMITS.maxNotationLength);
    this.#ws();
    if (this.#pos >= this.#src.length) throw new DiceError("EMPTY");
    const root = this.#comparison();
    this.#ws();
    if (this.#pos < this.#src.length) this.#fail();
    return root;
  }

  #fail(): never {
    throw new DiceError("SYNTAX", this.#pos);
  }

  #peek(offset = 0): string {
    return this.#src[this.#pos + offset] ?? "";
  }

  #ws(): void {
    while (WHITESPACE.has(this.#peek())) this.#pos++;
  }

  #eat(token: string): boolean {
    for (let i = 0; i < token.length; i++) if (this.#peek(i) !== token[i]) return false;
    this.#pos += token.length;
    return true;
  }

  #enter(): void {
    if (++this.#depth > LIMITS.maxDepth) throw new DiceError("TOO_DEEP", this.#pos);
  }

  #comparison(): Expr {
    let left = this.#additive();
    for (;;) {
      this.#ws();
      const op = COMPARISONS.find((candidate) => this.#eat(candidate));
      if (op === undefined) return left;
      this.#ws();
      const right = this.#additive();
      if (left.kind === "dice" && op !== "==" && op !== "!=") left = { kind: "pool", dice: left, comparison: op, threshold: right };
      else left = { kind: "binary", op, left, right };
    }
  }

  #additive(): Expr {
    let left = this.#multiplicative();
    for (;;) {
      this.#ws();
      const c = this.#peek();
      if (c !== "+" && c !== "-") return left;
      this.#pos++;
      this.#ws();
      left = { kind: "binary", op: c, left, right: this.#multiplicative() };
    }
  }

  #multiplicative(): Expr {
    let left = this.#unary();
    for (;;) {
      this.#ws();
      let op: BinaryOp;
      if (this.#eat("//")) op = "//";
      else if (this.#eat("/")) op = "/";
      else if (this.#eat("*") || this.#eat("x")) op = "*";
      else if (this.#eat("%")) op = "%";
      else return left;
      this.#ws();
      left = { kind: "binary", op, left, right: this.#unary() };
    }
  }

  #unary(): Expr {
    const c = this.#peek();
    if (c === "+" || c === "-") {
      this.#enter();
      this.#pos++;
      this.#ws();
      const operand = this.#unary();
      this.#depth--;
      return { kind: "unary", op: c, operand };
    }
    return this.#atom();
  }

  #atom(): Expr {
    const c = this.#peek();
    if (c === "(") return this.#set();
    if (c === "d" || c === "{" || isDigit(c) || c === ".") {
      const start = this.#pos;
      const count = c === "d" ? null : this.#intTerm(true);
      if (this.#peek() === "d") return this.#dice(count);
      // Not a dice group: re-read a plain number, which may be a decimal.
      if (count?.kind === "slot") return { kind: "slot", name: count.name, labels: this.#labels() };
      this.#pos = start;
      return { kind: "number", value: this.#number(), labels: this.#labels() };
    }
    this.#fail();
  }

  #number(): number {
    const start = this.#pos;
    while (isDigit(this.#peek())) this.#pos++;
    if (this.#peek() === ".") {
      this.#pos++;
      while (isDigit(this.#peek())) this.#pos++;
    }
    const text = this.#src.slice(start, this.#pos).join("");
    if (text === "." || text === "") {
      this.#pos = start;
      this.#fail();
    }
    const value = Number(text);
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new DiceError("VALUE_TOO_LARGE", start);
    return value;
  }

  /** Digits or a `{slot}`. With `optional`, returns null when neither starts here. */
  #intTerm(optional: true): IntTerm | null;
  #intTerm(optional?: false): IntTerm;
  #intTerm(optional = false): IntTerm | null {
    const start = this.#pos;
    if (this.#peek() === "{") {
      this.#pos++;
      const nameStart = this.#pos;
      if (!SLOT_NAME_START.test(this.#raw[this.#pos] ?? "")) this.#fail();
      while (SLOT_NAME_PART.test(this.#raw[this.#pos] ?? "")) this.#pos++;
      const name = this.#raw.slice(nameStart, this.#pos).join("");
      if (!this.#eat("}")) this.#fail();
      return { kind: "slot", name };
    }
    if (!isDigit(this.#peek())) {
      if (optional) return null;
      this.#fail();
    }
    while (isDigit(this.#peek())) this.#pos++;
    const value = Number(this.#src.slice(start, this.#pos).join(""));
    if (!Number.isSafeInteger(value)) throw new DiceError("VALUE_TOO_LARGE", start);
    return { kind: "int", value };
  }

  #dice(count: IntTerm | null): DiceExpr {
    this.#pos++; // the "d"
    let sides: SidesTerm;
    // `d%` is the percentile die, exactly `d100` (standard notation; the d20 library's
    // tens-die reading of it is a quirk players read as broken).
    if (this.#eat("%")) sides = { kind: "int", value: 100 };
    else if (this.#eat("f")) sides = { kind: "fate" };
    else sides = this.#intTerm();
    const ops = this.#ops(true);
    // A bare `dF` is the Fate system's standard roll of four dice, which is what players
    // have always got from it; recording the count makes the canonical form `4dF`.
    const fateDefault: IntTerm | null = count === null && sides.kind === "fate" ? { kind: "int", value: 4 } : count;
    return { kind: "dice", count: fateDefault, sides, ops, labels: this.#labels() };
  }

  #ops(dice: boolean): DiceOp[] {
    const ops: { op: DiceOpName; selectors: Selector[] }[] = [];
    for (;;) {
      let op: DiceOpName;
      let selector: Selector;
      if (dice && this.#peek() === "!" && (this.#peek(1) !== "=" || this.#peek(2) === "=")) {
        this.#pos++;
        if (this.#peek() === "!") this.#fail();
        op = "e";
        selector = { category: "=", count: { kind: "max" } };
      } else {
        const name = dice ? (["rr", "ro", "ra", "mi", "ma", "e", "k", "p"] as const).find((n) => this.#eat(n)) : (["k", "p"] as const).find((n) => this.#eat(n));
        if (name === undefined) break;
        op = name;
        selector = this.#selector(op);
      }
      const last = ops[ops.length - 1];
      if (last !== undefined && last.op === op && op !== "mi" && op !== "ma") last.selectors.push(selector);
      else ops.push({ op, selectors: [selector] });
    }
    return ops;
  }

  #selector(op: DiceOpName): Selector {
    let category: SelectorCategory = op === "k" ? "h" : "=";
    const c = this.#peek();
    if (op !== "mi" && op !== "ma" && (c === "h" || c === "l" || c === ">" || c === "<")) {
      category = c;
      this.#pos++;
    }
    return { category, count: this.#intTerm() };
  }

  #set(): Expr {
    this.#enter();
    this.#pos++; // "("
    this.#ws();
    const items: Expr[] = [];
    let comma = false;
    if (this.#peek() !== ")") {
      for (;;) {
        items.push(this.#comparison());
        this.#ws();
        if (!this.#eat(",")) break;
        comma = true;
        this.#ws();
        if (this.#peek() === ")") break;
      }
    }
    if (!this.#eat(")")) this.#fail();
    this.#depth--;
    const ops = this.#ops(false);
    const labels = this.#labels();
    const only = items[0];
    if (items.length === 1 && !comma && only !== undefined) return { kind: "group", inner: only, ops, labels };
    return { kind: "set", items, ops, labels };
  }

  #labels(): string[] {
    const labels: string[] = [];
    for (;;) {
      const before = this.#pos;
      this.#ws();
      if (this.#peek() !== "[") {
        this.#pos = before;
        return labels;
      }
      const open = this.#pos;
      const close = this.#src.indexOf("]", open + 1);
      const newline = this.#src.indexOf("\n", open + 1);
      if (close < 0 || (newline >= 0 && newline < close)) throw new DiceError("SYNTAX", open);
      labels.push(this.#raw.slice(open + 1, close).join(""));
      this.#pos = close + 1;
    }
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9" && c.length === 1;
}

/** Parses dice notation. Throws `DiceError` (`EMPTY`, `SYNTAX`, `TOO_LONG`, `TOO_DEEP`, `VALUE_TOO_LARGE`). */
export function parseDice(notation: string): DiceExpression {
  const root = new Parser(notation).parse();
  return { notation: formatExpr(root), root };
}

// ---------------------------------------------------------------------------
// Canonical notation
// ---------------------------------------------------------------------------

/** A number as notation: never in exponent form, which the grammar does not read. */
export function formatNumber(value: number): string {
  const text = String(value);
  if (!text.includes("e")) return text;
  return value.toFixed(20).replace(/\.?0+$/, "");
}

export function formatIntTerm(term: IntTerm): string {
  return term.kind === "int" ? String(term.value) : `{${term.name}}`;
}

/** Canonical text of a list of operations (`kh3`, `rr1rr2`, `!`). */
export function formatOps(ops: readonly DiceOp[]): string {
  let out = "";
  for (const { op, selectors } of ops) {
    for (const { category, count } of selectors) {
      if (count.kind === "max") out += "!";
      else out += op + (category === "=" ? "" : category) + formatIntTerm(count);
    }
  }
  return out;
}

function formatLabels(labels: readonly string[]): string {
  return labels.map((label) => ` [${label}]`).join("");
}

function formatSides(sides: SidesTerm): string {
  if (sides.kind === "fate") return "F";
  return formatIntTerm(sides);
}

/** Canonical notation of a parsed tree; it parses back to the same tree. */
export function formatExpr(expr: Expr): string {
  switch (expr.kind) {
    case "number":
      return formatNumber(expr.value) + formatLabels(expr.labels);
    case "slot":
      return `{${expr.name}}` + formatLabels(expr.labels);
    case "dice":
      return `${expr.count === null ? "" : formatIntTerm(expr.count)}d${formatSides(expr.sides)}${formatOps(expr.ops)}${formatLabels(expr.labels)}`;
    case "set": {
      const inside = expr.items.map(formatExpr).join(", ");
      return `(${inside}${expr.items.length === 1 ? "," : ""})${formatOps(expr.ops)}${formatLabels(expr.labels)}`;
    }
    case "group":
      return `(${formatExpr(expr.inner)})${formatOps(expr.ops)}${formatLabels(expr.labels)}`;
    case "unary":
      return expr.op + formatExpr(expr.operand);
    case "binary":
      return `${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)}`;
    case "pool":
      return `${formatExpr(expr.dice)} ${expr.comparison} ${formatExpr(expr.threshold)}`;
  }
}
