// The lore overlay: the admin's switches over imported lore, as one `lore_overlay`
// document per room.
//
// An imported lorebook is stored faithfully — a file that says an entry is off keeps
// saying so — because re-importing a revised card has to be a clean replace, not a merge
// with somebody's edits. The overlay is where the table's own decisions go instead: per
// entry TITLE, an effective `enabled` and an effective `condition`. A re-import replaces
// the lore and leaves the overlay alone.
//
// What was decided (docs/notes/implemented/lore-overlay-and-setup.md) and is kept here:
// - Keyed by title, not id: ids change on every import, titles are what an admin types
//   and what a pack author knows. Two entries sharing a title share an annotation.
// - No inference: nothing reads a title for structure, groups entries into families or
//   matches by pattern. A title is addressed exactly (only `restoreLore("*")` means all).
// - `applyOverlay` is THE one definition of an entry's effective state; every activation
//   path consumes it, so there is no second "enabled" to bypass.
// - An overlay never widens what players see: it changes `enabled` and `condition` and
//   nothing else. It cannot make a secret entry public, rewrite content, or (as a pack
//   file) publish the whole variable tree.
// - A condition is the CLOSED expression language only, checked at write time and again
//   on read: a stored string the closed grammar refuses would otherwise reach the
//   template sandbox's JavaScript fallback, so an overlay from a restored backup or a
//   hand-edited database cannot smuggle code in.
// - "Set before play" items ride the same document and stay pending until the table
//   writes that path; a re-import keeps the `done` state.
//
// Who sees it: the Keeper and the admin (who writes it) see all of it; for everyone else
// it does not exist. Never part of a player import.
import { compile, ExprError, MAX_SOURCE_LENGTH } from "../condexpr.ts";
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { MAX_TITLE_CHARS } from "../worldbook/import.ts";
import type { ImportedEntry } from "../worldbook/types.ts";

export const LORE_OVERLAY_TYPE = "lore_overlay";
export const LORE_OVERLAY_ID = "overlay";
/** The pack overlay FILE's format marker; a file without it is refused. */
export const OVERLAY_FILE_FORMAT = "loreweaver.lore-overlay/1";

/** Annotation, not content: far above any real card, and a bound a hostile file cannot grow past. */
export const MAX_OVERLAY_ENTRIES = 200;
export const MAX_SETUP_ITEMS = 64;
export const MAX_SETUP_OPTIONS = 20;
export const MAX_SETUP_PATH_CHARS = 200;
export const MAX_SETUP_OPTION_CHARS = 200;
export const MAX_SETUP_LABEL_CHARS = 50;
export const MAX_SETUP_LABELS = 16;
export const MAX_LOCALE_CHARS = 16;
export const MAX_EXPOSE_PREFIXES = 32;
export const MAX_OVERLAY_CONDITION_CHARS = MAX_SOURCE_LENGTH;

/** What the overlay says about one title. `enabled` absent: the file decides. */
export interface OverlaySwitch {
  readonly enabled?: boolean;
  /** Replaces the file's condition when non-empty. */
  readonly condition: string;
}

export interface SetupLabel {
  readonly locale: string;
  readonly text: string;
}

/** One "set before play" choice the table owes the module. */
export interface SetupItem {
  /** A module-variable id or a dotted path into the imported variable tree. */
  readonly path: string;
  readonly options: readonly string[];
  readonly labels: readonly SetupLabel[];
  readonly done: boolean;
}

export interface LoreOverlay {
  /** Title → switch, in the order titles were first annotated. A `Map`, so any title is an ordinary key. */
  readonly entries: ReadonlyMap<string, OverlaySwitch>;
  readonly setup: readonly SetupItem[];
}

export const EMPTY_OVERLAY: LoreOverlay = Object.freeze({ entries: new Map<string, OverlaySwitch>(), setup: Object.freeze([]) });

export type OverlayRefusalCode =
  | "empty"
  | "too_long"
  | "too_many"
  | "bad_field"
  | "unknown_field"
  | "bad_condition"
  | "limit_reached"
  | "duplicate"
  | "bad_format"
  /** A pack file asked to publish the whole variable tree (`*`): only the admin at the table may. */
  | "expose_everything";

export type OverlayChange<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: OverlayRefusalCode; readonly path: string };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse<T>(code: OverlayRefusalCode, path: string): OverlayChange<T> {
  return { ok: false, code, path };
}

/** A condition cleaned (trimmed) and checked against the closed grammar; "" clears it. */
export function checkCondition(condition: string): OverlayChange<string> {
  const text = condition.trim();
  if (text === "") return { ok: true, data: "" };
  if (codePoints(text) > MAX_OVERLAY_CONDITION_CHARS) return refuse("too_long", "condition");
  try {
    // The same compile the lore step evaluates a condition with, so "accepted here" means
    // "decided by the closed grammar there" — never handed to the JavaScript fallback.
    compile(text);
  } catch (error) {
    if (error instanceof ExprError) return refuse("bad_condition", "condition");
    throw error;
  }
  return { ok: true, data: text };
}

function checkTitle(title: string): OverlayChange<string> {
  const text = title.trim();
  if (text === "") return refuse("empty", "title");
  if (codePoints(text) > MAX_TITLE_CHARS) return refuse("too_long", "title");
  return { ok: true, data: text };
}

// ---------------------------------------------------------------------------
// The one effective-state function
// ---------------------------------------------------------------------------

/**
 * `entry` as the room actually sees it — THE single definition of effective state. Returns
 * the same object when the overlay changes nothing, so a room without an overlay is
 * identical on every path. Only `enabled` and `condition` can change.
 */
export function applyOverlay<E extends ImportedEntry>(entry: E, overlay: LoreOverlay): E {
  const override = overlay.entries.get(entry.title);
  if (override === undefined) return entry;
  const enabled = override.enabled !== undefined && override.enabled !== entry.enabled ? override.enabled : entry.enabled;
  const condition = override.condition !== "" && override.condition !== entry.condition ? override.condition : entry.condition;
  if (enabled === entry.enabled && condition === entry.condition) return entry;
  return { ...entry, enabled, condition };
}

/** Whether the overlay changes this entry at all (the listing's marker). */
export function overlayChanges(entry: ImportedEntry, overlay: LoreOverlay): boolean {
  return applyOverlay(entry, overlay) !== entry;
}

/**
 * Overlay titles no entry carries any more — a card revision renamed or dropped them.
 * Kept rather than pruned (the admin may be mid-re-import) and removed by `restoreLore`.
 */
export function staleOverlayTitles(overlay: LoreOverlay, titles: Iterable<string>): string[] {
  const present = new Set(titles);
  return [...overlay.entries.keys()].filter((title) => !present.has(title));
}

// ---------------------------------------------------------------------------
// Changes (never mutate their input)
// ---------------------------------------------------------------------------

/**
 * Write one title's switch. `enabled`/`condition` left undefined keep that half; `enabled:
 * null` hands the switch back to the file, `condition: ""` clears the gate; a switch left
 * saying nothing is removed. Refused: a blank or over-long title, a condition the
 * closed grammar refuses, a new title past `MAX_OVERLAY_ENTRIES`.
 */
export function setOverlaySwitch(
  overlay: LoreOverlay,
  title: string,
  change: { readonly enabled?: boolean | null; readonly condition?: string },
): OverlayChange<LoreOverlay> {
  const name = checkTitle(title);
  if (!name.ok) return name;
  const current = overlay.entries.get(name.data);
  let condition = current?.condition ?? "";
  if (change.condition !== undefined) {
    const checkedCondition = checkCondition(change.condition);
    if (!checkedCondition.ok) return checkedCondition;
    condition = checkedCondition.data;
  }
  const enabled = change.enabled === undefined ? current?.enabled : change.enabled === null ? undefined : change.enabled;
  const entries = new Map(overlay.entries);
  if (enabled === undefined && condition === "") {
    entries.delete(name.data);
  } else {
    if (current === undefined && entries.size >= MAX_OVERLAY_ENTRIES) return refuse("limit_reached", "entries");
    entries.set(name.data, enabled === undefined ? { condition } : { enabled, condition });
  }
  return { ok: true, data: { entries, setup: overlay.setup } };
}

/** `.lore enable` / `.lore disable`: the title switched on or off. */
export function switchLore(overlay: LoreOverlay, title: string, enabled: boolean): OverlayChange<LoreOverlay> {
  return setOverlaySwitch(overlay, title, { enabled });
}

/**
 * `.lore bind`: gate the title on a condition. A binding implies the switch — a condition
 * on an entry the file left off would be an inert trap that nothing ever fires.
 */
export function bindLore(overlay: LoreOverlay, title: string, condition: string): OverlayChange<LoreOverlay> {
  if (condition.trim() === "") return refuse("empty", "condition");
  return setOverlaySwitch(overlay, title, { enabled: true, condition });
}

/** `.lore unbind`: drop the title's condition, keep its switch. */
export function unbindLore(overlay: LoreOverlay, title: string): OverlayChange<LoreOverlay> {
  return setOverlaySwitch(overlay, title, { condition: "" });
}

/**
 * `.lore restore`: drop a title's annotation (back to the file's own state); `"*"` drops
 * every one. The setup items stay — they are the table's open choices, not annotations.
 */
export function restoreLore(overlay: LoreOverlay, title: string): { readonly overlay: LoreOverlay; readonly removed: number } {
  const name = title.trim();
  if (name === "*") return { overlay: { entries: new Map(), setup: overlay.setup }, removed: overlay.entries.size };
  if (!overlay.entries.has(name)) return { overlay, removed: 0 };
  const entries = new Map(overlay.entries);
  entries.delete(name);
  return { overlay: { entries, setup: overlay.setup }, removed: 1 };
}

/**
 * Merge declared setup items in, keeping the `done` state of paths already tracked: a
 * re-import of the same module must not re-open a choice the table already made. Refused
 * whole when the merge would pass `MAX_SETUP_ITEMS`.
 */
export function mergeSetupItems(overlay: LoreOverlay, items: readonly SetupItem[]): OverlayChange<LoreOverlay> {
  const merged = [...overlay.setup];
  for (const item of items) {
    const index = merged.findIndex((existing) => existing.path === item.path);
    if (index >= 0) {
      merged[index] = { ...item, done: merged[index]?.done ?? false };
      continue;
    }
    if (merged.length >= MAX_SETUP_ITEMS) return refuse("limit_reached", "setup");
    merged.push(item);
  }
  return { ok: true, data: { entries: overlay.entries, setup: merged } };
}

/** Record that the table has written `path`; whoever wrote it, the choice is made. */
export function markSetupDone(overlay: LoreOverlay, path: string): { readonly overlay: LoreOverlay; readonly changed: boolean } {
  const target = path.trim();
  const index = overlay.setup.findIndex((item) => item.path === target && !item.done);
  if (index < 0) return { overlay, changed: false };
  const setup = overlay.setup.map((item, at) => (at === index ? { ...item, done: true } : item));
  return { overlay: { entries: overlay.entries, setup }, changed: true };
}

/** The setup choices still owed. */
export function pendingSetup(overlay: LoreOverlay): SetupItem[] {
  return overlay.setup.filter((item) => !item.done);
}

/** A setup item's label for `locale`: exact language, then English, then any, then the path. */
export function setupLabel(item: SetupItem, locale: string): string {
  const language = (locale.split("-")[0] ?? "").toLowerCase();
  return (
    item.labels.find((label) => label.locale === language)?.text ??
    item.labels.find((label) => label.locale === "en")?.text ??
    item.labels[0]?.text ??
    item.path
  );
}

// ---------------------------------------------------------------------------
// The stored payload
// ---------------------------------------------------------------------------
// `{ entries: [{ title, enabled?, condition }], setup: [{ path, options, labels: [{ locale, text }], done }] }`
// Lists of pairs rather than objects keyed by title: titles are content, and `__proto__`,
// `constructor` or `10` must stay ordinary keys in written order.

/** The payload for an overlay. */
export function overlayData(overlay: LoreOverlay): JsonObject {
  return {
    entries: [...overlay.entries].map(([title, entry]): JsonObject =>
      entry.enabled === undefined ? { title, condition: entry.condition } : { title, enabled: entry.enabled, condition: entry.condition },
    ),
    setup: overlay.setup.map((item) => ({
      path: item.path,
      options: [...item.options],
      labels: item.labels.map((label) => ({ locale: label.locale, text: label.text })),
      done: item.done,
    })),
  };
}

function readSetupItem(raw: unknown, at: string, violations: WriteViolation[]): SetupItem | null {
  if (!isRecord(raw)) {
    violations.push({ code: "bad_field", path: at });
    return null;
  }
  for (const key of Object.keys(raw)) if (!["path", "options", "labels", "done"].includes(key)) violations.push({ code: "unknown_field", path: `${at}.${key}` });
  const before = violations.length;
  const path = raw.path;
  if (typeof path !== "string" || path.trim() === "" || path !== path.trim()) violations.push({ code: "bad_field", path: `${at}.path` });
  else if (codePoints(path) > MAX_SETUP_PATH_CHARS) violations.push({ code: "too_long", path: `${at}.path` });
  const options = raw.options;
  if (!Array.isArray(options)) violations.push({ code: "bad_field", path: `${at}.options` });
  else {
    if (options.length > MAX_SETUP_OPTIONS) violations.push({ code: "too_many", path: `${at}.options` });
    options.forEach((option, index) => {
      if (typeof option !== "string" || option.trim() === "") violations.push({ code: "bad_field", path: `${at}.options.${index}` });
      else if (codePoints(option) > MAX_SETUP_OPTION_CHARS) violations.push({ code: "too_long", path: `${at}.options.${index}` });
    });
  }
  const labels = raw.labels;
  if (!Array.isArray(labels)) violations.push({ code: "bad_field", path: `${at}.labels` });
  else {
    if (labels.length > MAX_SETUP_LABELS) violations.push({ code: "too_many", path: `${at}.labels` });
    labels.forEach((label, index) => {
      const where = `${at}.labels.${index}`;
      if (!isRecord(label) || typeof label.locale !== "string" || typeof label.text !== "string" || label.locale === "" || label.text.trim() === "") {
        violations.push({ code: "bad_field", path: where });
      } else if (codePoints(label.locale) > MAX_LOCALE_CHARS || codePoints(label.text) > MAX_SETUP_LABEL_CHARS) {
        violations.push({ code: "too_long", path: where });
      }
    });
  }
  if (typeof raw.done !== "boolean") violations.push({ code: "bad_field", path: `${at}.done` });
  if (violations.length > before) return null;
  return {
    path: path as string,
    options: [...(options as readonly string[])],
    labels: (labels as readonly Readonly<Record<string, string>>[]).map((label) => ({ locale: label.locale as string, text: label.text as string })),
    done: raw.done as boolean,
  };
}

/** Problems with an overlay payload. */
export function validateOverlay(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (key !== "entries" && key !== "setup") violations.push({ code: "unknown_field", path: key });
  const entries = data.entries;
  if (!Array.isArray(entries)) violations.push({ code: "bad_field", path: "entries" });
  else {
    if (entries.length > MAX_OVERLAY_ENTRIES) violations.push({ code: "too_many", path: "entries" });
    const seen = new Set<string>();
    entries.forEach((raw, index) => {
      const at = `entries.${index}`;
      if (!isRecord(raw)) {
        violations.push({ code: "bad_field", path: at });
        return;
      }
      for (const key of Object.keys(raw)) if (!["title", "enabled", "condition"].includes(key)) violations.push({ code: "unknown_field", path: `${at}.${key}` });
      const title = raw.title;
      if (typeof title !== "string") violations.push({ code: "bad_field", path: `${at}.title` });
      else {
        const checkedTitle = checkTitle(title);
        if (!checkedTitle.ok || checkedTitle.data !== title) violations.push({ code: checkedTitle.ok ? "bad_field" : checkedTitle.code, path: `${at}.title` });
        if (seen.has(title)) violations.push({ code: "duplicate", path: `${at}.title` });
        seen.add(title);
      }
      if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") violations.push({ code: "bad_field", path: `${at}.enabled` });
      if (typeof raw.condition !== "string") violations.push({ code: "bad_field", path: `${at}.condition` });
      else {
        const condition = checkCondition(raw.condition);
        if (!condition.ok || condition.data !== raw.condition) violations.push({ code: condition.ok ? "bad_field" : condition.code, path: `${at}.condition` });
      }
      if (raw.enabled === undefined && raw.condition === "") violations.push({ code: "empty", path: at });
    });
  }
  const setup = data.setup;
  if (!Array.isArray(setup)) violations.push({ code: "bad_field", path: "setup" });
  else {
    if (setup.length > MAX_SETUP_ITEMS) violations.push({ code: "too_many", path: "setup" });
    const seen = new Set<string>();
    setup.forEach((raw, index) => {
      const item = readSetupItem(raw, `setup.${index}`, violations);
      if (item === null) return;
      if (seen.has(item.path)) violations.push({ code: "duplicate", path: `setup.${index}.path` });
      seen.add(item.path);
    });
  }
  return violations;
}

/**
 * A stored overlay read back. Tolerant, and fail-closed per entry: a malformed entry is
 * skipped and a condition the closed grammar refuses is dropped (the entry keeps its
 * switch, loses its gate). The worst case is the module's own shipped state — never an
 * exception on the activation path, never an unchecked string reaching the sandbox.
 */
export function readOverlay(data: JsonObject): LoreOverlay {
  const entries = new Map<string, OverlaySwitch>();
  if (Array.isArray(data.entries)) {
    for (const raw of data.entries.slice(0, MAX_OVERLAY_ENTRIES)) {
      if (!isRecord(raw) || typeof raw.title !== "string") continue;
      const title = checkTitle(raw.title);
      if (!title.ok || entries.has(title.data)) continue;
      const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
      const condition = typeof raw.condition === "string" ? checkCondition(raw.condition) : null;
      const gate = condition !== null && condition.ok ? condition.data : "";
      if (enabled === undefined && gate === "") continue;
      entries.set(title.data, enabled === undefined ? { condition: gate } : { enabled, condition: gate });
    }
  }
  const setup: SetupItem[] = [];
  if (Array.isArray(data.setup)) {
    for (const raw of data.setup.slice(0, MAX_SETUP_ITEMS)) {
      const item = readSetupItem(raw, "", []);
      if (item !== null && !setup.some((existing) => existing.path === item.path)) setup.push(item);
    }
  }
  return { entries, setup };
}

export interface OverlaySetupView {
  readonly path: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly done: boolean;
}

export interface LoreOverlayView {
  readonly entries: readonly { readonly title: string; readonly enabled?: boolean; readonly condition: string }[];
  readonly setup: readonly OverlaySetupView[];
}

function projectOverlay(document: Document, viewer: Viewer): LoreOverlayView | null {
  const curator = viewer.grade === "keeper" || (viewer.grade === "admin" && viewer.actorId === undefined);
  if (!curator) return null;
  const overlay = readOverlay(document.data);
  return {
    entries: [...overlay.entries].map(([title, entry]) =>
      entry.enabled === undefined ? { title, condition: entry.condition } : { title, enabled: entry.enabled, condition: entry.condition },
    ),
    setup: overlay.setup.map((item) => ({ path: item.path, label: setupLabel(item, viewer.locale), options: [...item.options], done: item.done })),
  };
}

export const loreOverlayDocumentType: DocumentType<LoreOverlayView> = {
  name: LORE_OVERLAY_TYPE,
  // Annotation of the imported world: it leaves with the world, and survives a story or
  // character reset — replaying the scenario must not revert the choices the table made.
  lifecycle: { reset: "all" },
  version: 1,
  project: projectOverlay,
  validate: validateOverlay,
};

// ---------------------------------------------------------------------------
// The pack overlay FILE (already parsed from YAML)
// ---------------------------------------------------------------------------

export interface OverlayFile {
  readonly overlay: LoreOverlay;
  /**
   * Variable-tree prefixes the file asks to put on the players' panel. Not stored here:
   * exposure has one owner, the variable tree document. Explicit prefixes only.
   */
  readonly expose: readonly string[];
}

/**
 * A pack's overlay file. Strict: an annotation file that half-loads would leave a module
 * half-alive with nothing reporting it. A title the card does not carry is NOT an error
 * here (cards get revised) — `staleOverlayTitles` reports it.
 */
export function readOverlayFile(raw: unknown): OverlayChange<OverlayFile> {
  if (!isRecord(raw)) return refuse("bad_format", "");
  if (raw.format !== OVERLAY_FILE_FORMAT) return refuse("bad_format", "format");
  for (const key of Object.keys(raw)) if (!["format", "entries", "setup", "expose"].includes(key)) return refuse("unknown_field", key);

  let overlay: LoreOverlay = EMPTY_OVERLAY;
  const entries = raw.entries ?? null;
  if (entries !== null) {
    // `title: {enabled, condition}` (docs/lwf/formats/cards.md §9). The YAML reader has
    // already refused `__proto__` and key orders JavaScript would rearrange.
    if (!isRecord(entries)) return refuse("bad_field", "entries");
    const titles = Object.keys(entries);
    if (titles.length > MAX_OVERLAY_ENTRIES) return refuse("too_many", "entries");
    for (const [index, title] of titles.entries()) {
      const at = `entries.${index}`;
      const body = entries[title];
      if (!isRecord(body)) return refuse("bad_field", at);
      for (const key of Object.keys(body)) if (key !== "enabled" && key !== "condition") return refuse("unknown_field", `${at}.${key}`);
      const enabled = body.enabled ?? null;
      if (enabled !== null && typeof enabled !== "boolean") return refuse("bad_field", `${at}.enabled`);
      const condition = body.condition ?? "";
      if (typeof condition !== "string") return refuse("bad_field", `${at}.condition`);
      if (overlay.entries.has(title.trim())) return refuse("duplicate", at);
      // A condition implies the switch, exactly as `bindLore` does.
      const switched = enabled ?? (condition.trim() !== "" ? true : null);
      const next = setOverlaySwitch(overlay, title, { enabled: switched, condition });
      if (!next.ok) return refuse(next.code, `${at}.${next.path}`);
      overlay = next.data;
    }
  }

  const setup = raw.setup ?? null;
  if (setup !== null) {
    if (!Array.isArray(setup)) return refuse("bad_field", "setup");
    if (setup.length > MAX_SETUP_ITEMS) return refuse("too_many", "setup");
    const items: SetupItem[] = [];
    for (const [index, body] of setup.entries()) {
      const at = `setup.${index}`;
      if (!isRecord(body)) return refuse("bad_field", at);
      // `done` is the table's state, never something a file may pre-set.
      for (const key of Object.keys(body)) if (!["path", "options", "labels"].includes(key)) return refuse("unknown_field", `${at}.${key}`);
      const labels = fileLabels(body.labels ?? null);
      if (labels === null) return refuse("bad_field", `${at}.labels`);
      const path = typeof body.path === "string" ? body.path.trim() : body.path;
      // Options are scalars in the file; a number or boolean is the text it reads as.
      const options = Array.isArray(body.options)
        ? body.options.map((option) => (typeof option === "number" || typeof option === "boolean" ? String(option) : typeof option === "string" ? option.trim() : option))
        : (body.options ?? []);
      const violations: WriteViolation[] = [];
      const item = readSetupItem({ path, options, labels, done: false }, at, violations);
      const first = violations[0];
      if (item === null || first !== undefined) return refuse((first?.code ?? "bad_field") as OverlayRefusalCode, first?.path ?? at);
      if (items.some((existing) => existing.path === item.path)) return refuse("duplicate", `${at}.path`);
      items.push(item);
    }
    overlay = { entries: overlay.entries, setup: items };
  }

  const expose = raw.expose ?? null;
  const prefixes: string[] = [];
  if (expose !== null) {
    const list = typeof expose === "string" ? [expose] : expose;
    if (!Array.isArray(list)) return refuse("bad_field", "expose");
    if (list.length > MAX_EXPOSE_PREFIXES) return refuse("too_many", "expose");
    for (const [index, prefix] of list.entries()) {
      if (typeof prefix !== "string" || prefix.trim() === "") return refuse("bad_field", `expose.${index}`);
      // "Publish the whole tree" is a judgement about one table's spoilers; only the
      // admin sitting at it may make it, never a pack.
      if (prefix.trim().startsWith("*")) return refuse("expose_everything", `expose.${index}`);
      if (!prefixes.includes(prefix.trim())) prefixes.push(prefix.trim());
    }
  }
  return { ok: true, data: { overlay, expose: prefixes } };
}

/**
 * A file writes labels as a mapping of locale to text (`labels: { en: Difficulty }`); the
 * stored form is a list of pairs. Locales are reduced to their language.
 */
function fileLabels(raw: unknown): { locale: string; text: string }[] | null {
  if (raw === null) return [];
  if (!isRecord(raw)) return null;
  const labels: { locale: string; text: string }[] = [];
  for (const locale of Object.keys(raw)) {
    const text = raw[locale];
    if (typeof text !== "string") return null;
    labels.push({ locale: (locale.split("-")[0] ?? "").toLowerCase(), text: text.trim() });
  }
  return labels;
}
