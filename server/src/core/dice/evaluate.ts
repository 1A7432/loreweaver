/**
 * `DiceExpression` + a random source -> `Roll`.
 *
 * Evaluation builds a small mutable tree, applies each node's operations in order, then
 * freezes it into the readonly `Roll`. Values are read lazily, as in the tabletop meaning
 * of keep/drop: a set operation that drops a die changes the value of everything that
 * contains it, including a group whose content the operation reached into.
 *
 * Arithmetic follows integer-dice expectations with fractions allowed in between: `/` is
 * true division, `//` floors, `%` takes the sign of the divisor, comparisons give 1 or 0,
 * and only the root is truncated toward zero. Every intermediate value must stay within
 * `Number.MAX_SAFE_INTEGER`, so a total is always an exact integer.
 */

import type { RandomSource } from "../random.ts";
import { DiceError, LIMITS } from "./errors.ts";
import { formatOps } from "./parse.ts";
import type { BinaryOp, DiceExpr, DiceExpression, DiceOp, DieSides, Expr, IntTerm, Roll, RollNode, Selector } from "./types.ts";

export interface RollOptions {
  /** Values for `{name}` slots. Each must be a safe integer. */
  readonly params?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /** A dice budget below `LIMITS.maxDice` for this roll (rerolls and explosions count). */
  readonly maxDice?: number;
}

interface Context {
  readonly random: RandomSource;
  readonly params: RollOptions["params"];
  readonly budget: number;
  rolled: number;
}

function checked(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new DiceError("VALUE_TOO_LARGE");
  return value;
}

/** What a selection works on: something with a value that can be dropped. */
interface Member {
  kept: boolean;
  readonly value: number;
}

abstract class Node implements Member {
  kept = true;
  abstract readonly value: number;
  /** What `k`/`p` on this node select from. */
  members(): Member[] {
    return [this];
  }
  /** The value a parent counts. */
  get counted(): number {
    return this.kept ? this.value : 0;
  }
  abstract freeze(): RollNode;
}

class NumberNode extends Node {
  readonly value: number;
  readonly labels: readonly string[];
  constructor(value: number, labels: readonly string[]) {
    super();
    this.value = value;
    this.labels = labels;
  }
  freeze(): RollNode {
    return { kind: "number", value: this.value, kept: this.kept, labels: this.labels };
  }
}

class DieNode implements Member {
  kept = true;
  exploded = false;
  readonly rolls: number[];
  face: number;
  constructor(face: number) {
    this.rolls = [face];
    this.face = face;
  }
  get value(): number {
    return this.face;
  }
}

function sumKept(members: readonly Member[]): number {
  let total = 0;
  for (const member of members) if (member.kept) total += member.value;
  return checked(total);
}

class DiceNode extends Node {
  readonly dice: DieNode[] = [];
  readonly count: number;
  readonly sides: DieSides;
  readonly ops: string;
  readonly labels: readonly string[];
  constructor(count: number, sides: DieSides, ops: string, labels: readonly string[]) {
    super();
    this.count = count;
    this.sides = sides;
    this.ops = ops;
    this.labels = labels;
  }
  get value(): number {
    return sumKept(this.dice);
  }
  override members(): Member[] {
    return this.dice;
  }
  freeze(): RollNode & { kind: "dice" } {
    return {
      kind: "dice",
      value: this.value,
      kept: this.kept,
      count: this.count,
      sides: this.sides,
      ops: this.ops,
      dice: this.dice.map((die) => ({ face: die.face, rolls: [...die.rolls], kept: die.kept, exploded: die.exploded })),
      labels: this.labels,
    };
  }
}

class SetNode extends Node {
  readonly items: Node[];
  readonly ops: string;
  readonly labels: readonly string[];
  constructor(items: Node[], ops: string, labels: readonly string[]) {
    super();
    this.items = items;
    this.ops = ops;
    this.labels = labels;
  }
  get value(): number {
    return sumKept(this.items);
  }
  override members(): Member[] {
    return this.items;
  }
  freeze(): RollNode {
    return { kind: "set", value: this.value, kept: this.kept, items: this.items.map((item) => item.freeze()), ops: this.ops, labels: this.labels };
  }
}

class GroupNode extends Node {
  readonly inner: Node;
  readonly ops: string;
  readonly labels: readonly string[];
  constructor(inner: Node, ops: string, labels: readonly string[]) {
    super();
    this.inner = inner;
    this.ops = ops;
    this.labels = labels;
  }
  get value(): number {
    return this.inner.counted;
  }
  // A group is transparent to selection: `(4d6)kh3` keeps dice, like `4d6kh3`.
  override members(): Member[] {
    return this.inner.members();
  }
  freeze(): RollNode {
    return { kind: "group", value: this.value, kept: this.kept, inner: this.inner.freeze(), ops: this.ops, labels: this.labels };
  }
}

class UnaryNode extends Node {
  readonly op: "+" | "-";
  readonly operand: Node;
  constructor(op: "+" | "-", operand: Node) {
    super();
    this.op = op;
    this.operand = operand;
  }
  get value(): number {
    const v = this.operand.counted;
    return this.op === "-" ? 0 - v : v;
  }
  freeze(): RollNode {
    return { kind: "unary", value: this.value, kept: this.kept, op: this.op, operand: this.operand.freeze() };
  }
}

/** Floor division with Python's float semantics (exact for integers). */
function floorDiv(a: number, b: number): number {
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && b < 0 !== mod < 0) {
    mod += b;
    div -= 1;
  }
  if (div === 0) return 0;
  let floored = Math.floor(div);
  if (div - floored > 0.5) floored += 1;
  return floored;
}

/** Modulo whose result takes the divisor's sign. */
function floorMod(a: number, b: number): number {
  const mod = a % b;
  return mod !== 0 && b < 0 !== mod < 0 ? mod + b : mod;
}

function applyBinary(op: BinaryOp, l: number, r: number): number {
  switch (op) {
    case "+":
      return l + r;
    case "-":
      return l - r;
    case "*":
      return l * r;
    case "/":
      if (r === 0) throw new DiceError("DIVISION_BY_ZERO");
      return l / r;
    case "//":
      if (r === 0) throw new DiceError("DIVISION_BY_ZERO");
      return floorDiv(l, r);
    case "%":
      if (r === 0) throw new DiceError("DIVISION_BY_ZERO");
      return floorMod(l, r);
    case "==":
      return l === r ? 1 : 0;
    case "!=":
      return l !== r ? 1 : 0;
    case "<":
      return l < r ? 1 : 0;
    case ">":
      return l > r ? 1 : 0;
    case "<=":
      return l <= r ? 1 : 0;
    case ">=":
      return l >= r ? 1 : 0;
  }
}

class BinaryNode extends Node {
  readonly op: BinaryOp;
  readonly left: Node;
  readonly right: Node;
  constructor(op: BinaryOp, left: Node, right: Node) {
    super();
    this.op = op;
    this.left = left;
    this.right = right;
  }
  get value(): number {
    // `+ 0` folds a negative zero (`-0.5 * 0`) into 0.
    return checked(applyBinary(this.op, this.left.counted, this.right.counted)) + 0;
  }
  freeze(): RollNode {
    return { kind: "binary", value: this.value, kept: this.kept, op: this.op, left: this.left.freeze(), right: this.right.freeze() };
  }
}

class PoolNode extends Node {
  readonly dice: DiceNode;
  readonly comparison: ">=" | "<=";
  readonly threshold: number;
  constructor(dice: DiceNode, comparison: ">=" | "<=", threshold: number) {
    super();
    this.dice = dice;
    this.comparison = comparison;
    this.threshold = threshold;
  }
  get value(): number {
    return this.dice.dice.filter((die) => (this.comparison === ">=" ? die.face >= this.threshold : die.face <= this.threshold)).length;
  }
  freeze(): RollNode {
    const successes = this.value;
    return {
      kind: "pool",
      value: successes,
      kept: this.kept,
      dice: this.dice.freeze(),
      comparison: this.comparison,
      threshold: this.threshold,
      successes,
      ones: this.dice.dice.filter((die) => die.face === 1).length,
    };
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function param(ctx: Context, name: string): number {
  const params = ctx.params;
  let value: number | undefined;
  if (params instanceof Map) value = params.get(name);
  else if (params !== undefined && Object.hasOwn(params, name)) value = (params as Readonly<Record<string, number>>)[name];
  if (value === undefined) throw new DiceError("MISSING_PARAM");
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DiceError("BAD_PARAM");
  return value;
}

function intValue(ctx: Context, term: IntTerm): number {
  return term.kind === "int" ? term.value : param(ctx, term.name);
}

/** A count of dice or faces: a slot may not make it negative. */
function countValue(ctx: Context, term: IntTerm): number {
  const value = intValue(ctx, term);
  if (value < 0) throw new DiceError("BAD_PARAM");
  return value;
}

function rollFace(ctx: Context, sides: DieSides): number {
  if (sides === 0) throw new DiceError("ZERO_SIDED_DIE");
  if (ctx.rolled + 1 > ctx.budget) throw new DiceError("TOO_MANY_DICE");
  ctx.rolled++;
  if (sides === "%") return ctx.random.nextInt(0, 90, 10);
  if (sides === "F") return ctx.random.nextInt(-1, 1);
  return ctx.random.nextInt(1, sides);
}

function maxFace(sides: DieSides): number {
  if (sides === "%") return 90;
  if (sides === "F") return 1;
  return sides;
}

function newDiceNode(ctx: Context, expr: DiceExpr): DiceNode {
  const count = expr.count === null ? 1 : countValue(ctx, expr.count);
  let sides: DieSides;
  if (expr.sides.kind === "percent") sides = "%";
  else if (expr.sides.kind === "fate") sides = "F";
  else {
    sides = countValue(ctx, expr.sides);
    if (sides > LIMITS.maxSides) throw new DiceError("TOO_MANY_SIDES");
  }
  // Refuse up front rather than after drawing a thousand dice.
  if (count > ctx.budget - ctx.rolled) throw new DiceError("TOO_MANY_DICE");
  const node = new DiceNode(count, sides, formatOps(expr.ops), expr.labels);
  for (let i = 0; i < count; i++) node.dice.push(new DieNode(rollFace(ctx, sides)));
  return node;
}

/** Members a selector picks, in the selector's own order (sorted for `h`/`l`). */
function pick(ctx: Context, selector: Selector, target: Node, sides: DieSides | null): Member[] {
  const kept = target.members().filter((member) => member.kept);
  const n = selector.count.kind === "max" ? maxFace(sides ?? 0) : intValue(ctx, selector.count);
  switch (selector.category) {
    case "h":
      if (n < 0) throw new DiceError("BAD_PARAM");
      // Array sort is stable, so equal values keep their left-to-right order.
      return [...kept].sort((a, b) => b.value - a.value).slice(0, n);
    case "l":
      if (n < 0) throw new DiceError("BAD_PARAM");
      return [...kept].sort((a, b) => a.value - b.value).slice(0, n);
    case ">":
      return kept.filter((member) => member.value > n);
    case "<":
      return kept.filter((member) => member.value < n);
    case "=":
      return kept.filter((member) => member.value === n);
  }
}

/** Union of the selectors' picks, in left-to-right position (the order rerolls happen in). */
function select(ctx: Context, op: DiceOp, target: Node, sides: DieSides | null, maxTargets?: number): Member[] {
  const chosen = new Set<Member>();
  for (const selector of op.selectors) {
    let picked = pick(ctx, selector, target, sides);
    if (maxTargets !== undefined) {
      const room = maxTargets - chosen.size;
      if (room <= 0) break;
      picked = picked.slice(0, room);
    }
    for (const member of picked) chosen.add(member);
  }
  return target.members().filter((member) => chosen.has(member));
}

function reroll(ctx: Context, die: DieNode, sides: DieSides): void {
  const face = rollFace(ctx, sides);
  die.rolls.push(face);
  die.face = face;
}

function explode(ctx: Context, dice: DiceNode, die: DieNode): void {
  die.exploded = true;
  dice.dice.push(new DieNode(rollFace(ctx, dice.sides)));
}

function applyOp(ctx: Context, op: DiceOp, target: Node): void {
  const dice = target instanceof DiceNode ? target : null;
  const sides = dice?.sides ?? null;
  switch (op.op) {
    case "k": {
      const keep = new Set(select(ctx, op, target, sides));
      for (const member of target.members()) if (member.kept && !keep.has(member)) member.kept = false;
      return;
    }
    case "p":
      for (const member of select(ctx, op, target, sides)) member.kept = false;
      return;
  }
  // The parser allows the remaining operations on dice groups only.
  if (dice === null) throw new DiceError("SYNTAX");
  const diceOf = (members: Member[]): DieNode[] => members as DieNode[];
  switch (op.op) {
    case "rr": {
      // Rerolls go left to right; the budget ends a reroll that can never stop (`1d1rr1`).
      let targets = diceOf(select(ctx, op, dice, dice.sides));
      while (targets.length > 0) {
        for (const die of targets) reroll(ctx, die, dice.sides);
        targets = diceOf(select(ctx, op, dice, dice.sides));
      }
      return;
    }
    case "ro":
      for (const die of diceOf(select(ctx, op, dice, dice.sides))) reroll(ctx, die, dice.sides);
      return;
    case "ra":
      for (const die of diceOf(select(ctx, op, dice, dice.sides, 1))) explode(ctx, dice, die);
      return;
    case "e": {
      const done = new Set<DieNode>();
      let targets = diceOf(select(ctx, op, dice, dice.sides));
      while (targets.length > 0) {
        for (const die of targets) {
          explode(ctx, dice, die);
          done.add(die);
        }
        targets = diceOf(select(ctx, op, dice, dice.sides)).filter((die) => !done.has(die));
      }
      return;
    }
    case "mi":
    case "ma": {
      // Only the last selector counts; the parser gives these exactly one.
      const last = op.selectors[op.selectors.length - 1];
      if (last === undefined || last.count.kind === "max") return;
      const bound = intValue(ctx, last.count);
      for (const die of dice.dice) {
        if (!die.kept) continue;
        if (op.op === "mi" ? die.face < bound : die.face > bound) die.face = bound;
      }
      return;
    }
  }
}

function withOps(ctx: Context, node: Node, ops: readonly DiceOp[]): Node {
  for (const op of ops) applyOp(ctx, op, node);
  return node;
}

function evaluate(ctx: Context, expr: Expr): Node {
  switch (expr.kind) {
    case "number":
      return new NumberNode(expr.value, expr.labels);
    case "slot":
      return new NumberNode(param(ctx, expr.name), expr.labels);
    case "dice":
      return withOps(ctx, newDiceNode(ctx, expr), expr.ops);
    case "set":
      return withOps(
        ctx,
        new SetNode(
          expr.items.map((item) => evaluate(ctx, item)),
          formatOps(expr.ops),
          expr.labels,
        ),
        expr.ops,
      );
    case "group":
      return withOps(ctx, new GroupNode(evaluate(ctx, expr.inner), formatOps(expr.ops), expr.labels), expr.ops);
    case "unary":
      return new UnaryNode(expr.op, evaluate(ctx, expr.operand));
    case "binary": {
      const left = evaluate(ctx, expr.left);
      return new BinaryNode(expr.op, left, evaluate(ctx, expr.right));
    }
    case "pool": {
      const count = expr.dice.count === null ? 1 : countValue(ctx, expr.dice.count);
      const sides = expr.dice.sides.kind === "int" || expr.dice.sides.kind === "slot" ? countValue(ctx, expr.dice.sides) : 0;
      if (count < 1 || sides < 2) throw new DiceError("BAD_POOL");
      const threshold = intValue(ctx, expr.threshold);
      return new PoolNode(newDiceNode(ctx, expr.dice), expr.comparison, threshold);
    }
  }
}

/** Rolls a parsed expression. Throws `DiceError` for what only rolling can find out. */
export function rollExpression(expression: DiceExpression, random: RandomSource, options: RollOptions = {}): Roll {
  const budget = options.maxDice === undefined ? LIMITS.maxDice : Math.min(LIMITS.maxDice, options.maxDice);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new DiceError("BAD_COUNT");
  const ctx: Context = { random, params: options.params, budget, rolled: 0 };
  const root = evaluate(ctx, expression.root);
  const frozen = root.freeze();
  return { notation: expression.notation, total: Math.trunc(checked(root.value)) + 0, root: frozen };
}
