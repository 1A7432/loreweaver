// The portable `visible_when` condition evaluator (protocol 2.1, M19 item 7).
//
// A panel block may carry `visible_when: "<condition>"` — a value gate `{$var}`'s
// absent-means-hide cannot express ("show once day >= 46"). Values move at runtime, so
// no server-side per-viewer filter could do this; it is evaluated HERE, against the
// viewer's own `state.variables`. That makes every client an implementation of the same
// grammar, so this file implements a deliberately SMALL subset and the server refuses
// at build time anything outside it:
//
//   comparisons  === !== == != >= <= > <
//   logic        && || !   (and the word forms and/or/not)
//   literals     numbers, 'strings', "strings", true/false/null/undefined
//   references   bare dotted paths, CJK included — looked up by variable id
//   grouping     ( )
//
// Arithmetic, function calls (including `getvar`) and bracket segments are OUT. Each is
// a place two evaluators could quietly disagree, and a silent disagreement about
// visibility is exactly the bug this file exists to prevent.
//
// Semantics MATCH the reference implementation (`core/condexpr.py`) rather than
// JavaScript's own operators — notably `"abc" > 5` THROWS here (JS would answer false),
// and a bool is never `===` a number. `tests/fixtures/visible_when_vectors.json` is the
// shared conformance table both sides run.

export class CondExprError extends Error {}

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "kw"; value: boolean | null }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }

export type Resolver = (path: string) => unknown

const MAX_EXPR_LEN = 500
const MAX_TOKENS = 200

// Longest-first, so `===` is never read as `==` followed by `=`.
const OPERATORS = ["===", "!==", "==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "(", ")", "."]

const KEYWORDS: Record<string, boolean | null> = {
  true: true,
  false: false,
  null: null,
  undefined: null,
  none: null,
}
const WORD_OPS: Record<string, string> = { and: "&&", or: "||", not: "!" }

// Identifier: any letter (CJK included) or underscore, then letters/digits/underscores.
// `\p{L}` needs the `u` flag; a leading digit is never an identifier.
const IDENT_START = /[\p{L}_]/u
const IDENT_PART = /[\p{L}\p{N}_]/u
const DIGIT = /[0-9]/

function tokenize(text: string): Token[] {
  if (text.length > MAX_EXPR_LEN) throw new CondExprError(`expression too long (${text.length} > ${MAX_EXPR_LEN})`)
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (tokens.length >= MAX_TOKENS) throw new CondExprError("expression has too many tokens")
    if (ch === "'" || ch === '"') {
      const [value, next] = readString(text, i)
      tokens.push({ kind: "str", value })
      i = next
      continue
    }
    if (DIGIT.test(ch)) {
      let end = i
      while (end < text.length && DIGIT.test(text[end]!)) end += 1
      if (text[end] === "." && DIGIT.test(text[end + 1] ?? "")) {
        end += 1
        while (end < text.length && DIGIT.test(text[end]!)) end += 1
      }
      tokens.push({ kind: "num", value: Number(text.slice(i, end)) })
      i = end
      continue
    }
    if (IDENT_START.test(ch)) {
      let end = i
      while (end < text.length && IDENT_PART.test(text[end]!)) end += 1
      const word = text.slice(i, end)
      const lowered = word.toLowerCase()
      if (lowered in WORD_OPS) tokens.push({ kind: "op", value: WORD_OPS[lowered]! })
      else if (lowered in KEYWORDS) tokens.push({ kind: "kw", value: KEYWORDS[lowered]! })
      else tokens.push({ kind: "ident", value: word })
      i = end
      continue
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i))
    if (!op) throw new CondExprError(`unexpected character ${JSON.stringify(ch)} at position ${i}`)
    tokens.push({ kind: "op", value: op })
    i += op.length
  }
  return tokens
}

function readString(text: string, start: number): [string, number] {
  const quote = text[start]
  let out = ""
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === "\\" && i + 1 < text.length) {
      out += text[i + 1]
      i += 2
      continue
    }
    if (ch === quote) return [out, i + 1]
    out += ch
    i += 1
  }
  throw new CondExprError("unterminated string literal")
}

/** JS-ish truthiness, matching the reference: 0, "", null/undefined, false and empty
 * arrays are falsy. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

/** `value` as a number when it plainly IS one (a numeric string counts), else null.
 * Booleans count as 0/1 — the reference coerces them the same way. */
function asNumber(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const text = value.trim()
    if (text === "") return null
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function compare(op: string, left: unknown, right: unknown): boolean {
  if (op === "===" || op === "!==") {
    // Same TYPE and same value. A bool is never strictly equal to a number here,
    // matching the reference implementation's explicit bool guard.
    const strict = typeof left === typeof right && left === right
    return op === "===" ? strict : !strict
  }
  if (op === "==" || op === "!=") {
    let equal = left === right
    if (!equal) {
      const leftNum = asNumber(left)
      const rightNum = asNumber(right)
      if (leftNum !== null && rightNum !== null) equal = leftNum === rightNum
    }
    return op === "==" ? equal : !equal
  }
  const leftNum = asNumber(left)
  const rightNum = asNumber(right)
  let a: unknown = left
  let b: unknown = right
  if (leftNum !== null && rightNum !== null) {
    a = leftNum
    b = rightNum
  } else if (!(typeof left === "string" && typeof right === "string")) {
    // Deliberately an ERROR, not JS's silent `false`: the caller hides the block.
    throw new CondExprError(`cannot order ${JSON.stringify(left)} and ${JSON.stringify(right)}`)
  }
  if (op === ">") return (a as number) > (b as number)
  if (op === "<") return (a as number) < (b as number)
  if (op === ">=") return (a as number) >= (b as number)
  return (a as number) <= (b as number)
}

class Evaluator {
  private pos = 0

  constructor(
    private readonly tokens: Token[],
    private resolve: Resolver,
  ) {}

  evaluate(): unknown {
    const value = this.orExpr()
    if (this.peek() !== undefined) throw new CondExprError("unexpected trailing token")
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private next(): Token {
    const token = this.peek()
    if (token === undefined) throw new CondExprError("unexpected end of expression")
    this.pos += 1
    return token
  }

  private acceptOp(...ops: string[]): string | undefined {
    const token = this.peek()
    if (token !== undefined && token.kind === "op" && ops.includes(token.value)) {
      this.pos += 1
      return token.value
    }
    return undefined
  }

  private expectOp(op: string): void {
    if (this.acceptOp(op) === undefined) throw new CondExprError(`expected ${op}`)
  }

  private orExpr(): unknown {
    let value = this.andExpr()
    while (this.acceptOp("||")) {
      if (truthy(value)) this.skip(() => this.andExpr())
      else value = this.andExpr()
    }
    return value
  }

  private andExpr(): unknown {
    let value = this.notExpr()
    while (this.acceptOp("&&")) {
      if (truthy(value)) value = this.notExpr()
      else this.skip(() => this.notExpr())
    }
    return value
  }

  private notExpr(): unknown {
    if (this.acceptOp("!")) return !truthy(this.notExpr())
    return this.comparison()
  }

  private comparison(): unknown {
    const left = this.primary()
    const op = this.acceptOp("===", "!==", "==", "!=", ">=", "<=", ">", "<")
    if (op === undefined) return left
    return compare(op, left, this.primary())
  }

  private primary(): unknown {
    if (this.acceptOp("(")) {
      const value = this.orExpr()
      this.expectOp(")")
      return value
    }
    const token = this.next()
    if (token.kind === "num" || token.kind === "str" || token.kind === "kw") return token.value
    if (token.kind === "ident") return this.reference(token.value)
    throw new CondExprError("unexpected token")
  }

  private reference(first: string): unknown {
    const segments = [first]
    while (this.acceptOp(".")) {
      const part = this.next()
      if (part.kind !== "ident" && part.kind !== "num") throw new CondExprError("bad path segment")
      segments.push(String(part.value))
    }
    return this.resolve(segments.join("."))
  }

  /** Parse a short-circuited branch without resolving it. References answer the same
   * benign probe the reference implementation uses, so `false && x > 5` short-circuits
   * cleanly instead of blowing up on an unorderable placeholder. */
  private skip(parse: () => unknown): void {
    const resolve = this.resolve
    this.resolve = () => 1
    try {
      parse()
    } finally {
      this.resolve = resolve
    }
  }
}

/** Evaluate `expression` against `resolve`, raising `CondExprError` on any problem. */
export function evaluate(expression: string, resolve: Resolver): unknown {
  const tokens = tokenize(expression)
  if (tokens.length === 0) throw new CondExprError("empty expression")
  return new Evaluator(tokens, resolve).evaluate()
}

/** `evaluate` folded through truthiness. */
export function evaluateBool(expression: string, resolve: Resolver): boolean {
  return truthy(evaluate(expression, resolve))
}

/** The renderer's entry point: whether a block carrying `visible_when` should show.
 *
 * FAIL-CLOSED — an unevaluatable condition hides its block. A condition that cannot be
 * decided must not decide in favour of showing something the author gated. */
export function isVisible(condition: string | undefined, resolve: Resolver): boolean {
  if (condition === undefined) return true
  try {
    return evaluateBool(condition, resolve)
  } catch {
    return false
  }
}
