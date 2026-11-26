/**
 * Reading the room's variables the way lore entries and macros address them.
 *
 * A name may carry a leading `variables.` or `stat_data.` (the two roots cards write);
 * module variables (`flat`) are checked first by the whole stripped name, then the MVU
 * tree by dotted path, where numeric segments index lists. A tree leaf written as
 * `[value, "description"]` (a two-element list whose second item is a string) reads as
 * its value and cannot be indexed into. Only OWN keys are read, so `__proto__` or
 * `constructor` is an ordinary (usually absent) name.
 */

import { ABSENT, type Resolver } from "../condexpr.ts";
import type { VariableSnapshot } from "./types.ts";

const ROOT_PREFIX = /^(?:variables\.|stat_data\.)/u;
/** A path deeper than this reads as absent (content-supplied, so bounded). */
const MAX_PATH_SEGMENTS = 32;

export const EMPTY_VARIABLES: VariableSnapshot = Object.freeze({ flat: Object.freeze({}), tree: Object.freeze({}) });

/** `[value, "description"]`: the MVU leaf shape. */
export function isValueWithDescription(node: unknown): node is readonly [unknown, string] {
  return Array.isArray(node) && node.length === 2 && typeof node[1] === "string";
}

function lookupTree(tree: unknown, path: string): unknown {
  const parts = path.split(".");
  if (parts.length > MAX_PATH_SEGMENTS) return undefined;
  let node: unknown = tree;
  for (const part of parts) {
    if (Array.isArray(node)) {
      if (isValueWithDescription(node)) return undefined;
      if (!/^\d{1,9}$/u.test(part)) return undefined;
      const index = Number(part);
      if (index >= node.length) return undefined;
      node = node[index];
    } else if (typeof node === "object" && node !== null) {
      if (!Object.hasOwn(node, part)) return undefined;
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return isValueWithDescription(node) ? node[0] : node;
}

/** The value `name` reads, or `undefined` when nothing is there. */
export function readVariable(variables: VariableSnapshot, name: string): unknown {
  const stripped = name.replace(ROOT_PREFIX, "");
  if (Object.hasOwn(variables.flat, stripped)) return variables.flat[stripped];
  return lookupTree(variables.tree, stripped);
}

/** A condition-language resolver over the snapshot: what reads as nothing is `ABSENT`. */
export function variableResolver(variables: VariableSnapshot): Resolver {
  return (path) => {
    const value = readVariable(variables, path);
    return value === undefined ? ABSENT : value;
  };
}
