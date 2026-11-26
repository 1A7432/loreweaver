// The variable tree an imported world card declares and the model updates (the
// MagVarUpdate, "MVU", convention of SillyTavern cards).
//
// A tree is held in `Map`s, never in plain objects: its keys are content, routinely CJK,
// sometimes number-like (`"1"`, `"2"`) or JavaScript-meaningful (`__proto__`,
// `constructor`). An object would list integer-like keys first and treat `__proto__` as
// its prototype; a `Map` keeps every key ordinary and keeps the order the author wrote.
// Plain JSON appears only at deliberate boundaries: `encodeTree` / `decodeTree` (order-
// preserving JSON text, which is what a document stores) and `toJson` (for reporting a
// value, where order inside a mapping does not matter).
import { readJson5 } from "./json5.ts";

export type VarScalar = null | boolean | number | string;
export type VarValue = VarScalar | VarList | VarMap;
export type VarList = VarValue[];
export type VarMap = Map<string, VarValue>;

/** Bounds on a tree. Real cards nest a handful of levels and hold a few hundred leaves. */
export const MAX_TREE_DEPTH = 16;
export const MAX_TREE_NODES = 4096;
export const MAX_KEY_CHARS = 256;
export const MAX_STRING_CHARS = 20_000;
/** Longest stored tree, as JSON text (UTF-16 code units). */
export const MAX_TREE_JSON_CHARS = 2_000_000;

export function isMap(value: VarValue | undefined): value is VarMap {
  return value instanceof Map;
}

export function isList(value: VarValue | undefined): value is VarList {
  return Array.isArray(value);
}

export function isContainer(value: VarValue | undefined): value is VarMap | VarList {
  return isMap(value) || isList(value);
}

export function isScalar(value: VarValue | undefined): value is VarScalar {
  return value !== undefined && !isContainer(value);
}

/** Code points in `text` (a CJK character and an emoji count as one each). */
export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * A `[value, "description"]` leaf, read for DISPLAY and reads. MagVarUpdate's own test is
 * "an array of two whose second item is a string" (`isValueWithDescription` in
 * MagVarUpdate `src/variable_def.ts`), which cannot tell `["甲", "乙"]` from a described
 * value — the convention gives no way to, so such a list IS a described value here too.
 * Narrower than that test in one way: the value must itself be a leaf (a scalar or a list
 * of scalars), so a described value always flattens to one leaf.
 */
export function isDescribedLeaf(node: VarValue | undefined): node is [VarScalar | VarScalar[], string] {
  if (!isList(node) || node.length !== 2 || typeof node[1] !== "string") return false;
  const value = node[0];
  return isScalar(value) || (isList(value) && value.every((item) => isScalar(item)));
}

/** The value of a leaf: a described leaf unwraps, anything else is itself. */
export function leafValue(node: VarValue): VarValue {
  return isDescribedLeaf(node) ? node[0] : node;
}

export function cloneValue(value: VarValue): VarValue {
  if (isMap(value)) return new Map([...value].map(([key, child]) => [key, cloneValue(child)]));
  if (isList(value)) return value.map(cloneValue);
  return value;
}

/** Structural equality (order of a mapping's keys does not matter, as in lodash `isEqual`). */
export function valuesEqual(a: VarValue, b: VarValue): boolean {
  if (isMap(a) || isMap(b)) {
    if (!isMap(a) || !isMap(b) || a.size !== b.size) return false;
    for (const [key, child] of a) {
      const other = b.get(key);
      if (other === undefined || !valuesEqual(child, other)) return false;
    }
    return true;
  }
  if (isList(a) || isList(b)) {
    if (!isList(a) || !isList(b) || a.length !== b.length) return false;
    return a.every((item, index) => valuesEqual(item, b[index] as VarValue));
  }
  return a === b;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export type TreeProblem = "too_deep" | "too_many_nodes" | "key_too_long" | "string_too_long" | "non_finite_number";

/**
 * The first bound `value` breaks, or null. A tree over a bound is REFUSED by every caller
 * (an import, a write), never cut down to fit: a silently shortened tree would be a
 * different module state than the one the author or the model wrote.
 */
export function treeProblem(value: VarValue): TreeProblem | null {
  let nodes = 0;
  const visit = (node: VarValue, depth: number): TreeProblem | null => {
    if (isContainer(node)) {
      if (depth >= MAX_TREE_DEPTH) return "too_deep";
      const children: VarValue[] = isMap(node) ? [...node.values()] : node;
      if (isMap(node)) {
        for (const key of node.keys()) if (key.length > MAX_KEY_CHARS && codePoints(key) > MAX_KEY_CHARS) return "key_too_long";
      }
      for (const child of children) {
        nodes += 1;
        if (nodes > MAX_TREE_NODES) return "too_many_nodes";
        const problem = visit(child, depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
    if (typeof node === "number" && !Number.isFinite(node)) return "non_finite_number";
    if (typeof node === "string" && node.length > MAX_STRING_CHARS && codePoints(node) > MAX_STRING_CHARS) return "string_too_long";
    return null;
  };
  return visit(value, 0);
}

// ---------------------------------------------------------------------------
// JSON boundaries
// ---------------------------------------------------------------------------

/** Order-preserving JSON text for a tree (what a document stores). */
export function encodeTree(tree: VarMap): string {
  return encodeValue(tree);
}

function encodeValue(value: VarValue): string {
  if (isMap(value)) return `{${[...value].map(([key, child]) => `${JSON.stringify(key)}:${encodeValue(child)}`).join(",")}}`;
  if (isList(value)) return `[${value.map(encodeValue).join(",")}]`;
  return JSON.stringify(value);
}

/** A stored tree back from its JSON text; null when it is not a bounded JSON mapping. */
export function decodeTree(text: string): VarMap | null {
  if (text.length > MAX_TREE_JSON_CHARS) return null;
  const read = readJson5(text, { strict: true });
  if (!read.ok || !isMap(read.value) || treeProblem(read.value) !== null) return null;
  return read.value;
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * A value as plain JSON, for reporting it (a write's old and new value). A mapping becomes
 * an object built with `Object.fromEntries`, so `__proto__` is an ordinary own key; an
 * object cannot keep integer-like keys in written order, which is why STORAGE uses
 * `encodeTree` instead.
 */
export function toJson(value: VarValue): Json {
  if (isMap(value)) return Object.fromEntries([...value].map(([key, child]) => [key, toJson(child)]));
  if (isList(value)) return value.map(toJson);
  return value;
}

/** Plain JS data (YAML output, JSON.parse output) into a tree value; null for anything else. */
export function fromPlain(value: unknown, depth = 0): VarValue | undefined {
  if (depth > MAX_TREE_DEPTH + 1) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) {
    const out: VarValue[] = [];
    for (const item of value) {
      const converted = fromPlain(item, depth + 1);
      if (converted === undefined) return undefined;
      out.push(converted);
    }
    return out;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: VarMap = new Map();
    for (const [key, child] of Object.entries(value)) {
      const converted = fromPlain(child, depth + 1);
      if (converted === undefined) return undefined;
      out.set(key, converted);
    }
    return out;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

export interface Leaf {
  /** Dotted path: mapping keys and list indexes joined by `.`. */
  readonly path: string;
  readonly value: VarScalar | readonly VarScalar[];
  /** The description of a `[value, "description"]` leaf. */
  readonly description?: string;
}

/**
 * Every leaf of `tree`, depth-first in written order. A described value is one leaf; a
 * list of scalars is one leaf (the list); a list holding containers recurses with index
 * segments; an empty mapping contributes nothing. Stops after `limit` leaves.
 */
export function flattenLeaves(tree: VarMap, limit = MAX_TREE_NODES): Leaf[] {
  const leaves: Leaf[] = [];
  const visit = (node: VarValue, path: string): void => {
    if (leaves.length >= limit) return;
    if (isDescribedLeaf(node)) {
      const value = node[0];
      leaves.push({ path, value: isList(value) ? [...value] : value, description: node[1] });
      return;
    }
    if (isMap(node)) {
      for (const [key, child] of node) {
        if (leaves.length >= limit) return;
        visit(child, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    if (isList(node)) {
      if (node.every((item) => isScalar(item))) {
        leaves.push({ path, value: node as VarScalar[] });
        return;
      }
      node.forEach((child, index) => visit(child, path === "" ? String(index) : `${path}.${index}`));
      return;
    }
    leaves.push({ path, value: node });
  };
  for (const [key, child] of tree) visit(child, key);
  return leaves;
}
