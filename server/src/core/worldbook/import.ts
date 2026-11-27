/**
 * Lorebook import: SillyTavern's native world-info format and the V2/V3 `character_book`
 * format (and this engine's own field names) normalised into one `ImportedEntry`.
 *
 * Field sources, per SillyTavern `public/scripts/world-info.js`:
 * - a native world-info file stores entries keyed by uid with `key`, `keysecondary`,
 *   `comment`, `order`, `disable`, `position` (0..7), `selectiveLogic` (0..3),
 *   `probability`/`useProbability`, `group`/`groupWeight`/`groupOverride`, `scanDepth`,
 *   `caseSensitive`, `matchWholeWords`, `sticky`/`cooldown`/`delay`, `depth`
 *   (`newWorldInfoEntryDefinition`);
 * - a character book is converted by `convertCharacterBook`, which reads `keys`,
 *   `secondary_keys`, `insertion_order`, `enabled`, `position` ('before_char'/'after_char')
 *   and takes EVERY trigger field from the entry's `extensions` object
 *   (`extensions.position`, `.depth`, `.probability`, `.useProbability`, `.selectiveLogic`,
 *   `.group`, `.group_override`, `.group_weight`, `.scan_depth`, `.case_sensitive`,
 *   `.match_whole_words`, `.sticky`, `.cooldown`, `.delay`).
 * Both spellings are accepted on any entry. A value under `extensions` wins over a
 * top-level one, as in `convertCharacterBook`; a top-level value is still read when the
 * extension is absent, so a hand-written book that puts `probability` at the top level
 * keeps working.
 *
 * Deliberately NOT copied from `convertCharacterBook`: it treats a V2 entry WITHOUT
 * `enabled` as disabled (`disable: !entry.enabled`), without `selective` as ignoring its
 * secondary keys (`selective: entry.selective || false`) and without `position` as
 * "after". Those three fields are required or defaulted by the V2 spec, and the books
 * this engine has always imported omit them freely; an absent field keeps the lenient
 * default (enabled, selective, default placement) instead of silently switching entries
 * off.
 *
 * Flags, keeper-only lore and declarations are read by `entry_rules.ts`, the definition the
 * card split shares: a flag value outside the accepted spellings refuses the entry.
 *
 * Nothing is cut to fit: a title, key or group past its bound, more keys than `MAX_KEYS`, or
 * a condition past `MAX_CONDITION_CHARS` (half a condition is a different rule) refuses the
 * ENTRY, and the rest of the book imports. Every entry left out is counted in the result
 * (`leftOut`, or `skippedTitles` for over-long content), with its reason.
 *
 * Trust: an import is either the room keeper's (`keeper`) or anyone else's (`player`).
 * Only a keeper import may set `constant` (or `@@activate`), keep a `secret` entry, or
 * seed variables from a declaration entry; a player import drops secret entries outright
 * (fail closed: honouring the flag would let a file mint keeper-only lore, ignoring it
 * would publish the keeper's text), forces `constant` off and drops declarations.
 */

import { splitDecorators } from "./decorators.ts";
import { entrySecrecy, isVariableDeclaration, type FlagRead, readStFlag } from "./entry_rules.ts";
import { isFrontendResidue } from "./scrub.ts";
import type { ImportedEntry, Placement, SelectiveLogic } from "./types.ts";

/** More entries than this fails the whole import (a storage and prompt-surface bound). */
export const MAX_IMPORT_ENTRIES = 200;
/** An entry longer than this (code points) is skipped and reported by title. */
export const MAX_ENTRY_CHARS = 16_000;
/** A longer condition refuses its entry (the condition language's own source limit). */
export const MAX_CONDITION_CHARS = 500;
/** A longer title (after `{{char}}` binding), key or group refuses its entry. */
export const MAX_TITLE_CHARS = 200;
export const MAX_KEY_CHARS = 200;
/** More primary, or more secondary, keys than this refuses the entry. */
export const MAX_KEYS = 64;
/** A declaration body (`[InitVar]`) is not lore and has its own, larger bound. */
export const MAX_DECLARATION_CHARS = 200_000;
/** SillyTavern clamps `groupWeight` to 1..10000 in its editor (world-info.js). */
export const MAX_GROUP_WEIGHT = 10_000;

export type ImportTrust = "keeper" | "player";

export interface ImportOptions {
  readonly trust: ImportTrust;
  /** Provenance written on every entry; also the fallback title prefix. */
  readonly source?: string;
  /** A card's character name: `{{char}}`, `<char>`, `<BOT>` bind to it statically. */
  readonly charName?: string;
}

/** A variable-declaration entry (`[InitVar]`, `[InitialVariables]`, `@@initial_variables`). */
export interface VariableDeclaration {
  readonly title: string;
  /** The entry content without its decorator lines: the declaration's source text. */
  readonly body: string;
}

export type ImportErrorCode = "TOO_MANY_ENTRIES";

/**
 * Why an entry was left out of an import (over-long content is `skippedTitles`):
 * `not_an_object`; `flag_not_boolean` (a flag outside its accepted spellings — `field` says
 * which; `secret` is strictly boolean); `secret_untrusted` / `declaration_untrusted` (a
 * player import may not mint keeper-only lore or seed variables); `declaration_too_long`
 * (over `MAX_DECLARATION_CHARS`); `condition_too_long`, `title_too_long`, `key_too_long`,
 * `too_many_keys`, `group_too_long` (over their bounds, nothing cut); `empty` (nothing left
 * once decorators were taken off).
 */
export const LEFT_OUT_REASONS = [
  "not_an_object",
  "flag_not_boolean",
  "secret_untrusted",
  "declaration_untrusted",
  "declaration_too_long",
  "condition_too_long",
  "title_too_long",
  "key_too_long",
  "too_many_keys",
  "group_too_long",
  "empty",
] as const;
export type LeftOutReason = (typeof LEFT_OUT_REASONS)[number];

export interface LeftOutEntry {
  /** The entry's title as far as it could be read (`""` when none). */
  readonly title: string;
  readonly reason: LeftOutReason;
  /** The field at fault, when one is. */
  readonly field?: string;
}

export type ImportResult =
  | {
      readonly ok: true;
      /** Entries to store, in the book's order. */
      readonly entries: readonly ImportedEntry[];
      /** Titles of entries left out for exceeding `MAX_ENTRY_CHARS`. */
      readonly skippedTitles: readonly string[];
      /** Titles of stored entries that are disabled AND keyless: nothing can ever fire them. */
      readonly unreachableTitles: readonly string[];
      /** Declaration entries consumed (keeper imports only; a player import returns none). */
      readonly declarations: readonly VariableDeclaration[];
      /** Every other entry not stored, in book order, with the reason. */
      readonly leftOut: readonly LeftOutEntry[];
    }
  | { readonly ok: false; readonly code: ImportErrorCode };

type Raw = Readonly<Record<string, unknown>>;

const LOGIC_BY_CODE: readonly SelectiveLogic[] = ["and_any", "not_all", "not_any", "and_all"];
const LOGIC_NAMES: ReadonlySet<string> = new Set(LOGIC_BY_CODE);
// world_info_position in world-info.js, by numeric code.
const PLACEMENT_BY_CODE: readonly Placement[] = [
  "before",
  "after",
  "author_note_top",
  "author_note_bottom",
  "at_depth",
  "examples_top",
  "examples_bottom",
  "outlet",
];
const DEFAULT_DEPTH = 4;
const RENDER_ONLY_DECORATORS: readonly string[] = ["render_before", "render_after", "iframe", "message_formatting"];
const RENDER_ONLY_TITLE = /^\s*\[RENDER:/iu;
const GENERATE_TITLE_PREFIX = /^\s*\[GENERATE:[^\]]{0,500}\]\s*/iu;
const CHAR_MACRO = /\{\{\s*char\s*\}\}|<char>|<BOT>/giu;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(raw: Raw, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

/** The first of `keys` present (not undefined/null) on `raw`. */
function first(raw: Raw, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = own(raw, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** `extensions.<extKey>` when set, else the first top-level key present. */
function field(raw: Raw, extensions: Raw, extKey: string, ...topKeys: string[]): unknown {
  const fromExtension = own(extensions, extKey);
  if (fromExtension !== undefined && fromExtension !== null) return fromExtension;
  return first(raw, ...topKeys);
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Python-`int()`-like coercion of a JSON value; `fallback` for anything unreadable. */
function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?\d{1,15}\s*$/u.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** JSON truthiness: which numbers and booleans `text` prints (flags are `entry_rules.ts`'s). */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return truthy(value) ? String(value) : "";
  return "";
}

/** Every non-blank key (strings, and numbers as text); the bounds are checked by the caller. */
function keyList(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const keys: string[] = [];
  for (const item of items) {
    const key = typeof item === "string" ? item : typeof item === "number" ? String(item) : "";
    if (key.trim() !== "") keys.push(key);
  }
  return keys;
}

function selectiveLogic(value: unknown): SelectiveLogic {
  if (typeof value === "number" && Number.isInteger(value)) return LOGIC_BY_CODE[value] ?? "and_any";
  if (typeof value === "string" && LOGIC_NAMES.has(value)) return value as SelectiveLogic;
  return "and_any";
}

function placement(value: unknown): Placement {
  if (typeof value === "number" && Number.isInteger(value)) return PLACEMENT_BY_CODE[value] ?? "default";
  if (value === "before_char") return "before";
  if (value === "after_char") return "after";
  return "default";
}

/** Replaces a card's `{{char}}` (and ST's older `<char>` / `<BOT>`) with the name, literally. */
export function bindCharName(textValue: string, charName: string): string {
  if (textValue === "" || charName === "") return textValue;
  return textValue.replace(CHAR_MACRO, () => charName);
}

function rawTitle(raw: Raw): string {
  return text(own(raw, "title")) || text(own(raw, "comment")) || text(own(raw, "name"));
}

/** The entries of a book: an `entries` list, an `entries` object keyed by uid, or a bare list. */
function rawEntries(book: unknown): unknown[] | null {
  const entries = isRecord(book) ? own(book, "entries") : book;
  if (Array.isArray(entries)) return entries;
  if (isRecord(entries)) return Object.values(entries);
  return null;
}

/** Normalises one book into entries to store. Pure; the caller stores and assigns ids. */
export function importLorebook(book: unknown, options: ImportOptions): ImportResult {
  const keeper = options.trust === "keeper";
  const source = options.source ?? "";
  const charName = options.charName ?? "";
  const raws = rawEntries(book);
  if (raws === null) return { ok: true, entries: [], skippedTitles: [], unreachableTitles: [], declarations: [], leftOut: [] };
  if (raws.length > MAX_IMPORT_ENTRIES) return { ok: false, code: "TOO_MANY_ENTRIES" };

  const entries: ImportedEntry[] = [];
  const skippedTitles: string[] = [];
  const unreachableTitles: string[] = [];
  const declarations: VariableDeclaration[] = [];
  const leftOut: LeftOutEntry[] = [];
  raws.forEach((raw, offset) => {
    if (!isRecord(raw)) {
      leftOut.push({ title: "", reason: "not_an_object" });
      return;
    }
    if (isVariableDeclaration(raw)) {
      // Declarations are DATA for the variable tree, consumed before the content cap (a
      // large declaration is legitimate) and only on a keeper import: the tree is shared
      // room state.
      const title = rawTitle(raw);
      if (!keeper) leftOut.push({ title, reason: "declaration_untrusted" });
      else {
        const body = splitDecorators(text(own(raw, "content"))).body;
        if (codePoints(body) > MAX_DECLARATION_CHARS) leftOut.push({ title, reason: "declaration_too_long" });
        else if (codePoints(title) > MAX_TITLE_CHARS) leftOut.push({ title, reason: "title_too_long", field: "title" });
        else declarations.push({ title, body });
      }
      return;
    }
    const entry = normaliseEntry(raw, offset + 1, keeper, source);
    if ("reason" in entry) {
      leftOut.push(entry);
      return;
    }
    const bound = charName === "" ? entry : bindEntry(entry, charName);
    if (codePoints(bound.content) > MAX_ENTRY_CHARS) {
      skippedTitles.push(bound.title);
      return;
    }
    const overBound = boundProblem(bound);
    if (overBound !== null) {
      leftOut.push({ title: bound.title, ...overBound });
      return;
    }
    if (bound.content === "") {
      leftOut.push({ title: bound.title, reason: "empty" });
      return;
    }
    entries.push(bound);
    if (!bound.enabled && bound.keys.length === 0) unreachableTitles.push(bound.title);
  });
  return { ok: true, entries, skippedTitles, unreachableTitles, declarations, leftOut };
}

/** The first bound an entry breaks once its `{{char}}` is bound, or null. */
function boundProblem(entry: ImportedEntry): { reason: LeftOutReason; field: string } | null {
  if (codePoints(entry.title) > MAX_TITLE_CHARS) return { reason: "title_too_long", field: "title" };
  for (const [field, keys] of [["keys", entry.keys], ["secondary_keys", entry.secondaryKeys]] as const) {
    if (keys.length > MAX_KEYS) return { reason: "too_many_keys", field };
    if (keys.some((key) => codePoints(key) > MAX_KEY_CHARS)) return { reason: "key_too_long", field };
  }
  return null;
}

function bindEntry(entry: ImportedEntry, charName: string): ImportedEntry {
  return {
    ...entry,
    title: bindCharName(entry.title, charName),
    content: bindCharName(entry.content, charName),
    keys: entry.keys.map((key) => bindCharName(key, charName)),
    secondaryKeys: entry.secondaryKeys.map((key) => bindCharName(key, charName)),
  };
}

/** The SillyTavern flags of an entry, each read by `readStFlag`, `extensions` first where SillyTavern puts it there. */
const ST_FLAGS = ["disable", "enabled", "constant", "selective", "useProbability", "caseSensitive", "matchWholeWords", "groupOverride"] as const;

function stFlags(raw: Raw, extensions: Raw): Readonly<Record<(typeof ST_FLAGS)[number], FlagRead>> {
  return {
    disable: readStFlag(own(raw, "disable")),
    enabled: readStFlag(own(raw, "enabled")),
    constant: readStFlag(own(raw, "constant")),
    selective: readStFlag(own(raw, "selective")),
    useProbability: readStFlag(field(raw, extensions, "useProbability", "useProbability", "use_probability")),
    caseSensitive: readStFlag(field(raw, extensions, "case_sensitive", "case_sensitive", "caseSensitive")),
    matchWholeWords: readStFlag(field(raw, extensions, "match_whole_words", "match_whole_words", "matchWholeWords")),
    groupOverride: readStFlag(field(raw, extensions, "group_override", "groupOverride", "group_override")),
  };
}

function normaliseEntry(raw: Raw, index: number, keeper: boolean, source: string): ImportedEntry | LeftOutEntry {
  const extensions = isRecord(own(raw, "extensions")) ? (own(raw, "extensions") as Raw) : {};
  const fallbackTitle = `${source || "Lore"} ${index}`;
  let title = rawTitle(raw) || fallbackTitle;
  const secrecy = entrySecrecy(raw);
  if (secrecy === "invalid") return { title, reason: "flag_not_boolean", field: "secret" };
  const secret = secrecy === "secret";
  if (secret && !keeper) return { title, reason: "secret_untrusted" };
  const flags = stFlags(raw, extensions);
  const invalid = ST_FLAGS.find((name) => flags[name] === "invalid");
  if (invalid !== undefined) return { title, reason: "flag_not_boolean", field: invalid };

  // ST's native `disable: true` (world-info.js checkWorldInfo: `if (entry.disable == true)`),
  // or a V2 `enabled: false`; either one switches the entry off.
  let enabled = flags.disable !== true && flags.enabled !== false;

  const { decorators, body } = splitDecorators(text(own(raw, "content")));
  const ifValue = decorators.get("if");
  const condition = typeof ifValue === "string" ? ifValue : "";
  if (codePoints(condition) > MAX_CONDITION_CHARS) return { title, reason: "condition_too_long", field: "condition" };
  // `@@dont_activate` never activates (checkWorldInfo); render-time decorators mark
  // frontend UI that must never reach a prompt. Both import disabled, kept and listed.
  if (decorators.has("dont_activate") || RENDER_ONLY_DECORATORS.some((name) => decorators.has(name))) enabled = false;
  if (RENDER_ONLY_TITLE.test(title)) enabled = false;
  if (body !== "" && isFrontendResidue(body)) enabled = false;
  title = title.replace(GENERATE_TITLE_PREFIX, "") || fallbackTitle;

  // `@@activate` activates the entry like `constant` does (checkWorldInfo); it is
  // subject to the same trust rule, so only a keeper import honours either.
  const constant = keeper && (flags.constant === true || decorators.has("activate"));

  const secondaryKeys = flags.selective !== false ? keyList(first(raw, "secondary_keys", "keysecondary")) : [];
  const probability = flags.useProbability !== false ? clamp(toInt(field(raw, extensions, "probability", "probability"), 100), 0, 100) : 100;
  const groupWeight = toInt(field(raw, extensions, "group_weight", "groupWeight", "group_weight"), 100);
  const group = text(field(raw, extensions, "group", "group"));
  if (codePoints(group) > MAX_TITLE_CHARS) return { title, reason: "group_too_long", field: "group" };

  return {
    title,
    content: body,
    keys: keyList(first(raw, "keys", "key")),
    secondaryKeys,
    selectiveLogic: selectiveLogic(field(raw, extensions, "selectiveLogic", "selective_logic", "selectiveLogic")),
    constant,
    enabled,
    secret,
    condition,
    priority: toInt(first(raw, "priority", "insertion_order", "order"), 0),
    probability,
    caseSensitive: flags.caseSensitive === true,
    matchWholeWords: flags.matchWholeWords === true,
    scanDepth: clamp(toInt(field(raw, extensions, "scan_depth", "scan_depth", "scanDepth"), 0), 0, 200),
    placement: placement(field(raw, extensions, "position", "position")),
    depth: clamp(toInt(field(raw, extensions, "depth", "depth"), DEFAULT_DEPTH), 0, 10_000),
    sticky: clamp(toInt(field(raw, extensions, "sticky", "sticky"), 0), 0, 999),
    cooldown: clamp(toInt(field(raw, extensions, "cooldown", "cooldown"), 0), 0, 999),
    delay: clamp(toInt(field(raw, extensions, "delay", "delay"), 0), 0, 9999),
    group,
    // ST keeps a stored weight of 0 (`entry.extensions?.group_weight ?? DEFAULT_WEIGHT`):
    // such a member can only win when every member weighs 0.
    groupWeight: clamp(groupWeight, 0, MAX_GROUP_WEIGHT),
    groupOverride: flags.groupOverride === true,
    category: text(field(raw, extensions, "category", "category")) || "lore",
    source,
  };
}

/**
 * What survives of `existing` when an import from `source` lands: a KEEPER re-import of
 * a named source replaces that source's entries; anything else adds. Keeper-only on
 * purpose — a player file named after the module must not be able to delete the keeper's
 * lore and substitute its own.
 */
export function keptOnReimport<T extends { readonly source: string }>(
  existing: readonly T[],
  options: Pick<ImportOptions, "trust" | "source">,
): T[] {
  const source = options.source ?? "";
  if (options.trust !== "keeper" || source === "") return [...existing];
  return existing.filter((entry) => entry.source !== source);
}
