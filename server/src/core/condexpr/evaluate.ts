import { ExprError } from "./errors.ts";
import type { Node } from "./parser.ts";
import {
  arithmetic,
  checkedNumber,
  fromResolver,
  looseEqual,
  negate,
  numericArgument,
  order,
  strictEqual,
  truthy,
  type Value,
} from "./values.ts";

/**
 * Walking the tree. The tree's size is bounded by the token cap, so the recursion here
 * is too; `&&`, `||` and `if()` evaluate only the branch
 * they select, so a branch that is not taken never reads a name or raises.
 */

/** What a resolver returns for a name the context does not have. */
export const ABSENT: unique symbol = Symbol("condexpr.absent");

/** Maps a reference path (`hp`, `mvu.潮位`, `party.0.hp`) to a value, or `ABSENT`. */
export type Resolver = (path: string) => unknown;

export type AbsentPolicy = "null" | "error";

export interface Walk {
  readonly resolve: Resolver;
  readonly absent: AbsentPolicy;
}

export function evaluateNode(node: Node, walk: Walk): Value {
  switch (node.type) {
    case "literal":
      return node.value;
    case "path":
    case "getvar":
      return lookup(node.path, node.pos, walk);
    case "not":
      return !truthy(evaluateNode(node.operand, walk));
    case "negate":
      return negate(evaluateNode(node.operand, walk), node.pos);
    case "logic": {
      // The operand's VALUE comes back, as in JavaScript: `0 || "x"` is "x".
      const left = evaluateNode(node.left, walk);
      if (node.op === "&&") return truthy(left) ? evaluateNode(node.right, walk) : left;
      return truthy(left) ? left : evaluateNode(node.right, walk);
    }
    case "compare": {
      const left = evaluateNode(node.left, walk);
      const right = evaluateNode(node.right, walk);
      switch (node.op) {
        case "===":
          return strictEqual(left, right, node.pos);
        case "!==":
          return !strictEqual(left, right, node.pos);
        case "==":
          return looseEqual(left, right, node.pos);
        case "!=":
          return !looseEqual(left, right, node.pos);
        default:
          return order(node.op, left, right, node.pos);
      }
    }
    case "arith":
      return arithmetic(node.op, evaluateNode(node.left, walk), evaluateNode(node.right, walk), node.pos);
    case "call":
      return call(node, walk);
  }
}

function lookup(path: string, position: number, walk: Walk): Value {
  const raw = walk.resolve(path);
  if (raw === ABSENT) {
    if (walk.absent === "error") throw new ExprError("ABSENT_NAME", `unknown name ${JSON.stringify(path)}`, position);
    return null;
  }
  return fromResolver(raw, position, path);
}

function call(node: Node & { type: "call" }, walk: Walk): Value {
  const { name, args, pos } = node;
  if (name === "if") {
    // Lazy, like `&&`: only the selected branch is evaluated.
    const [condition, then, otherwise] = args as readonly [Node, Node, Node];
    return evaluateNode(truthy(evaluateNode(condition, walk)) ? then : otherwise, walk);
  }
  const numbers = args.map((arg) => numericArgument(evaluateNode(arg, walk), arg.pos, name));
  switch (name) {
    case "floor":
      return checkedNumber(Math.floor(numbers[0]!), pos);
    case "ceil":
      return checkedNumber(Math.ceil(numbers[0]!), pos);
    case "abs":
      return checkedNumber(Math.abs(numbers[0]!), pos);
    case "min":
      return checkedNumber(Math.min(...numbers), pos);
    case "max":
      return checkedNumber(Math.max(...numbers), pos);
  }
}

/**
 * Compile-time check of every subtree built from literals alone: `1 / 0`, `'a' > 5` or
 * `floor('x')` can never evaluate, whatever the context supplies, so a pack carrying one
 * is refused when it loads instead of when a player first reaches it. (The reference got
 * the same effect from a dry run against placeholder values, which also refused sound
 * expressions such as `10 / (target - 1)` because the placeholder made the divisor 0.)
 * Returns whether `node` is constant.
 */
export function checkConstants(node: Node): boolean {
  let constant: boolean;
  switch (node.type) {
    case "literal":
      return true;
    case "path":
    case "getvar":
      return false;
    case "not":
    case "negate":
      constant = checkConstants(node.operand);
      break;
    case "call":
      // Every argument is checked, so a constant error is found even in an `if()`
      // branch that some context would not take.
      constant = node.args.map(checkConstants).every(Boolean);
      break;
    default: {
      const left = checkConstants(node.left);
      const right = checkConstants(node.right);
      constant = left && right;
    }
  }
  if (constant) evaluateNode(node, NO_NAMES);
  return constant;
}

const NO_NAMES: Walk = {
  resolve: () => ABSENT,
  absent: "error",
};
