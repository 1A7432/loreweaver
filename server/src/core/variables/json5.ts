// A bounded JSON5 reader (https://spec.json5.org/), written by hand because `core/` takes
// no new dependency. MagVarUpdate reads `[InitVar]` entries and bracketed command values
// with the `json5` package (`parseString` in MagVarUpdate `util/common.ts`,
// `parseCommandValue` in `src/function/update_variables.ts`), so JSON5 — not a "JSON plus
// a few fixes" approximation — is the grammar authors test against: identifier keys
// include CJK letters, numbers may be hex, `.5`, `+1`, `Infinity` or `NaN`, strings may be
// single-quoted and continue across lines.
//
// Mappings come back as `Map`s in written order (a repeated key keeps its first position
// and takes the last value, as `JSON.parse` does). With `strict` the reader accepts only
// JSON. It never recurses deeper than `MAX_JSON5_DEPTH` and refuses text longer than
// `MAX_JSON5_CHARS`, so hostile input cannot exhaust the stack or the heap.
import type { VarMap, VarValue } from "./tree.ts";

export const MAX_JSON5_DEPTH = 64;
export const MAX_JSON5_CHARS = 2_000_000;

export type Json5Result = { readonly ok: true; readonly value: VarValue } | { readonly ok: false; readonly offset: number };

class Json5Syntax {
  readonly offset: number;
  constructor(offset: number) {
    this.offset = offset;
  }
}

const ID_START = /[\p{L}\p{Nl}$_]/u;
const ID_PART = /[\p{L}\p{Nl}$_\p{Mn}\p{Mc}\p{Nd}\p{Pc}‌‍]/u;
const SPACE_SEPARATOR = /\p{Zs}/u;

export function readJson5(text: string, options: { strict?: boolean } = {}): Json5Result {
  if (text.length > MAX_JSON5_CHARS) return { ok: false, offset: 0 };
  const reader = new Reader(text, options.strict === true);
  try {
    reader.skipSpace();
    const value = reader.value(0);
    reader.skipSpace();
    if (reader.pos < text.length) throw new Json5Syntax(reader.pos);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Json5Syntax) return { ok: false, offset: error.offset };
    throw error;
  }
}

class Reader {
  readonly text: string;
  readonly strict: boolean;
  pos = 0;

  constructor(text: string, strict: boolean) {
    this.text = text;
    this.strict = strict;
  }

  fail(): never {
    throw new Json5Syntax(this.pos);
  }

  skipSpace(): void {
    const text = this.text;
    while (this.pos < text.length) {
      const ch = text[this.pos] as string;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.pos += 1;
        continue;
      }
      if (this.strict) return;
      if (ch === "\v" || ch === "\f" || ch === " " || ch === "﻿" || ch === " " || ch === " " || SPACE_SEPARATOR.test(ch)) {
        this.pos += 1;
        continue;
      }
      if (ch === "/" && text[this.pos + 1] === "/") {
        while (this.pos < text.length && !isLineTerminator(text[this.pos] as string)) this.pos += 1;
        continue;
      }
      if (ch === "/" && text[this.pos + 1] === "*") {
        const end = text.indexOf("*/", this.pos + 2);
        if (end < 0) this.fail();
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  value(depth: number): VarValue {
    if (depth >= MAX_JSON5_DEPTH) this.fail();
    const ch = this.text[this.pos];
    if (ch === "{") return this.object(depth);
    if (ch === "[") return this.array(depth);
    if (ch === '"' || (ch === "'" && !this.strict)) return this.string();
    if (this.text.startsWith("true", this.pos)) return this.literal("true", true);
    if (this.text.startsWith("false", this.pos)) return this.literal("false", false);
    if (this.text.startsWith("null", this.pos)) return this.literal("null", null);
    return this.number();
  }

  literal<T>(word: string, value: T): T {
    this.pos += word.length;
    // `trueish` is not `true` followed by junk the caller would then reject anyway, but
    // stopping here keeps the error offset at the real problem.
    return value;
  }

  object(depth: number): VarMap {
    const out: VarMap = new Map();
    this.pos += 1;
    this.skipSpace();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      const key = this.key();
      this.skipSpace();
      if (this.text[this.pos] !== ":") this.fail();
      this.pos += 1;
      this.skipSpace();
      out.set(key, this.value(depth + 1));
      this.skipSpace();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos += 1;
        this.skipSpace();
        if (this.text[this.pos] === "}" && !this.strict) {
          this.pos += 1;
          return out;
        }
        continue;
      }
      if (next === "}") {
        this.pos += 1;
        return out;
      }
      this.fail();
    }
  }

  array(depth: number): VarValue[] {
    const out: VarValue[] = [];
    this.pos += 1;
    this.skipSpace();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      this.skipSpace();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos += 1;
        this.skipSpace();
        if (this.text[this.pos] === "]" && !this.strict) {
          this.pos += 1;
          return out;
        }
        continue;
      }
      if (next === "]") {
        this.pos += 1;
        return out;
      }
      this.fail();
    }
  }

  key(): string {
    const ch = this.text[this.pos];
    if (ch === '"' || (ch === "'" && !this.strict)) return this.string();
    if (this.strict) this.fail();
    let key = "";
    let first = true;
    while (this.pos < this.text.length) {
      let piece: string;
      if (this.text[this.pos] === "\\") {
        if (this.text[this.pos + 1] !== "u") this.fail();
        this.pos += 2;
        piece = String.fromCharCode(this.hex(4));
      } else {
        const code = this.text.codePointAt(this.pos) as number;
        piece = String.fromCodePoint(code);
        if (!(first ? ID_START : ID_PART).test(piece)) break;
        this.pos += piece.length;
      }
      if (!(first ? ID_START : ID_PART).test(piece)) this.fail();
      key += piece;
      first = false;
    }
    if (key === "") this.fail();
    return key;
  }

  hex(digits: number): number {
    const chunk = this.text.slice(this.pos, this.pos + digits);
    if (chunk.length !== digits || !/^[0-9a-fA-F]+$/.test(chunk)) this.fail();
    this.pos += digits;
    return Number.parseInt(chunk, 16);
  }

  string(): string {
    const quote = this.text[this.pos];
    this.pos += 1;
    let out = "";
    const text = this.text;
    while (this.pos < text.length) {
      const ch = text[this.pos] as string;
      if (ch === quote) {
        this.pos += 1;
        return out;
      }
      if (ch === "\\") {
        this.pos += 1;
        out += this.escape();
        continue;
      }
      if (ch === "\n" || ch === "\r") this.fail();
      if (this.strict && ch < " ") this.fail();
      out += ch;
      this.pos += 1;
    }
    this.fail();
  }

  escape(): string {
    const ch = this.text[this.pos];
    if (ch === undefined) this.fail();
    this.pos += 1;
    switch (ch) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u":
        return String.fromCharCode(this.hex(4));
      default:
        break;
    }
    if (this.strict) this.fail();
    switch (ch) {
      case "'":
        return "'";
      case "v":
        return "\v";
      case "x":
        return String.fromCharCode(this.hex(2));
      case "0":
        if (/[0-9]/.test(this.text[this.pos] ?? "")) this.fail();
        return "\0";
      case "\r":
        if (this.text[this.pos] === "\n") this.pos += 1;
        return "";
      case "\n":
      case " ":
      case " ":
        return "";
      default:
        if (/[1-9]/.test(ch)) this.fail();
        return ch;
    }
  }

  number(): number {
    const text = this.text;
    const start = this.pos;
    let sign = 1;
    if (text[this.pos] === "-" || (text[this.pos] === "+" && !this.strict)) {
      if (text[this.pos] === "-") sign = -1;
      this.pos += 1;
    }
    if (!this.strict) {
      if (text.startsWith("Infinity", this.pos)) {
        this.pos += 8;
        return sign * Number.POSITIVE_INFINITY;
      }
      if (text.startsWith("NaN", this.pos)) {
        this.pos += 3;
        return Number.NaN;
      }
      if (/^0[xX][0-9a-fA-F]/.test(text.slice(this.pos, this.pos + 3))) {
        this.pos += 2;
        const digitsStart = this.pos;
        while (/[0-9a-fA-F]/.test(text[this.pos] ?? "")) this.pos += 1;
        return sign * Number.parseInt(text.slice(digitsStart, this.pos), 16);
      }
    }
    const pattern = this.strict ? /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/ : /^(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
    const match = pattern.exec(text.slice(this.pos, this.pos + 400));
    if (match === null) {
      this.pos = start;
      this.fail();
    }
    this.pos += match[0].length;
    return sign * Number(match[0]);
  }
}

function isLineTerminator(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === " " || ch === " ";
}
