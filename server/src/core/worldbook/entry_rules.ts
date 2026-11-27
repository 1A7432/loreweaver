/**
 * How an imported lore entry's kind and flags are read: the ONE definition the card split
 * (`core/card/split.ts`, which half of a card is world) and the lore import (`import.ts`,
 * what is stored) share, so the two can never disagree about an entry.
 *
 * - **Secret.** `secret` at the entry and `extensions.secret` are both read. Each must be
 *   absent (or null) or a JSON boolean; `true` at EITHER level makes the entry keeper-only,
 *   so `extensions` can never make public what the top level marks secret, nor the other
 *   way round. Any other value (`1`, `"true"`, `"false"`, an object) is `invalid`: the
 *   split counts such an entry as keeper-only (fail closed) and the lore import refuses
 *   it. `secret` is Loreweaver's own key, not SillyTavern's, so no file in the wild has a
 *   looser spelling of it to honour — the native lorecard reads it the same way.
 * - **SillyTavern's flags** (`disable`, `enabled`, `constant`, `selective`,
 *   `useProbability`, `caseSensitive`, `matchWholeWords`, `groupOverride`): SillyTavern
 *   tests some of them loosely (`entry.disable == true`), and files in the wild write
 *   `0`/`1` and sometimes the strings for them. Exactly the spellings in
 *   `ST_FLAG_SPELLINGS` are read — `null` among them, as false, the way SillyTavern's own
 *   `!entry.enabled` and `entry.selective || false` read it; absent is the field's
 *   default; anything else is `invalid` and refuses the entry. Never "whatever
 *   JavaScript finds truthy".
 * - **Variable declarations** (`[InitVar]`): `isVariableDeclaration`.
 */

import { isInitVarTitle } from "../variables/index.ts";
import { splitDecorators } from "./decorators.ts";

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(raw: Raw, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

/** A flag as read: its value, `absent` (the field's default), or `invalid`. */
export type FlagRead = boolean | "absent" | "invalid";

/**
 * The spellings a SillyTavern flag may take, and what each means: the JSON booleans, null
 * (false), the numbers 1 and 0, and the strings `"true"`, `"false"`, `"1"`, `"0"` (exactly;
 * no case folding, no trimming).
 */
export const ST_FLAG_SPELLINGS: ReadonlyMap<unknown, boolean> = new Map<unknown, boolean>([
  [true, true],
  [null, false],
  [false, false],
  [1, true],
  [0, false],
  ["true", true],
  ["false", false],
  ["1", true],
  ["0", false],
]);

/** A SillyTavern flag value read against `ST_FLAG_SPELLINGS`; `absent` when missing. */
export function readStFlag(value: unknown): FlagRead {
  if (value === undefined) return "absent";
  const read = ST_FLAG_SPELLINGS.get(value);
  return read === undefined ? "invalid" : read;
}

/** A strict flag: a JSON boolean, `absent` when missing or null, `invalid` otherwise. */
export function readStrictFlag(value: unknown): FlagRead {
  if (value === undefined || value === null) return "absent";
  return typeof value === "boolean" ? value : "invalid";
}

export type Secrecy = "secret" | "public" | "invalid";

/** Whether an entry is keeper-only (see the file header). Never throws. */
export function entrySecrecy(entry: unknown): Secrecy {
  if (!isRecord(entry)) return "public";
  const extensions = own(entry, "extensions");
  const levels = [readStrictFlag(own(entry, "secret")), isRecord(extensions) ? readStrictFlag(own(extensions, "secret")) : "absent"];
  if (levels.includes("invalid")) return "invalid";
  return levels.includes(true) ? "secret" : "public";
}

/** An entry's title for recognition: `title`, else `comment`, else `name` — the first non-empty string. */
export function entryTitle(entry: unknown): string {
  if (!isRecord(entry)) return "";
  for (const field of ["title", "comment", "name"]) {
    const value = own(entry, field);
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/**
 * Whether an entry declares variables rather than telling lore — exactly when one holds:
 * its title (`entryTitle`), lower-cased, contains `[initvar]` (MagVarUpdate's marker, the
 * brackets included: `initvar notes` is lore); that title with spaces removed, lower-cased,
 * contains `[initialvariables]`; or its content (a string) starts with an
 * `@@initial_variables` decorator line.
 */
export function isVariableDeclaration(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const title = entryTitle(entry);
  if (isInitVarTitle(title) || title.replace(/ /g, "").toLowerCase().includes("[initialvariables]")) return true;
  const content = own(entry, "content");
  return splitDecorators(typeof content === "string" ? content : "").decorators.has("initial_variables");
}
