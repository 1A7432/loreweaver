// `[InitVar]` entries: the lorebook entries in which a world card declares its variable
// tree. Detection, unwrapping, parsing and merging follow MagVarUpdate's
// `loadInitVarData` (`src/function/initvar/variable_init.ts`) and `parseString`
// (`util/common.ts`), read at github.com/MagicalAstrogy/MagVarUpdate (branch `beta`).
import { loadYaml } from "../yaml.ts";
import { readJson5 } from "./json5.ts";
import { cloneValue, fromPlain, isMap, treeProblem, type TreeProblem, type VarMap, type VarValue } from "./tree.ts";

/**
 * Whether an entry title marks a variable declaration. MagVarUpdate tests
 * `entry.comment?.toLowerCase().includes('[initvar]')` — the brackets are part of the
 * marker, so `initvar` or `MVU INITVAR` alone is ordinary lore.
 */
export function isInitVarTitle(title: unknown): boolean {
  return typeof title === "string" && title.toLowerCase().includes("[initvar]");
}

/**
 * The declaration text inside an entry's content. MagVarUpdate unwraps an `<initvar>`
 * element and then a fenced code block before parsing (in that order, each only when
 * present). Its macro substitution (`{{user}}` and friends) is not applied: macros are
 * resolved against a live chat, and a declaration is read at import.
 */
export function initVarBody(content: string): string {
  let body = content;
  const xml = /.*<initvar>.*\n([\s\S]*)\n.*<\/initvar>.*/m.exec(body.trim());
  if (xml !== null) body = xml[1] as string;
  const fence = /```.*\n([\s\S]*)\n```/m.exec(body.trim());
  if (fence !== null) body = fence[1] as string;
  return body;
}

export type InitVarRoute = "json5" | "yaml";

export type InitVarParse =
  | { readonly ok: true; readonly tree: VarMap; readonly route: InitVarRoute }
  | { readonly ok: false; readonly code: "empty" | "unreadable" | "not_a_mapping" | TreeProblem };

/**
 * A declaration's text as a tree. MagVarUpdate's `parseString` order: text that starts
 * with `{` or `[` is read as JSON5 first and YAML second; anything else as YAML first and
 * JSON5 second. Two departures, both bounds on hostile content: YAML anchors and aliases
 * are refused (`loadYaml`; MagVarUpdate expands them, and enables `<<` merge keys), and
 * the last-resort `jsonrepair` pass MagVarUpdate tries is not done — repairing broken
 * JSON is a guess about what the author meant. YAML is 1.2 (`yes` is text, `010` is ten,
 * a repeated key is an error), as in MagVarUpdate, which uses the `yaml` package too.
 */
export function parseInitVar(text: string): InitVarParse {
  if (text.trim() === "") return { ok: false, code: "empty" };
  // JavaScript's trimStart drops a byte-order mark too, as `parseString`'s does.
  const jsonFirst = /^[[{]/.test(text.trimStart());
  const order: InitVarRoute[] = jsonFirst ? ["json5", "yaml"] : ["yaml", "json5"];
  for (const route of order) {
    const value = route === "json5" ? viaJson5(text) : viaYaml(text);
    if (value === undefined) continue;
    // A route that succeeds ends the search even when it yields no mapping, as in
    // `parseString` (YAML reads plain prose as one string; that is not a tree).
    if (!isMap(value)) return { ok: false, code: "not_a_mapping" };
    const problem = treeProblem(value);
    if (problem !== null) return { ok: false, code: problem };
    return { ok: true, tree: value, route };
  }
  return { ok: false, code: "unreadable" };
}

function viaJson5(text: string): VarValue | undefined {
  const read = readJson5(text);
  return read.ok ? read.value : undefined;
}

function viaYaml(text: string): VarValue | undefined {
  try {
    return fromPlain(loadYaml(text));
  } catch {
    return undefined;
  }
}

/**
 * Merge `incoming` into a copy of `base` the way MagVarUpdate merges several `[InitVar]`
 * entries (`correctlyMerge`: lodash `mergeWith` where a list in the incoming tree replaces
 * the old one instead of merging index by index). Mappings merge key by key; anything
 * else in `incoming` wins.
 */
export function mergeDeclarations(base: VarMap, incoming: VarMap): VarMap {
  const out = cloneValue(base) as VarMap;
  mergeInto(out, incoming);
  return out;
}

function mergeInto(target: VarMap, incoming: VarMap): void {
  for (const [key, value] of incoming) {
    const existing = target.get(key);
    if (isMap(existing) && isMap(value)) mergeInto(existing, value);
    else target.set(key, cloneValue(value));
  }
}

/**
 * Seed a room's tree from an imported declaration. MagVarUpdate assigns
 * `stat_data = { ...merged_data, ...stat_data }`: every TOP-LEVEL key already in the room
 * wins whole, so re-importing a card never resets progress, and a branch the room already
 * has is not topped up from the card. `changed` says whether any key was added.
 */
export function seedTree(existing: VarMap, declared: VarMap): { readonly tree: VarMap; readonly changed: boolean } {
  // Spread order: the declaration's keys first, in its order, then the room's other keys;
  // a key in both keeps the room's value.
  const tree: VarMap = new Map();
  let changed = false;
  for (const [key, value] of declared) {
    const own = existing.get(key);
    if (own === undefined) changed = true;
    tree.set(key, cloneValue(own === undefined ? value : own));
  }
  for (const [key, value] of existing) if (!tree.has(key)) tree.set(key, cloneValue(value));
  return { tree, changed };
}
