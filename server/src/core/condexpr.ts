/**
 * The expression language of rule packs and content: rank conditions
 * (`roll <= target && roll <= floor(raw_target / 5)`), target transforms, margins,
 * derived-value and budget formulas, worldbook conditions and panel `visible_when` gates.
 *
 * It is JavaScript-SHAPED (SillyTavern cards write their conditions that way) but it is
 * not JavaScript: a closed grammar over a hand-written tokenizer and parser, no
 * assignment, no loops, no member access on host objects, nothing ever passed to `eval`.
 * Its semantics deliberately differ from JavaScript's operators where those would decide
 * silently: ordering a string against a number is an error, `==` coerces only numeric
 * strings, a boolean is never `===` a number. The grammar is in `condexpr/parser.ts`;
 * coercion and operator rules in `condexpr/values.ts`.
 *
 * Usage: `compile` once (at pack load, where errors point at the author's text), then
 * `evaluate` per use. Compiling is where every size bound, syntax rule, function arity
 * and subset restriction is enforced, so a `CompiledExpr` can only fail at run time on
 * what the resolver supplies.
 */

import { ABSENT, type AbsentPolicy, checkConstants, evaluateNode, type Resolver } from "./condexpr/evaluate.ts";
import { ExprError, type ExprErrorCode } from "./condexpr/errors.ts";
import { MAX_SOURCE_LENGTH, MAX_TOKENS } from "./condexpr/lexer.ts";
import { FUNCTION_NAMES, type FunctionName, MAX_DEPTH, type Node, parse } from "./condexpr/parser.ts";
import { MAX_STRING_LENGTH, truthy, type Value } from "./condexpr/values.ts";

export { ABSENT, ExprError, FUNCTION_NAMES, MAX_DEPTH, MAX_SOURCE_LENGTH, MAX_STRING_LENGTH, MAX_TOKENS, truthy };
export type { AbsentPolicy, ExprErrorCode, FunctionName, Resolver, Value };

export interface CompileOptions {
  /**
   * The functions this expression may call (default: none). Rank ladders and target
   * transforms take `floor ceil min max abs`; derived values add `if`. `getvar('name')`
   * is not a function in this sense: it is available whenever the subset allows it.
   */
  readonly functions?: readonly FunctionName[];
  /**
   * Restrict to the PORTABLE subset — comparisons, `&& || !` (and `and or not`),
   * literals, dotted references, parentheses — that every client implements for
   * `visible_when`. Arithmetic, unary minus, function calls, `getvar` and bracket
   * segments fail with `OUTSIDE_SUBSET`. Each is a place two independent evaluators
   * could quietly disagree, which is the one thing a visibility gate must not do.
   */
  readonly portable?: boolean;
}

export interface EvaluateOptions {
  /**
   * What a reference the resolver answers with `ABSENT` reads as: `"null"` (default —
   * room variables, where a variable not set yet is simply null) or `"error"`
   * (`ABSENT_NAME` — a closed namespace like a check's `roll`/`target`, where a missing
   * name is a caller bug that must not grade as if it were null).
   */
  readonly absent?: AbsentPolicy;
}

export interface CompiledExpr {
  readonly source: string;
  /**
   * Every reference path the expression reads, deduplicated, in source order: dotted
   * paths as written (`mvu.队伍.0.血量`, `dice.0` for `dice[0]`) and `getvar('x')`
   * names. Static — it includes references in branches a given evaluation skips, which
   * is the point: a caller with a closed namespace checks this list at pack load, since
   * no run can prove that a short-circuited name is spelled right.
   */
  readonly references: readonly string[];
  /** Whether the expression lies inside the portable `visible_when` subset. */
  readonly portable: boolean;
  /**
   * Evaluate against `resolve`. Throws `ExprError` for a value problem (unorderable
   * operands, division by zero, an absent name under `absent: "error"`, …). An
   * exception thrown by `resolve` itself passes through unchanged.
   */
  evaluate(resolve: Resolver, options?: EvaluateOptions): Value;
  /** `evaluate`, folded through `truthy`. */
  test(resolve: Resolver, options?: EvaluateOptions): boolean;
}

/** Parse and check `source`; throws a positioned `ExprError`. */
export function compile(source: string, options: CompileOptions = {}): CompiledExpr {
  const parsed = parse(source, {
    functions: new Set(options.functions ?? []),
    portable: options.portable ?? false,
  });
  checkConstants(parsed.root);
  return new Compiled(source, parsed.root, collectReferences(parsed.root), parsed.nonPortable === null);
}

/** A resolver over a `Map`: a missing key is `ABSENT`. */
export function mapResolver(values: ReadonlyMap<string, unknown>): Resolver {
  return (path) => (values.has(path) ? values.get(path) : ABSENT);
}

/** A resolver over a plain record: only OWN keys resolve, so `constructor`,
 * `toString` or `__proto__` are absent names like any other, never inherited members. */
export function recordResolver(values: Readonly<Record<string, unknown>>): Resolver {
  return (path) => (Object.hasOwn(values, path) ? values[path] : ABSENT);
}

class Compiled implements CompiledExpr {
  readonly source: string;
  readonly references: readonly string[];
  readonly portable: boolean;
  readonly #root: Node;

  constructor(source: string, root: Node, references: readonly string[], portable: boolean) {
    this.source = source;
    this.#root = root;
    this.references = references;
    this.portable = portable;
    Object.freeze(this);
  }

  evaluate(resolve: Resolver, options: EvaluateOptions = {}): Value {
    return evaluateNode(this.#root, { resolve, absent: options.absent ?? "null" });
  }

  test(resolve: Resolver, options: EvaluateOptions = {}): boolean {
    return truthy(this.evaluate(resolve, options));
  }
}

function collectReferences(root: Node): readonly string[] {
  const seen = new Set<string>();
  const visit = (node: Node): void => {
    switch (node.type) {
      case "literal":
        return;
      case "path":
      case "getvar":
        // `getvar`'s ignored arguments are never evaluated, so they read nothing.
        seen.add(node.path);
        return;
      case "not":
      case "negate":
        visit(node.operand);
        return;
      case "call":
        node.args.forEach(visit);
        return;
      default:
        visit(node.left);
        visit(node.right);
    }
  };
  visit(root);
  return Object.freeze([...seen]);
}
