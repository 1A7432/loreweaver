import { ExprError } from "./errors.ts";
import { canonicalIndex, type Token, tokenize } from "./lexer.ts";
import { checkedNumber } from "./values.ts";

/**
 * Tokens → syntax tree, by recursive descent. Precedence, loosest first:
 *
 *   or      := and ( "||" and )*                     left-associative
 *   and     := not ( "&&" not )*                     left-associative
 *   not     := "!" not | compare
 *   compare := sum [ ( === !== == != >= <= > < ) sum ]   at most ONE: `a < b < c` is an error
 *   sum     := term ( ( "+" | "-" ) term )*          left-associative
 *   term    := unary ( ( "*" | "/" | "%" ) unary )*  left-associative
 *   unary   := "-" unary | primary
 *   primary := number | string | keyword | "(" or ")" | call | getvar | path
 *   call    := NAME "(" [ or ( "," or )* ] ")"       NAME one of the enabled functions
 *   getvar  := "getvar" "(" string ( "," or )* ")"   arguments after the first are ignored
 *   path    := NAME ( "." ( NAME | INT ) | "[" ( STRING | INT ) "]" )*
 *
 * Note `!` binds LOOSER than comparison: `!a == b` is `!(a == b)`. That is the
 * reference grammar's reading (and the client-side evaluator's), not JavaScript's.
 */

/**
 * How deeply parentheses, `!`, unary `-` and call arguments may nest. Operator CHAINS
 * (`a || b || c …`) do not nest; their length is bounded by the token cap, and so is the
 * size of the whole tree (every node consumes at least one token). Together the two caps
 * bound the parser's and the evaluator's recursion.
 */
export const MAX_DEPTH = 32;

export type FunctionName = "floor" | "ceil" | "min" | "max" | "abs" | "if";
export const FUNCTION_NAMES: readonly FunctionName[] = ["floor", "ceil", "min", "max", "abs", "if"];

// [minimum, maximum] argument counts.
const ARITY: ReadonlyMap<FunctionName, readonly [number, number]> = new Map<FunctionName, readonly [number, number]>([
  ["floor", [1, 1]],
  ["ceil", [1, 1]],
  ["abs", [1, 1]],
  ["min", [1, Number.POSITIVE_INFINITY]],
  ["max", [1, Number.POSITIVE_INFINITY]],
  ["if", [3, 3]],
]);

export type CompareOp = "===" | "!==" | "==" | "!=" | ">=" | "<=" | ">" | "<";
export type ArithmeticOp = "+" | "-" | "*" | "/" | "%";

export type Node =
  | { readonly type: "literal"; readonly value: null | boolean | number | string; readonly pos: number }
  | { readonly type: "path"; readonly path: string; readonly pos: number }
  | { readonly type: "getvar"; readonly path: string; readonly ignored: readonly Node[]; readonly pos: number }
  | { readonly type: "call"; readonly name: FunctionName; readonly args: readonly Node[]; readonly pos: number }
  | { readonly type: "not"; readonly operand: Node; readonly pos: number }
  | { readonly type: "negate"; readonly operand: Node; readonly pos: number }
  | { readonly type: "logic"; readonly op: "&&" | "||"; readonly left: Node; readonly right: Node; readonly pos: number }
  | { readonly type: "compare"; readonly op: CompareOp; readonly left: Node; readonly right: Node; readonly pos: number }
  | { readonly type: "arith"; readonly op: ArithmeticOp; readonly left: Node; readonly right: Node; readonly pos: number };

export interface ParseOptions {
  readonly functions: ReadonlySet<FunctionName>;
  readonly portable: boolean;
}

export interface Parsed {
  readonly root: Node;
  /** The first construct outside the portable subset, or null when there is none. */
  readonly nonPortable: { readonly what: string; readonly pos: number } | null;
}

const COMPARE_OPS: readonly string[] = ["===", "!==", "==", "!=", ">=", "<=", ">", "<"];

export function parse(source: string, options: ParseOptions): Parsed {
  const tokens = tokenize(source);
  if (tokens.length === 0) throw new ExprError("EMPTY", "empty expression", 0);
  return new Parser(source, tokens, options).run();
}

class Parser {
  readonly #source: string;
  readonly #tokens: readonly Token[];
  readonly #options: ParseOptions;
  #pos = 0;
  #nesting = 0;
  #nonPortable: { what: string; pos: number } | null = null;

  constructor(source: string, tokens: readonly Token[], options: ParseOptions) {
    this.#source = source;
    this.#tokens = tokens;
    this.#options = options;
  }

  run(): Parsed {
    const root = this.#or();
    const trailing = this.#peek();
    if (trailing !== undefined) {
      if (trailing.kind === "op" && COMPARE_OPS.includes(trailing.value)) {
        throw new ExprError("CHAINED_COMPARISON", "comparisons do not chain; join them with &&", trailing.pos);
      }
      throw new ExprError("UNEXPECTED_TOKEN", `unexpected ${show(trailing)}`, trailing.pos);
    }
    return { root, nonPortable: this.#nonPortable };
  }

  // -- tokens -------------------------------------------------------------

  #peek(): Token | undefined {
    return this.#tokens[this.#pos];
  }

  #next(): Token {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new ExprError("UNEXPECTED_END", "unexpected end of expression", this.#source.length);
    this.#pos += 1;
    return token;
  }

  #acceptOp(...ops: readonly string[]): Token | undefined {
    const token = this.#peek();
    if (token !== undefined && token.kind === "op" && ops.includes(token.value)) {
      this.#pos += 1;
      return token;
    }
    return undefined;
  }

  #expectOp(op: string): void {
    if (this.#acceptOp(op) !== undefined) return;
    const found = this.#peek();
    if (found === undefined) throw new ExprError("UNEXPECTED_END", `expected ${JSON.stringify(op)}`, this.#source.length);
    throw new ExprError("UNEXPECTED_TOKEN", `expected ${JSON.stringify(op)}, found ${show(found)}`, found.pos);
  }

  // -- bookkeeping --------------------------------------------------------

  /** One level of nesting (see `MAX_DEPTH`). */
  #enter(pos: number): void {
    this.#nesting += 1;
    if (this.#nesting > MAX_DEPTH) throw new ExprError("TOO_DEEP", `expression nests deeper than ${MAX_DEPTH}`, pos);
  }

  #leave(): void {
    this.#nesting -= 1;
  }

  #outsideSubset(what: string, pos: number): void {
    if (this.#options.portable) throw new ExprError("OUTSIDE_SUBSET", `${what} is outside the portable subset`, pos);
    this.#nonPortable ??= { what, pos };
  }

  // -- grammar ------------------------------------------------------------

  #or(): Node {
    let left = this.#and();
    for (let op = this.#acceptOp("||"); op !== undefined; op = this.#acceptOp("||")) {
      const right = this.#and();
      left = { type: "logic", op: "||", left, right, pos: op.pos };
    }
    return left;
  }

  #and(): Node {
    let left = this.#not();
    for (let op = this.#acceptOp("&&"); op !== undefined; op = this.#acceptOp("&&")) {
      const right = this.#not();
      left = { type: "logic", op: "&&", left, right, pos: op.pos };
    }
    return left;
  }

  #not(): Node {
    const bang = this.#acceptOp("!");
    if (bang === undefined) return this.#compare();
    this.#enter(bang.pos);
    const operand = this.#not();
    this.#leave();
    return { type: "not", operand, pos: bang.pos };
  }

  #compare(): Node {
    const left = this.#sum();
    const op = this.#acceptOp(...COMPARE_OPS);
    if (op === undefined) return left;
    const right = this.#sum();
    return { type: "compare", op: op.value as CompareOp, left, right, pos: op.pos };
  }

  #sum(): Node {
    let left = this.#term();
    for (let op = this.#acceptOp("+", "-"); op !== undefined; op = this.#acceptOp("+", "-")) {
      this.#outsideSubset(`${JSON.stringify(op.value)} (arithmetic)`, op.pos);
      const right = this.#term();
      left = { type: "arith", op: op.value as ArithmeticOp, left, right, pos: op.pos };
    }
    return left;
  }

  #term(): Node {
    let left = this.#unary();
    for (let op = this.#acceptOp("*", "/", "%"); op !== undefined; op = this.#acceptOp("*", "/", "%")) {
      this.#outsideSubset(`${JSON.stringify(op.value)} (arithmetic)`, op.pos);
      const right = this.#unary();
      left = { type: "arith", op: op.value as ArithmeticOp, left, right, pos: op.pos };
    }
    return left;
  }

  #unary(): Node {
    const minus = this.#acceptOp("-");
    if (minus === undefined) return this.#primary();
    this.#outsideSubset("unary minus (arithmetic)", minus.pos);
    this.#enter(minus.pos);
    const operand = this.#unary();
    this.#leave();
    return { type: "negate", operand, pos: minus.pos };
  }

  #primary(): Node {
    const open = this.#acceptOp("(");
    if (open !== undefined) {
      this.#enter(open.pos);
      const inner = this.#or();
      this.#expectOp(")");
      this.#leave();
      return inner;
    }
    const token = this.#next();
    switch (token.kind) {
      case "num":
        return { type: "literal", value: this.#numberLiteral(token), pos: token.pos };
      case "str":
      case "kw":
        return { type: "literal", value: token.value, pos: token.pos };
      case "ident": {
        const following = this.#peek();
        if (following !== undefined && following.kind === "op" && following.value === "(") {
          return token.value === "getvar" ? this.#getvar(token) : this.#call(token);
        }
        return this.#path(token);
      }
      default:
        throw new ExprError("UNEXPECTED_TOKEN", `unexpected ${show(token)}`, token.pos);
    }
  }

  #numberLiteral(token: Token & { kind: "num" }): number {
    if (!token.text.includes(".") && !Number.isSafeInteger(token.value)) {
      throw new ExprError("NUMBER_RANGE", "integer literal out of range", token.pos);
    }
    return checkedNumber(token.value, token.pos);
  }

  #getvar(name: Token): Node {
    this.#outsideSubset("getvar()", name.pos);
    this.#expectOp("(");
    this.#enter(name.pos);
    const first = this.#next();
    if (first.kind !== "str") throw new ExprError("GETVAR_NAME", "getvar() takes a quoted variable name", first.pos);
    // SillyTavern cards pass extra arguments (defaults and the like) that mean nothing
    // here. They must still be well-formed expressions, but they are never evaluated
    // and their names are not references.
    const ignored: Node[] = [];
    while (this.#acceptOp(",") !== undefined) ignored.push(this.#or());
    this.#expectOp(")");
    this.#leave();
    return { type: "getvar", path: first.value, ignored, pos: name.pos };
  }

  #call(name: Token & { kind: "ident" }): Node {
    this.#outsideSubset(`${name.value}() (a function call)`, name.pos);
    const fn = FUNCTION_NAMES.find((candidate) => candidate === name.value);
    if (fn === undefined || !this.#options.functions.has(fn)) {
      throw new ExprError("UNKNOWN_FUNCTION", `unknown function ${name.value}()`, name.pos);
    }
    this.#expectOp("(");
    this.#enter(name.pos);
    const args: Node[] = [];
    if (this.#acceptOp(")") === undefined) {
      args.push(this.#or());
      while (this.#acceptOp(",") !== undefined) args.push(this.#or());
      this.#expectOp(")");
    }
    this.#leave();
    const [minimum, maximum] = ARITY.get(fn) ?? [0, 0];
    if (args.length < minimum || args.length > maximum) {
      const expected = minimum === maximum ? `${minimum}` : `at least ${minimum}`;
      throw new ExprError("ARITY", `${fn}() takes ${expected} argument(s), got ${args.length}`, name.pos);
    }
    return { type: "call", name: fn, args, pos: name.pos };
  }

  #path(head: Token & { kind: "ident" }): Node {
    const segments = [head.value];
    for (;;) {
      const dot = this.#acceptOp(".");
      if (dot !== undefined) {
        const part = this.#next();
        if (part.kind === "ident") segments.push(part.value);
        else if (part.kind === "num") segments.push(canonicalIndex(part.text));
        else throw new ExprError("BAD_SEGMENT", `bad path segment ${show(part)}`, part.pos);
        continue;
      }
      const bracket = this.#acceptOp("[");
      if (bracket !== undefined) {
        this.#outsideSubset("a bracket segment", bracket.pos);
        const part = this.#next();
        if (part.kind === "str") segments.push(part.value);
        else if (part.kind === "num" && !part.text.includes(".")) segments.push(canonicalIndex(part.text));
        else throw new ExprError("BAD_SEGMENT", `bad bracket segment ${show(part)}; use an index or a quoted key`, part.pos);
        this.#expectOp("]");
        continue;
      }
      break;
    }
    return { type: "path", path: segments.join("."), pos: head.pos };
  }
}

function show(token: Token): string {
  switch (token.kind) {
    case "num":
      return `number ${token.text}`;
    case "str":
      return `string ${JSON.stringify(token.value)}`;
    case "kw":
      return `keyword ${String(token.value)}`;
    case "ident":
      return `name ${JSON.stringify(token.value)}`;
    default:
      return JSON.stringify(token.value);
  }
}
