/**
 * The built-in rule packs (CoC 7e, D&D 5e SRD, World of Darkness), compiled from the text
 * embedded in the binary. Compiled afresh on each call: nothing is cached at module level,
 * so there is no process-wide state; a caller keeps the result (normally in its
 * `RulePackRegistry`).
 */

import { compileRulePack } from "./compile.ts";
import { BUILT_IN_SOURCES } from "./sources.ts";
import type { RulePack } from "./types.ts";

/** The built-in pack ids, in discovery order. */
export function builtInPackIds(): readonly string[] {
  return Object.freeze([...BUILT_IN_SOURCES.keys()]);
}

/** Every built-in pack, compiled, in discovery order. */
export function builtInPacks(): readonly RulePack[] {
  return Object.freeze([...BUILT_IN_SOURCES].map(([id, text]) => compileRulePack(id, text)));
}

/** A built-in pack's YAML text, or null (e.g. to show an author the base they extend). */
export function builtInPackSource(id: string): string | null {
  return BUILT_IN_SOURCES.get(id) ?? null;
}
