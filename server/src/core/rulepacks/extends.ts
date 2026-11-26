/**
 * `extends:` — a pack that patches a base pack instead of restating a whole system.
 *
 * While the document has `extends`, the named base is loaded as a raw document and the
 * current document is deep-merged over it: mappings merge recursively, an explicit `null`
 * deletes the inherited key (how a patch removes a base alias or default), and scalars and
 * lists replace the inherited value wholesale (a rank ladder is replaced, never appended
 * to). The base's own `extends` survives the merge, so the next pass resolves the
 * grandparent. At most `MAX_EXTENDS_DEPTH` bases; a cycle (a pack extending itself
 * included) or an unknown base fails the load. The merged document is then compiled under
 * the CHILD's id.
 */

import { RulePackError } from "./errors.ts";
import { isRecord, type Raw } from "./raw.ts";

export const MAX_EXTENDS_DEPTH = 4;

/** Loads a base pack's raw document by id: the parsed mapping, or null when unknown. */
export type BaseDocumentLoader = (id: string) => Raw | null;

/** An own-key, prototype-free mapping: merged keys are content, never object members. */
function freshMapping(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `child` deep-merged over `base`. Inherited keys keep their position; keys only the
 * child has follow, in the child's order (the order of a mapping is meaning in a pack:
 * creation rolls, ladders, resources).
 */
export function mergeDocuments(base: Raw, child: Raw): Raw {
  const merged = freshMapping();
  for (const key of Object.keys(base)) put(merged, key, base[key]);
  for (const key of Object.keys(child)) {
    const value = child[key];
    if (value === null) {
      delete merged[key];
      continue;
    }
    const inherited = Object.hasOwn(merged, key) ? merged[key] : undefined;
    put(merged, key, isRecord(value) && isRecord(inherited) ? mergeDocuments(inherited, value) : value);
  }
  return merged;
}

/** The document with its `extends:` chain resolved, without the `extends` key. Throws `RulePackError`. */
export function resolveExtends(packId: string, document: Raw, loadBase: BaseDocumentLoader): Raw {
  const seen = new Set([packId]);
  let resolved: Raw = document;
  for (;;) {
    if (!Object.hasOwn(resolved, "extends")) return resolved;
    const reference = resolved.extends;
    const rest = freshMapping();
    for (const key of Object.keys(resolved)) if (key !== "extends") put(rest, key, resolved[key]);
    if (reference === null) return rest;
    if (typeof reference !== "string" || reference.trim() === "") {
      throw new RulePackError("EXTENDS_INVALID", packId, "extends", "must name a base rule pack id");
    }
    const baseId = reference.trim();
    if (seen.has(baseId)) throw new RulePackError("EXTENDS_CYCLE", packId, "extends", `the chain comes back to '${baseId}'`);
    if (seen.size > MAX_EXTENDS_DEPTH) throw new RulePackError("EXTENDS_TOO_DEEP", packId, "extends", `more than ${MAX_EXTENDS_DEPTH} bases`);
    const base = loadBase(baseId);
    if (base === null) throw new RulePackError("EXTENDS_UNKNOWN", packId, "extends", `no base rule pack '${baseId}'`);
    if (!isRecord(base)) throw new RulePackError("NOT_A_MAPPING", packId, "extends", `base '${baseId}' is not a mapping`);
    seen.add(baseId);
    resolved = mergeDocuments(base, rest);
  }
}
