// Which leaves of an imported tree the players may see. An imported tree is the module's
// own state, so the default exposes NOTHING (iron rule 3, fail-closed): the room's admin
// puts a branch on the players' panel deliberately, by path prefix.
import { codePoints, isDescribedLeaf, isList, isMap, isScalar, type VarMap, type VarValue } from "./tree.ts";

export const EXPOSE_ALL = "*";
export const MAX_EXPOSED_PREFIXES = 64;
export const MAX_EXPOSED_PREFIX_CHARS = 200;

/**
 * Whether one dotted leaf path is exposed. `*` exposes everything; any other prefix
 * matches itself and its dotted subtree, aligned on segments (`悟空` exposes
 * `悟空.好感度`, never `悟空二号`).
 */
export function pathIsExposed(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => prefix === EXPOSE_ALL || path === prefix || path.startsWith(`${prefix}.`));
}

/** One prefix trimmed of spaces and stray dots; null when empty or too long. */
export function normalizePrefix(prefix: string): string | null {
  const cleaned = prefix.trim().replace(/^\.+|\.+$/g, "");
  if (cleaned === "" || codePoints(cleaned) > MAX_EXPOSED_PREFIX_CHARS) return null;
  return cleaned;
}

/** A stored exposure list, cleaned; anything unusable is dropped (fail-closed: less exposed). */
export function normalizeExposed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const cleaned = typeof item === "string" ? normalizePrefix(item) : null;
    if (cleaned !== null && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= MAX_EXPOSED_PREFIXES) break;
  }
  return out;
}

export type ExposeResult = { readonly status: "added" | "removed"; readonly exposed: string[] } | { readonly status: "unchanged" | "invalid" | "limit_reached" };

export function exposePrefix(exposed: readonly string[], prefix: string): ExposeResult {
  const cleaned = normalizePrefix(prefix);
  if (cleaned === null) return { status: "invalid" };
  if (exposed.includes(cleaned)) return { status: "unchanged" };
  if (exposed.length >= MAX_EXPOSED_PREFIXES) return { status: "limit_reached" };
  return { status: "added", exposed: [...exposed, cleaned] };
}

export function hidePrefix(exposed: readonly string[], prefix: string): ExposeResult {
  const cleaned = normalizePrefix(prefix);
  if (cleaned === null) return { status: "invalid" };
  if (!exposed.includes(cleaned)) return { status: "unchanged" };
  return { status: "removed", exposed: exposed.filter((item) => item !== cleaned) };
}

/**
 * The tree with every unexposed branch removed and the SHAPE of what survives intact (a
 * described value stays a pair, a list stays a list) — what a player-grade template
 * renderer reads. Same traversal and path convention as `flattenLeaves`, so the two
 * views agree on what is exposed. Partially exposing a list of containers drops the
 * hidden elements and shifts later indexes: better than revealing how many are hidden.
 */
export function pruneToExposed(tree: VarMap, prefixes: readonly string[]): VarMap {
  const kept = pruneNode(tree, "", prefixes);
  return isMap(kept) ? kept : new Map();
}

function pruneNode(node: VarValue, path: string, prefixes: readonly string[]): VarValue | undefined {
  if (isDescribedLeaf(node) || isScalar(node)) return pathIsExposed(path, prefixes) ? node : undefined;
  if (isMap(node)) {
    const kept: VarMap = new Map();
    for (const [key, child] of node) {
      const survived = pruneNode(child, path === "" ? key : `${path}.${key}`, prefixes);
      if (survived !== undefined) kept.set(key, survived);
    }
    return kept.size > 0 ? kept : undefined;
  }
  if (isList(node) && node.every((item) => isScalar(item))) return pathIsExposed(path, prefixes) ? [...node] : undefined;
  const kept: VarValue[] = [];
  (node as VarValue[]).forEach((child, index) => {
    const survived = pruneNode(child, path === "" ? String(index) : `${path}.${index}`, prefixes);
    if (survived !== undefined) kept.push(survived);
  });
  return kept.length > 0 ? kept : undefined;
}
