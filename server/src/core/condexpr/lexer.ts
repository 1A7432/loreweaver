import { ExprError } from "./errors.ts";

/**
 * Source text → tokens. The token set is closed: anything else is an error with its
 * position, never silently skipped.
 */

export const MAX_SOURCE_LENGTH = 500;
export const MAX_TOKENS = 200;

export type Token =
  | { readonly kind: "num"; readonly value: number; readonly text: string; readonly pos: number }
  | { readonly kind: "str"; readonly value: string; readonly pos: number }
  | { readonly kind: "kw"; readonly value: boolean | null; readonly pos: number }
  | { readonly kind: "ident"; readonly value: string; readonly pos: number }
  | { readonly kind: "op"; readonly value: string; readonly pos: number };

// Longest first, so `===` is never read as `==` followed by `=`.
const OPERATORS = [
  "===", "!==", "==", "!=", ">=", "<=", "&&", "||",
  ">", "<", "!", "(", ")", "[", "]", ".", ",", "+", "-", "*", "/", "%",
] as const;

// Keywords and word operators match case-insensitively (`TRUE`, `None`, `And`): the
// SillyTavern cards these conditions come from are written by hand in every casing, and
// the client-side evaluator of the portable subset reads them the same way. A `Map`, not
// an object literal, so a name like `constructor` can never hit an inherited member.
const KEYWORDS: ReadonlyMap<string, boolean | null> = new Map<string, boolean | null>([
  ["true", true],
  ["false", false],
  ["null", null],
  ["undefined", null],
  ["none", null],
]);
const WORD_OPERATORS: ReadonlyMap<string, string> = new Map([
  ["and", "&&"],
  ["or", "||"],
  ["not", "!"],
]);

// A letter (any script, CJK included) or underscore, then letters, digits, underscores.
// The `u` flag makes `\p{…}` work and makes the match step over surrogate pairs, so an
// astral CJK character is one identifier character, not two broken halves.
const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/uy;
// Digits are ASCII only: a full-width `１` is not a number literal.
const DECIMAL = /[0-9]+(?:\.[0-9]+)?/y;
const INTEGER = /[0-9]+/y;
const SPACE = /\s/u;

function matchAt(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  return match === null ? null : match[0];
}

/** Decimal digits of a path segment without leading zeros (`a.007` and `a[7]` both name `a.7`). */
export function canonicalIndex(digits: string): string {
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

export function tokenize(text: string): Token[] {
  // UTF-16 length, the unit the client-side evaluator measures in: an expression the
  // server accepts must never be one a client refuses for its size.
  if (text.length > MAX_SOURCE_LENGTH) {
    throw new ExprError("TOO_LONG", `expression too long (${text.length} > ${MAX_SOURCE_LENGTH})`, MAX_SOURCE_LENGTH);
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (SPACE.test(ch)) {
      i += 1;
      continue;
    }
    if (tokens.length >= MAX_TOKENS) {
      throw new ExprError("TOO_MANY_TOKENS", `expression has more than ${MAX_TOKENS} tokens`, i);
    }
    if (ch === "'" || ch === '"') {
      const [value, next] = readString(text, i);
      tokens.push({ kind: "str", value, pos: i });
      i = next;
      continue;
    }
    const previous = tokens[tokens.length - 1];
    // Right after a `.` a number can only be a path segment (`party.0.hp`), so read an
    // integer there and leave the next `.` to the path. Reading a decimal would turn
    // `a.1.0` into the segment `1.0` — which is how the reference evaluator came to
    // resolve `a.1.0` as `a.1`.
    const afterDot = previous !== undefined && previous.kind === "op" && previous.value === ".";
    const digits = matchAt(afterDot ? INTEGER : DECIMAL, text, i);
    if (digits !== null) {
      tokens.push({ kind: "num", value: Number(digits), text: digits, pos: i });
      i += digits.length;
      continue;
    }
    const word = matchAt(IDENTIFIER, text, i);
    if (word !== null) {
      const lowered = word.toLowerCase();
      const wordOperator = WORD_OPERATORS.get(lowered);
      if (wordOperator !== undefined) tokens.push({ kind: "op", value: wordOperator, pos: i });
      else if (KEYWORDS.has(lowered)) tokens.push({ kind: "kw", value: KEYWORDS.get(lowered) ?? null, pos: i });
      else tokens.push({ kind: "ident", value: word, pos: i });
      i += word.length;
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (op === undefined) {
      const shown = String.fromCodePoint(text.codePointAt(i) ?? 0);
      throw new ExprError("UNEXPECTED_CHARACTER", `unexpected character ${JSON.stringify(shown)}`, i);
    }
    tokens.push({ kind: "op", value: op, pos: i });
    i += op.length;
  }
  return tokens;
}

/**
 * A quoted string. A backslash takes the next character literally (`\'`, `\\`; `\n` is
 * the letter n): the reference grammar has no escape sequences beyond that, and the
 * client-side evaluator reads strings the same way.
 */
function readString(text: string, start: number): [string, number] {
  const quote = text[start];
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return [out, i + 1];
    out += ch;
    i += 1;
  }
  throw new ExprError("UNTERMINATED_STRING", "unterminated string literal", start);
}
