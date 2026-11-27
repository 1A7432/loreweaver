// Lore entries as documents: one `lore_entry` document per worldbook entry, so a room
// lists, edits, switches and removes entries one at a time.
//
// The entry itself is the worldbook's `ImportedEntry` (`core/worldbook/types.ts`); this
// module only stores it. The payload is every `ImportedEntry` field except `source`, which
// is provenance and lives in `meta.source` (the pack or card the entry came from; "" for an
// entry the admin wrote in the room). The document id is the entry id. Keeping `source` out
// of the payload means there is one place it is recorded, not two that can disagree.
//
// Who sees what (iron rule 3):
//   - keeper: the whole entry, every field, with its id and source.
//   - admin: a non-secret entry in full (they curate the world: keys, condition, switches);
//     a SECRET entry as its title and switches only — never its content, keys or condition.
//     The admin is also a player at the table, so the text that makes an entry secret stays
//     with the Keeper; the title is what every curation command (enable, disable, bind,
//     remove) is addressed by, so without it a secret entry could not be curated at all.
//     This is the reference server's line (`.lore list` showed the privileged human secret
//     titles) narrowed to exclude the content it never showed either.
//   - player, observer, an NPC actor: a non-secret entry as its title and content; a secret
//     entry does not exist (null) — not even its id.
// Views are built by naming the fields each viewer may have; nothing is copied wholesale,
// so a field added to the payload later is invisible until a view names it.
import type { Document, DocumentType, Json, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { MAX_ACTIVATION_ENTRIES } from "../worldbook/activation.ts";
import {
  MAX_CONDITION_CHARS,
  MAX_ENTRY_CHARS,
  MAX_GROUP_WEIGHT,
  MAX_KEY_CHARS,
  MAX_KEYS,
  MAX_TITLE_CHARS,
} from "../worldbook/import.ts";
import type { ImportedEntry, LoreEntry, Placement, SelectiveLogic } from "../worldbook/types.ts";
import { applyOverlay, type LoreOverlay } from "./overlay.ts";

export const LORE_ENTRY_TYPE = "lore_entry";

/** A room holds at most this many entries: the activation step's own input bound. */
export const MAX_ROOM_LORE_ENTRIES = MAX_ACTIVATION_ENTRIES;
/** Category names are labels, bounded like titles (the import does not cut them). */
export const MAX_CATEGORY_CHARS = MAX_TITLE_CHARS;
/** The import's own clamps, restated as the stored ranges. */
export const MAX_SCAN_DEPTH = 200;
export const MAX_INSERT_DEPTH = 10_000;
export const MAX_STICKY = 999;
export const MAX_COOLDOWN = 999;
export const MAX_DELAY = 9_999;
export const MAX_PROVENANCE_CHARS = 500;

const SELECTIVE_LOGICS: ReadonlySet<string> = new Set<SelectiveLogic>(["and_any", "not_all", "not_any", "and_all"]);
const PLACEMENTS: ReadonlySet<string> = new Set<Placement>([
  "before",
  "default",
  "after",
  "author_note_top",
  "author_note_bottom",
  "at_depth",
  "examples_top",
  "examples_bottom",
  "outlet",
]);

/** The stored payload: an `ImportedEntry` without its provenance. */
export type LoreEntryPayload = Omit<ImportedEntry, "source">;

const PAYLOAD_FIELDS: readonly (keyof LoreEntryPayload)[] = [
  "title",
  "content",
  "keys",
  "secondaryKeys",
  "selectiveLogic",
  "constant",
  "enabled",
  "secret",
  "condition",
  "priority",
  "probability",
  "caseSensitive",
  "matchWholeWords",
  "scanDepth",
  "placement",
  "depth",
  "sticky",
  "cooldown",
  "delay",
  "group",
  "groupWeight",
  "groupOverride",
  "category",
];
const PAYLOAD_FIELD_SET: ReadonlySet<string> = new Set(PAYLOAD_FIELDS);

/** The defaults of an entry the admin writes by hand (the import's own lenient defaults). */
export const LORE_ENTRY_DEFAULTS: Omit<LoreEntryPayload, "title" | "content"> = Object.freeze({
  keys: Object.freeze([]),
  secondaryKeys: Object.freeze([]),
  selectiveLogic: "and_any",
  constant: false,
  enabled: true,
  secret: false,
  condition: "",
  priority: 0,
  probability: 100,
  caseSensitive: false,
  matchWholeWords: false,
  scanDepth: 0,
  placement: "default",
  depth: 4,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  group: "",
  groupWeight: 100,
  groupOverride: false,
  category: "lore",
});

export type LoreRefusalCode =
  /** A field has the wrong type, an out-of-range number or an unknown value. */
  | "bad_field"
  /** A text field is longer than its bound. */
  | "too_long"
  /** A list holds more items than its bound. */
  | "too_many"
  /** A title or content that must say something is blank. */
  | "empty"
  /** A field the payload does not have. */
  | "unknown_field"
  /** The room already holds `MAX_ROOM_LORE_ENTRIES` entries. */
  | "limit_reached"
  /** No entry has that id or title. */
  | "not_found";

export type LoreChange<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: LoreRefusalCode; readonly path: string };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intIn(value: unknown, low: number, high: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
}

function textWithin(violations: WriteViolation[], value: unknown, path: string, max: number, nonEmpty: boolean): void {
  if (typeof value !== "string") violations.push({ code: "bad_field", path });
  else if (codePoints(value) > max) violations.push({ code: "too_long", path });
  else if (nonEmpty && value === "") violations.push({ code: "empty", path });
}

function keysWithin(violations: WriteViolation[], value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    violations.push({ code: "bad_field", path });
    return;
  }
  if (value.length > MAX_KEYS) violations.push({ code: "too_many", path });
  value.forEach((key, index) => {
    // The import drops blank keys; a stored blank key would match everything.
    if (typeof key !== "string" || key.trim() === "") violations.push({ code: "bad_field", path: `${path}.${index}` });
    else if (codePoints(key) > MAX_KEY_CHARS) violations.push({ code: "too_long", path: `${path}.${index}` });
  });
}

/** Problems with a stored entry payload; accepts everything `importLorebook` produces. */
export function validateLoreEntry(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (!PAYLOAD_FIELD_SET.has(key)) violations.push({ code: "unknown_field", path: key });
  textWithin(violations, data.title, "title", MAX_TITLE_CHARS, true);
  textWithin(violations, data.content, "content", MAX_ENTRY_CHARS, false);
  textWithin(violations, data.condition, "condition", MAX_CONDITION_CHARS, false);
  textWithin(violations, data.group, "group", MAX_TITLE_CHARS, false);
  textWithin(violations, data.category, "category", MAX_CATEGORY_CHARS, false);
  keysWithin(violations, data.keys, "keys");
  keysWithin(violations, data.secondaryKeys, "secondaryKeys");
  if (typeof data.selectiveLogic !== "string" || !SELECTIVE_LOGICS.has(data.selectiveLogic)) violations.push({ code: "bad_field", path: "selectiveLogic" });
  if (typeof data.placement !== "string" || !PLACEMENTS.has(data.placement)) violations.push({ code: "bad_field", path: "placement" });
  for (const flag of ["constant", "enabled", "secret", "caseSensitive", "matchWholeWords", "groupOverride"] as const) {
    if (typeof data[flag] !== "boolean") violations.push({ code: "bad_field", path: flag });
  }
  const ranges: readonly (readonly [keyof LoreEntryPayload, number, number])[] = [
    ["priority", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ["probability", 0, 100],
    ["scanDepth", 0, MAX_SCAN_DEPTH],
    ["depth", 0, MAX_INSERT_DEPTH],
    ["sticky", 0, MAX_STICKY],
    ["cooldown", 0, MAX_COOLDOWN],
    ["delay", 0, MAX_DELAY],
    ["groupWeight", 0, MAX_GROUP_WEIGHT],
  ];
  for (const [field, low, high] of ranges) if (!intIn(data[field], low, high)) violations.push({ code: "bad_field", path: field });
  return violations;
}

/** The stored payload and meta of an entry (`source` goes to `meta.source`). */
export function loreEntryDocument(entry: ImportedEntry): { readonly data: JsonObject; readonly meta: JsonObject } {
  const data: Record<string, Json> = {};
  for (const field of PAYLOAD_FIELDS) {
    const value = entry[field];
    data[field] = Array.isArray(value) ? [...(value as readonly string[])] : (value as Json);
  }
  return { data, meta: { source: entry.source } };
}

/** The provenance recorded on a stored entry ("" when absent or unreadable). */
export function loreSource(document: Document): string {
  const source = document.meta.source;
  return typeof source === "string" ? source : "";
}

/**
 * A stored entry read back, or null when its payload is not a valid entry. Every field is
 * named here, so whatever else a payload carries never reaches an entry.
 */
export function readLoreEntry(document: Document): LoreEntry | null {
  if (document.corrupt || validateLoreEntry(document.data).length > 0) return null;
  const data = document.data;
  return {
    id: document.id,
    source: loreSource(document),
    title: data.title as string,
    content: data.content as string,
    keys: [...(data.keys as readonly string[])],
    secondaryKeys: [...(data.secondaryKeys as readonly string[])],
    selectiveLogic: data.selectiveLogic as SelectiveLogic,
    constant: data.constant as boolean,
    enabled: data.enabled as boolean,
    secret: data.secret as boolean,
    condition: data.condition as string,
    priority: data.priority as number,
    probability: data.probability as number,
    caseSensitive: data.caseSensitive as boolean,
    matchWholeWords: data.matchWholeWords as boolean,
    scanDepth: data.scanDepth as number,
    placement: data.placement as Placement,
    depth: data.depth as number,
    sticky: data.sticky as number,
    cooldown: data.cooldown as number,
    delay: data.delay as number,
    group: data.group as string,
    groupWeight: data.groupWeight as number,
    groupOverride: data.groupOverride as boolean,
    category: data.category as string,
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The Keeper's view, and the admin's view of a non-secret entry: everything. */
export interface LoreEntryFullView extends LoreEntry {
  readonly view: "full";
}

/** The admin's view of a secret entry: enough to address and switch it, none of its text. */
export interface LoreEntrySecretTitleView {
  readonly view: "secret_title";
  readonly id: string;
  readonly title: string;
  readonly secret: true;
  readonly enabled: boolean;
  readonly constant: boolean;
  readonly source: string;
}

/** The table's view of a non-secret entry. */
export interface LoreEntryTableView {
  readonly view: "table";
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export type LoreEntryView = LoreEntryFullView | LoreEntrySecretTitleView | LoreEntryTableView;

function fullView(entry: LoreEntry): LoreEntryFullView {
  return {
    view: "full",
    id: entry.id,
    source: entry.source,
    title: entry.title,
    content: entry.content,
    keys: [...entry.keys],
    secondaryKeys: [...entry.secondaryKeys],
    selectiveLogic: entry.selectiveLogic,
    constant: entry.constant,
    enabled: entry.enabled,
    secret: entry.secret,
    condition: entry.condition,
    priority: entry.priority,
    probability: entry.probability,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    scanDepth: entry.scanDepth,
    placement: entry.placement,
    depth: entry.depth,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    group: entry.group,
    groupWeight: entry.groupWeight,
    groupOverride: entry.groupOverride,
    category: entry.category,
  };
}

/** Whether the viewer is the admin acting as themself (an actor is always player-grade). */
function isAdmin(viewer: Viewer): boolean {
  return viewer.grade === "admin" && viewer.actorId === undefined;
}

/** What `viewer` may see of one entry; null when it does not exist for them. */
export function projectLoreEntry(entry: LoreEntry, viewer: Viewer, off = !entry.enabled): LoreEntryView | null {
  if (viewer.grade === "keeper") return fullView(entry);
  if (isAdmin(viewer)) {
    if (!entry.secret) return fullView(entry);
    return { view: "secret_title", id: entry.id, title: entry.title, secret: true, enabled: entry.enabled, constant: entry.constant, source: entry.source };
  }
  // An entry that is switched off is not part of this table's world: a route not in play,
  // an option the admin turned down. For a player it does not exist, like a secret one.
  if (entry.secret || off) return null;
  return { view: "table", id: entry.id, title: entry.title, content: entry.content };
}

/**
 * Whether the stored entry is switched off, as its document records it. The admin's switch
 * lives in the keeper-side overlay, which a projection of ONE document cannot read; so the
 * effective state is written beside each entry (`meta.off`) by `syncLoreSwitches`, whenever
 * the lore or the overlay is written. A document never synced falls back to its own flag.
 */
export function loreEntryOff(document: Document, entry: LoreEntry): boolean {
  const recorded = document.meta.off;
  return typeof recorded === "boolean" ? recorded : !entry.enabled;
}

/** The writer's type is the store's; this module only passes it on. */
export interface LoreWriter {
  readonly room: string;
}

/**
 * Bring every entry's recorded switch in step with the overlay: THE one place `meta.off`
 * is written. Call it in the same commit as any write to the room's lore entries or to its
 * overlay. Returns how many documents it rewrote.
 */
export function syncLoreSwitches<W extends LoreWriter>(documents: { list(room: string, type: string): Document[]; put(writer: W, type: string, id: string, data: JsonObject, meta?: JsonObject): unknown }, writer: W, overlay: LoreOverlay): number {
  let rewritten = 0;
  for (const document of documents.list(writer.room, LORE_ENTRY_TYPE)) {
    // A payload that could not be read is never rewritten: that would save over the real one.
    if (document.corrupt) continue;
    const entry = readLoreEntry(document);
    if (entry === null) continue;
    const off = !applyOverlay(entry, overlay).enabled;
    if (document.meta.off === off) continue;
    documents.put(writer, LORE_ENTRY_TYPE, document.id, document.data, { ...document.meta, off });
    rewritten += 1;
  }
  return rewritten;
}

export const loreEntryDocumentType: DocumentType<LoreEntryView> = {
  name: LORE_ENTRY_TYPE,
  // The imported world: only a reset of the whole room removes it.
  lifecycle: { reset: "all" },
  version: 1,
  project(document, viewer) {
    const entry = readLoreEntry(document);
    return entry === null ? null : projectLoreEntry(entry, viewer, loreEntryOff(document, entry));
  },
  validate: validateLoreEntry,
};

// ---------------------------------------------------------------------------
// The admin's editing commands, as pure changes
// ---------------------------------------------------------------------------

/** What the admin may give for a new entry; everything but title and content defaults. */
export type LoreEntryInput = Partial<LoreEntryPayload> & { readonly title: string; readonly content: string };

/** What an edit may change. Provenance (`source`) and identity (`id`) are not editable. */
export type LoreEntryPatch = Partial<LoreEntryPayload>;

function refusal<T>(violations: readonly WriteViolation[]): LoreChange<T> | null {
  const first = violations[0];
  return first === undefined ? null : { ok: false, code: first.code as LoreRefusalCode, path: first.path };
}

function checked<E extends ImportedEntry>(entry: E): LoreChange<E> {
  return refusal<E>(validateLoreEntry(loreEntryDocument(entry).data)) ?? { ok: true, data: entry };
}

/**
 * A new admin-written entry (`source` ""), refused when the room is full. The title is
 * trimmed and must say something; content must too — an empty entry is never injected.
 */
export function newLoreEntry(input: LoreEntryInput, existingCount: number): LoreChange<ImportedEntry> {
  if (existingCount >= MAX_ROOM_LORE_ENTRIES) return { ok: false, code: "limit_reached", path: "" };
  const title = input.title.trim();
  if (title === "") return { ok: false, code: "empty", path: "title" };
  if (input.content.trim() === "") return { ok: false, code: "empty", path: "content" };
  const entry: ImportedEntry = { ...LORE_ENTRY_DEFAULTS, ...pickPayload(input), title, content: input.content, source: "" };
  return checked(entry);
}

// Only the payload's own fields are taken from caller input, so a stray `source` or `id`
// in a patch can never rewrite provenance or identity.
function pickPayload(input: Partial<LoreEntryPayload>): Partial<LoreEntryPayload> {
  const picked: Record<string, unknown> = {};
  for (const field of PAYLOAD_FIELDS) if (input[field] !== undefined) picked[field] = input[field];
  return picked as Partial<LoreEntryPayload>;
}

/** `entry` with `patch` applied; the result must still be a valid entry. */
export function editLoreEntry<E extends ImportedEntry>(entry: E, patch: LoreEntryPatch): LoreChange<E> {
  const picked = pickPayload(patch);
  let title = entry.title;
  if (picked.title !== undefined) {
    title = picked.title.trim();
    if (title === "") return { ok: false, code: "empty", path: "title" };
  }
  if (picked.content !== undefined && picked.content.trim() === "") return { ok: false, code: "empty", path: "content" };
  return checked({ ...entry, ...picked, title });
}

/**
 * The stored entry switched on or off. For an imported entry the admin's switch belongs in
 * the overlay instead (`switchLore`), which leaves the author's file as it was written;
 * this is for entries the room owns and for the Keeper's own edits.
 */
export function setLoreEnabled<E extends ImportedEntry>(entry: E, enabled: boolean): E {
  return entry.enabled === enabled ? entry : { ...entry, enabled };
}

/**
 * The ids a curation command addresses: the entry with exactly that id, else every entry
 * with exactly that title. A title several entries share addresses all of them — stated
 * by the count, never resolved by guessing which one was meant.
 */
export function loreTargets(entries: readonly LoreEntry[], ref: string): LoreChange<readonly string[]> {
  const byId = entries.find((entry) => entry.id === ref);
  if (byId !== undefined) return { ok: true, data: [byId.id] };
  const title = ref.trim();
  const ids = entries.filter((entry) => entry.title === title).map((entry) => entry.id);
  return ids.length === 0 ? { ok: false, code: "not_found", path: "" } : { ok: true, data: ids };
}

/** The entries left after removing what `ref` addresses, and the ids removed. */
export function removeLore(
  entries: readonly LoreEntry[],
  ref: string,
): LoreChange<{ readonly kept: readonly LoreEntry[]; readonly removed: readonly string[] }> {
  const targets = loreTargets(entries, ref);
  if (!targets.ok) return targets;
  const removed = new Set(targets.data);
  return { ok: true, data: { kept: entries.filter((entry) => !removed.has(entry.id)), removed: targets.data } };
}

/** One line of a lore listing. */
export interface LoreListItem {
  readonly entry: LoreEntryView;
  /**
   * Keeper and admin only: whether the entry is on once the overlay is applied, and
   * whether the overlay changes it at all. Absent for the table: the overlay is
   * keeper-side, so nothing about it — not even a marker — reaches a player's list.
   */
  readonly effectiveEnabled?: boolean;
  readonly overlaid?: boolean;
}

export interface LoreListOptions {
  readonly overlay?: LoreOverlay;
  /** Keeper and admin only: list only the entries that are off after the overlay. */
  readonly disabledOnly?: boolean;
}

/** The room's entries as `viewer` may list them, in stored order. */
export function listLore(entries: readonly LoreEntry[], viewer: Viewer, options: LoreListOptions = {}): LoreListItem[] {
  const curator = viewer.grade === "keeper" || isAdmin(viewer);
  const items: LoreListItem[] = [];
  for (const entry of entries) {
    const effective = options.overlay === undefined ? entry : applyOverlay(entry, options.overlay);
    // What is off after the overlay does not exist for a player.
    const view = projectLoreEntry(entry, viewer, !effective.enabled);
    if (view === null) continue;
    if (!curator) {
      items.push({ entry: view });
      continue;
    }
    if (options.disabledOnly === true && effective.enabled) continue;
    items.push({ entry: view, effectiveEnabled: effective.enabled, overlaid: effective !== entry });
  }
  return items;
}
