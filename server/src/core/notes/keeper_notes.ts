// The Keeper's working notebook: notes filed under categories the Keeper names
// ("improvised_scenes", "npc_status", "world_changes", "player_actions", "reasoning"…).
// It is the Keeper's private memory, so it does not exist for anyone else: every view but
// the Keeper's is null. What the table may see lives elsewhere — the scene and the facts
// established for the table (`scene.ts`).
//
// Payload `{ categories: [{ name, entries: [{ text, at }] }] }`, categories in the order
// they were first written (a list, because category names are content). `at` is the game
// clock's text when the note was written, or null.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { cleanText, isRecord, onlyKeys } from "./text.ts";

export const KEEPER_NOTES_TYPE = "keeper_notes";
export const KEEPER_NOTES_ID = "notes";

export const MAX_NOTE_CATEGORIES = 32;
/** A category name, in code points. */
export const MAX_CATEGORY_CHARS = 48;
export const MAX_NOTES_PER_CATEGORY = 64;
/** One note, in code points. */
export const MAX_NOTE_CHARS = 1000;
/** The game-clock text stamped on a note. */
export const MAX_NOTE_AT_CHARS = 80;

export type Note = { readonly text: string; readonly at: string | null };
export type NoteCategory = { readonly name: string; readonly entries: readonly Note[] };
export type KeeperNotes = { readonly categories: readonly NoteCategory[] };

export const EMPTY_NOTES: KeeperNotes = Object.freeze({ categories: Object.freeze([]) });

export type NotesRefusal =
  | "bad_category"
  | "bad_note"
  | "bad_at"
  | "too_many_categories"
  | "category_full"
  /** No such category. */
  | "unknown_category"
  /** The category has no note to revise. */
  | "empty_category";

export type NotesChange = { readonly ok: true; readonly data: KeeperNotes } | { readonly ok: false; readonly code: NotesRefusal };

function cleanNote(text: string, at: string | null): Note | NotesRefusal {
  const clean = cleanText(text, MAX_NOTE_CHARS);
  if (clean === null) return "bad_note";
  if (at !== null && cleanText(at, MAX_NOTE_AT_CHARS) !== at) return "bad_at";
  return Object.freeze({ text: clean, at });
}

/** The category's entries replaced; a new category is appended, an emptied one removed. */
function withEntries(notes: KeeperNotes, name: string, entries: readonly Note[]): NotesChange {
  const at = notes.categories.findIndex((category) => category.name === name);
  const category: NoteCategory = Object.freeze({ name, entries: Object.freeze([...entries]) });
  let categories: NoteCategory[];
  if (at >= 0) categories = notes.categories.map((item, index) => (index === at ? category : item));
  else {
    if (notes.categories.length >= MAX_NOTE_CATEGORIES) return { ok: false, code: "too_many_categories" };
    categories = [...notes.categories, category];
  }
  return { ok: true, data: Object.freeze({ categories: Object.freeze(categories.filter((item) => item.entries.length > 0)) }) };
}

/** The notes filed under `category`, oldest first; empty when there is none. */
export function notesIn(notes: KeeperNotes, category: string): readonly Note[] {
  return notes.categories.find((item) => item.name === category.trim())?.entries ?? [];
}

/** File one more note under `category`. */
export function addNote(notes: KeeperNotes, category: string, text: string, at: string | null): NotesChange {
  const name = cleanText(category, MAX_CATEGORY_CHARS);
  if (name === null) return { ok: false, code: "bad_category" };
  const note = cleanNote(text, at);
  if (typeof note === "string") return { ok: false, code: note };
  const entries = notesIn(notes, name);
  if (entries.length >= MAX_NOTES_PER_CATEGORY) return { ok: false, code: "category_full" };
  return withEntries(notes, name, [...entries, note]);
}

/** Make `text` the category's only note: a single-value category ("current threat"). */
export function setNote(notes: KeeperNotes, category: string, text: string, at: string | null): NotesChange {
  const name = cleanText(category, MAX_CATEGORY_CHARS);
  if (name === null) return { ok: false, code: "bad_category" };
  const note = cleanNote(text, at);
  if (typeof note === "string") return { ok: false, code: note };
  return withEntries(notes, name, [note]);
}

/** Rewrite the category's latest note, keeping its clock stamp. */
export function reviseLastNote(notes: KeeperNotes, category: string, text: string): NotesChange {
  const name = category.trim();
  const found = notes.categories.find((item) => item.name === name);
  if (found === undefined) return { ok: false, code: "unknown_category" };
  const last = found.entries.at(-1);
  if (last === undefined) return { ok: false, code: "empty_category" };
  const note = cleanNote(text, last.at);
  if (typeof note === "string") return { ok: false, code: note };
  return withEntries(notes, name, [...found.entries.slice(0, -1), note]);
}

/** Remove a whole category. */
export function dropCategory(notes: KeeperNotes, category: string): NotesChange {
  const name = category.trim();
  if (!notes.categories.some((item) => item.name === name)) return { ok: false, code: "unknown_category" };
  return { ok: true, data: Object.freeze({ categories: Object.freeze(notes.categories.filter((item) => item.name !== name)) }) };
}

export function keeperNotesData(notes: KeeperNotes): JsonObject {
  return {
    categories: notes.categories.map((category) => ({
      name: category.name,
      entries: category.entries.map((note) => ({ text: note.text, at: note.at })),
    })),
  };
}

function readNoteList(raw: unknown): Note[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: Note[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.text !== "string" || (item.at !== null && typeof item.at !== "string")) return null;
    entries.push(Object.freeze({ text: item.text, at: item.at }));
  }
  return entries;
}

/** A stored notebook read back; null when malformed. */
export function readKeeperNotes(data: JsonObject): KeeperNotes | null {
  if (!Array.isArray(data.categories)) return null;
  const categories: NoteCategory[] = [];
  for (const item of data.categories) {
    if (!isRecord(item) || typeof item.name !== "string") return null;
    const entries = readNoteList(item.entries);
    if (entries === null) return null;
    categories.push(Object.freeze({ name: item.name, entries: Object.freeze(entries) }));
  }
  return Object.freeze({ categories: Object.freeze(categories) });
}

export type KeeperNotesView = KeeperNotes;

function projectKeeperNotes(document: Document, viewer: Viewer): KeeperNotesView | null {
  if (viewer.grade !== "keeper") return null;
  return readKeeperNotes(document.data);
}

/** Problems with one stored note, shared with the other notebook types of this directory. */
export function noteViolations(raw: unknown, path: string, maxText: number): WriteViolation[] {
  if (!isRecord(raw) || onlyKeys(raw, ["text", "at"]) !== null) return [{ code: "bad_entry", path }];
  const violations: WriteViolation[] = [];
  if (typeof raw.text !== "string" || cleanText(raw.text, maxText) !== raw.text) violations.push({ code: "bad_note", path: `${path}.text` });
  if (raw.at !== null && (typeof raw.at !== "string" || cleanText(raw.at, MAX_NOTE_AT_CHARS) !== raw.at)) violations.push({ code: "bad_at", path: `${path}.at` });
  return violations;
}

function validateKeeperNotes(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["categories"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  if (!Array.isArray(data.categories)) return [{ code: "bad_categories", path: "categories" }];
  const violations: WriteViolation[] = [];
  if (data.categories.length > MAX_NOTE_CATEGORIES) violations.push({ code: "too_many_categories", path: "categories" });
  const names = new Set<string>();
  data.categories.forEach((item, index) => {
    const path = `categories.${index}`;
    if (!isRecord(item) || onlyKeys(item, ["name", "entries"]) !== null) {
      violations.push({ code: "bad_category", path });
      return;
    }
    if (typeof item.name !== "string" || cleanText(item.name, MAX_CATEGORY_CHARS) !== item.name) violations.push({ code: "bad_category", path: `${path}.name` });
    else if (names.has(item.name)) violations.push({ code: "duplicate_category", path: `${path}.name` });
    else names.add(String(item.name));
    if (!Array.isArray(item.entries) || item.entries.length === 0) {
      violations.push({ code: "bad_entries", path: `${path}.entries` });
      return;
    }
    if (item.entries.length > MAX_NOTES_PER_CATEGORY) violations.push({ code: "category_full", path: `${path}.entries` });
    item.entries.forEach((entry, at) => violations.push(...noteViolations(entry, `${path}.entries.${at}`, MAX_NOTE_CHARS)));
  });
  return violations;
}

export const keeperNotesDocument: DocumentType<KeeperNotesView> = {
  name: KEEPER_NOTES_TYPE,
  lifecycle: { reset: "story" },
  version: 1,
  project: projectKeeperNotes,
  validate: validateKeeperNotes,
};
