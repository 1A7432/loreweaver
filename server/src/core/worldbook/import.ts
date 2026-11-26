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
 * Trust: an import is either the room keeper's (`keeper`) or anyone else's (`player`).
 * Only a keeper import may set `constant` (or `@@activate`), keep a `secret` entry, or
 * seed variables from a declaration entry; a player import drops secret entries outright
 * (fail closed: honouring the flag would let a file mint keeper-only lore, ignoring it
 * would publish the keeper's text), forces `constant` off and drops declarations.
 */

import { splitDecorators } from "./decorators.ts";
import { isFrontendResidue } from "./scrub.ts";
import type { ImportedEntry, Placement, SelectiveLogic } from "./types.ts";

/** More entries than this fails the whole import (a storage and prompt-surface bound). */
export const MAX_IMPORT_ENTRIES = 200;
/** An entry longer than this (code points) is skipped and reported by title. */
export const MAX_ENTRY_CHARS = 16_000;
/** Conditions longer than this are cut (the condition language's own source limit). */
export const MAX_CONDITION_CHARS = 500;
/** Titles and individual keys are cut to this many code points. */
export const MAX_TITLE_CHARS = 200;
export const MAX_KEY_CHARS = 200;
/** At most this many primary and this many secondary keys per entry are kept. */
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

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
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

/** JSON truthiness, the way the formats' producers mean their flags. */
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

function keyList(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const keys: string[] = [];
  for (const item of items) {
    if (keys.length >= MAX_KEYS) break;
    const key = typeof item === "string" ? item : typeof item === "number" ? String(item) : "";
    if (key.trim() !== "") keys.push(cut(key, MAX_KEY_CHARS));
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

/**
 * Whether a raw entry declares variables rather than telling lore: an MVU `[InitVar]`
 * title (case-insensitive substring `initvar`), an ST `[InitialVariables]` title, or an
 * `@@initial_variables` decorator — the card splitter's definition of variable machinery.
 */
export function isVariableDeclaration(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const title = rawTitle(raw).toLowerCase();
  if (title.includes("initvar") || title.replaceAll(" ", "").includes("[initialvariables]")) return true;
  return splitDecorators(text(own(raw, "content"))).decorators.has("initial_variables");
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
  if (raws === null) return { ok: true, entries: [], skippedTitles: [], unreachableTitles: [], declarations: [] };
  if (raws.length > MAX_IMPORT_ENTRIES) return { ok: false, code: "TOO_MANY_ENTRIES" };

  const entries: ImportedEntry[] = [];
  const skippedTitles: string[] = [];
  const unreachableTitles: string[] = [];
  const declarations: VariableDeclaration[] = [];
  raws.forEach((raw, offset) => {
    if (!isRecord(raw)) return;
    if (isVariableDeclaration(raw)) {
      // Declarations are DATA for the variable tree, consumed before the content cap (a
      // large declaration is legitimate) and only on a keeper import: the tree is shared
      // room state.
      if (keeper) {
        const body = splitDecorators(text(own(raw, "content"))).body;
        if (codePoints(body) <= MAX_DECLARATION_CHARS) declarations.push({ title: cut(rawTitle(raw), MAX_TITLE_CHARS), body });
      }
      return;
    }
    const entry = normaliseEntry(raw, offset + 1, keeper, source);
    if (entry === null) return;
    const bound = charName === "" ? entry : bindEntry(entry, charName);
    if (codePoints(bound.content) > MAX_ENTRY_CHARS) {
      skippedTitles.push(bound.title);
      return;
    }
    if (bound.content === "") return;
    entries.push(bound);
    if (!bound.enabled && bound.keys.length === 0) unreachableTitles.push(bound.title);
  });
  return { ok: true, entries, skippedTitles, unreachableTitles, declarations };
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

function normaliseEntry(raw: Raw, index: number, keeper: boolean, source: string): ImportedEntry | null {
  const extensions = isRecord(own(raw, "extensions")) ? (own(raw, "extensions") as Raw) : {};
  const secret = truthy(field(raw, extensions, "secret", "secret"));
  if (secret && !keeper) return null;

  const fallbackTitle = `${source || "Lore"} ${index}`;
  let title = rawTitle(raw) || fallbackTitle;
  // ST's native `disable: true` (world-info.js checkWorldInfo: `if (entry.disable == true)`),
  // or a V2 `enabled: false`; either one switches the entry off.
  let enabled = own(raw, "disable") !== true && (own(raw, "enabled") === undefined || truthy(own(raw, "enabled")));

  const { decorators, body } = splitDecorators(text(own(raw, "content")));
  const ifValue = decorators.get("if");
  const condition = typeof ifValue === "string" ? cut(ifValue, MAX_CONDITION_CHARS) : "";
  // `@@dont_activate` never activates (checkWorldInfo); render-time decorators mark
  // frontend UI that must never reach a prompt. Both import disabled, kept and listed.
  if (decorators.has("dont_activate") || RENDER_ONLY_DECORATORS.some((name) => decorators.has(name))) enabled = false;
  if (RENDER_ONLY_TITLE.test(title)) enabled = false;
  if (body !== "" && isFrontendResidue(body)) enabled = false;
  title = cut(title.replace(GENERATE_TITLE_PREFIX, "") || fallbackTitle, MAX_TITLE_CHARS);

  // `@@activate` activates the entry like `constant` does (checkWorldInfo); it is
  // subject to the same trust rule, so only a keeper import honours either.
  const constant = keeper && (truthy(own(raw, "constant")) || decorators.has("activate"));

  const selective = own(raw, "selective");
  const secondaryKeys = selective === undefined || truthy(selective) ? keyList(first(raw, "secondary_keys", "keysecondary")) : [];
  const useProbability = field(raw, extensions, "useProbability", "useProbability", "use_probability");
  const probability = useProbability === undefined || truthy(useProbability) ? clamp(toInt(field(raw, extensions, "probability", "probability"), 100), 0, 100) : 100;
  const groupWeight = toInt(field(raw, extensions, "group_weight", "groupWeight", "group_weight"), 100);

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
    caseSensitive: truthy(field(raw, extensions, "case_sensitive", "case_sensitive", "caseSensitive")),
    matchWholeWords: truthy(field(raw, extensions, "match_whole_words", "match_whole_words", "matchWholeWords")),
    scanDepth: clamp(toInt(field(raw, extensions, "scan_depth", "scan_depth", "scanDepth"), 0), 0, 200),
    placement: placement(field(raw, extensions, "position", "position")),
    depth: clamp(toInt(field(raw, extensions, "depth", "depth"), DEFAULT_DEPTH), 0, 10_000),
    sticky: clamp(toInt(field(raw, extensions, "sticky", "sticky"), 0), 0, 999),
    cooldown: clamp(toInt(field(raw, extensions, "cooldown", "cooldown"), 0), 0, 999),
    delay: clamp(toInt(field(raw, extensions, "delay", "delay"), 0), 0, 9999),
    group: cut(text(field(raw, extensions, "group", "group")), MAX_TITLE_CHARS),
    // ST keeps a stored weight of 0 (`entry.extensions?.group_weight ?? DEFAULT_WEIGHT`):
    // such a member can only win when every member weighs 0.
    groupWeight: clamp(groupWeight, 0, MAX_GROUP_WEIGHT),
    groupOverride: truthy(field(raw, extensions, "group_override", "groupOverride", "group_override")),
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
