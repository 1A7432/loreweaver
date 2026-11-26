/**
 * The data shapes of the dice engine: the parsed notation (`DiceExpression`) and the
 * outcome of rolling it (`Roll`). Both are plain readonly data, safe to keep, compare and
 * serialize.
 */

// ---------------------------------------------------------------------------
// Parsed notation
// ---------------------------------------------------------------------------

/** An integer written in the notation, or a `{name}` slot filled from `params` at roll time. */
export type IntTerm = { readonly kind: "int"; readonly value: number } | { readonly kind: "slot"; readonly name: string };

/** Faces of a die: a number (`d%` parses as 100) or `F` (Fate: -1, 0, +1). */
export type SidesTerm = IntTerm | { readonly kind: "fate" };

/**
 * How a selector picks dice or set members: `h`/`l` the n highest/lowest, `>`/`<` those
 * above/below n, `=` those equal to n.
 */
export type SelectorCategory = "h" | "l" | ">" | "<" | "=";

export interface Selector {
  readonly category: SelectorCategory;
  /** `max` is the `!` shorthand: the die's highest face, known once the sides are. */
  readonly count: IntTerm | { readonly kind: "max" };
}

/**
 * `k` keep, `p` drop (both also on sets); `rr` reroll until no die matches, `ro` reroll
 * once, `ra` add one die for the first match, `e` explode (an extra die for each match,
 * again for the new ones), `mi`/`ma` raise/lower faces to a minimum/maximum.
 */
export type DiceOpName = "k" | "p" | "rr" | "ro" | "ra" | "e" | "mi" | "ma";

/**
 * One operation. Consecutive operations of the same name (except `mi`/`ma`) act as ONE
 * operation over the union of their selectors: `kh2kh1` keeps the two highest.
 */
export interface DiceOp {
  readonly op: DiceOpName;
  readonly selectors: readonly Selector[];
}

export type ComparisonOp = "==" | "!=" | "<" | ">" | "<=" | ">=";
export type BinaryOp = "+" | "-" | "*" | "/" | "//" | "%" | ComparisonOp;

export type Expr =
  | { readonly kind: "number"; readonly value: number; readonly labels: readonly string[] }
  | { readonly kind: "slot"; readonly name: string; readonly labels: readonly string[] }
  | DiceExpr
  /** `(a, b, ...)`, `(a,)` or `()`: a set whose members `k`/`p` select from. */
  | { readonly kind: "set"; readonly items: readonly Expr[]; readonly ops: readonly DiceOp[]; readonly labels: readonly string[] }
  /** `(a)`: grouping. `k`/`p` on a group select from what its content is a set of. */
  | { readonly kind: "group"; readonly inner: Expr; readonly ops: readonly DiceOp[]; readonly labels: readonly string[] }
  | { readonly kind: "unary"; readonly op: "+" | "-"; readonly operand: Expr }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  /** A success pool: the whole notation is `[N]dM>=K` or `[N]dM<=K` with a bare dice group. */
  | { readonly kind: "pool"; readonly dice: DiceExpr; readonly comparison: ">=" | "<="; readonly threshold: IntTerm };

export interface DiceExpr {
  readonly kind: "dice";
  /** `null` when omitted (`d20` is one die). */
  readonly count: IntTerm | null;
  readonly sides: SidesTerm;
  readonly ops: readonly DiceOp[];
  readonly labels: readonly string[];
}

export interface DiceExpression {
  /** The notation re-written canonically (lower-case operators, `x` as `*`, `k3` as `kh3`). */
  readonly notation: string;
  readonly root: Expr;
}

// ---------------------------------------------------------------------------
// Rolled outcome
// ---------------------------------------------------------------------------

export type DieSides = number | "F";

export interface Die {
  /** What the die counts for: its last roll, raised or lowered by `mi`/`ma`. */
  readonly face: number;
  /** Every face this die showed, in order; all but the last were rerolled away. */
  readonly rolls: readonly number[];
  /** False when a keep/drop removed it; it still shows its real face. */
  readonly kept: boolean;
  /** It triggered an extra die (`e`, `ra`, `!`). */
  readonly exploded: boolean;
}

interface RollNodeBase {
  /**
   * The node's own value, whether or not it was kept (a parent counts it only when
   * `kept`). May be fractional below the root (`10/4*2`); only the total is truncated.
   */
  readonly value: number;
  readonly kept: boolean;
}

export interface DiceRoll extends RollNodeBase {
  readonly kind: "dice";
  readonly count: number;
  readonly sides: DieSides;
  /** The operations, as canonical notation (`kh3`, `rr1`, `!`). */
  readonly ops: string;
  /** Initial dice left to right, then any dice explosions added, in the order they were rolled. */
  readonly dice: readonly Die[];
  readonly labels: readonly string[];
}

export type RollNode =
  | (RollNodeBase & { readonly kind: "number"; readonly labels: readonly string[] })
  | DiceRoll
  | (RollNodeBase & { readonly kind: "set"; readonly items: readonly RollNode[]; readonly ops: string; readonly labels: readonly string[] })
  | (RollNodeBase & { readonly kind: "group"; readonly inner: RollNode; readonly ops: string; readonly labels: readonly string[] })
  | (RollNodeBase & { readonly kind: "unary"; readonly op: "+" | "-"; readonly operand: RollNode })
  | (RollNodeBase & { readonly kind: "binary"; readonly op: BinaryOp; readonly left: RollNode; readonly right: RollNode })
  | (RollNodeBase & {
      readonly kind: "pool";
      readonly dice: DiceRoll;
      readonly comparison: ">=" | "<=";
      readonly threshold: number;
      /** Dice meeting the threshold; also the node's value. */
      readonly successes: number;
      /** Dice showing a natural 1, for packs whose ladder counts botches. */
      readonly ones: number;
    });

export interface Roll {
  /** The canonical notation that was rolled, slots still shown as `{name}`. */
  readonly notation: string;
  /** The integer result: the root's value truncated toward zero (a pool's: its successes). */
  readonly total: number;
  readonly root: RollNode;
}
