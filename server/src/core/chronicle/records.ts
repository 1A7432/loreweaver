// Chronicle records: the campaign's durable memory, one `chronicle_record` document per
// material turn. The worldbook is what the AUTHOR wrote; the chronicle is what the TABLE
// did. The two never share a store.
//
// A record's `text` is one player-grade line — what happened, as the table saw it. What
// the players MISSED (a secret consequence now armed, who was really behind the door)
// goes in `keeper`, which never reaches a player-grade view and never enters the fold
// input either, so a summarizer cannot copy it into the player-facing summary.
//
// `turn` is the turn the record is about, stamped by the engine: nothing records ahead of
// the fiction. Records are history only — the fold's no-future guard depends on it.
//
// Who sees what:
//   - keeper: everything, including the annotation and whether the record is folded;
//   - admin, player, observer, an NPC actor: the turn, the line, the characters and the
//     scene — the public record of what happened. Nothing else.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";

export const CHRONICLE_RECORD_TYPE = "chronicle_record";

export const MAX_RECORD_TEXT_CHARS = 2_000;
export const MAX_RECORD_KEEPER_CHARS = 2_000;
export const MAX_RECORD_CHARACTERS = 16;
export const MAX_CHARACTER_NAME_CHARS = 100;
export const MAX_SCENE_CHARS = 200;
/** Record ids are `c` plus six digits, so they sort in the order they were written. */
export const MAX_RECORD_SEQUENCE = 999_999;

export interface ChronicleRecord {
  readonly turn: number;
  readonly text: string;
  /** The characters the record concerns, by display name, in the order given. */
  readonly characters: readonly string[];
  readonly scene: string;
  /** Keeper-only annotation. */
  readonly keeper: string;
  /** Whether the record has been folded into the campaign summary (keeper-side bookkeeping). */
  readonly folded: boolean;
}

export type ChronicleRefusalCode = "empty" | "too_long" | "too_many" | "bad_field" | "unknown_field" | "bad_turn" | "limit_reached";

export type ChronicleChange<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: ChronicleRefusalCode; readonly path: string };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** A turn number a record can carry: an integer from 1. Turn 0 is "before play", not history. */
export function isRecordTurn(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

const RECORD_FIELDS: ReadonlySet<string> = new Set(["turn", "text", "characters", "scene", "keeper", "folded"]);

export function validateChronicleRecord(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (!RECORD_FIELDS.has(key)) violations.push({ code: "unknown_field", path: key });
  if (!isRecordTurn(data.turn)) violations.push({ code: "bad_turn", path: "turn" });
  const text = data.text;
  if (typeof text !== "string") violations.push({ code: "bad_field", path: "text" });
  else if (text.trim() === "") violations.push({ code: "empty", path: "text" });
  else if (codePoints(text) > MAX_RECORD_TEXT_CHARS) violations.push({ code: "too_long", path: "text" });
  for (const [field, max] of [
    ["keeper", MAX_RECORD_KEEPER_CHARS],
    ["scene", MAX_SCENE_CHARS],
  ] as const) {
    const value = data[field];
    if (typeof value !== "string") violations.push({ code: "bad_field", path: field });
    else if (codePoints(value) > max) violations.push({ code: "too_long", path: field });
  }
  const characters = data.characters;
  if (!Array.isArray(characters)) violations.push({ code: "bad_field", path: "characters" });
  else {
    if (characters.length > MAX_RECORD_CHARACTERS) violations.push({ code: "too_many", path: "characters" });
    characters.forEach((name, index) => {
      if (typeof name !== "string" || name.trim() === "") violations.push({ code: "bad_field", path: `characters.${index}` });
      else if (codePoints(name) > MAX_CHARACTER_NAME_CHARS) violations.push({ code: "too_long", path: `characters.${index}` });
    });
  }
  if (typeof data.folded !== "boolean") violations.push({ code: "bad_field", path: "folded" });
  return violations;
}

/** The payload for a record. */
export function chronicleRecordData(record: ChronicleRecord): JsonObject {
  return {
    turn: record.turn,
    text: record.text,
    characters: [...record.characters],
    scene: record.scene,
    keeper: record.keeper,
    folded: record.folded,
  };
}

/** A stored record read back, or null when the payload is not a valid record. */
export function readChronicleRecord(data: JsonObject): ChronicleRecord | null {
  if (validateChronicleRecord(data).length > 0) return null;
  return {
    turn: data.turn as number,
    text: data.text as string,
    characters: [...(data.characters as readonly string[])],
    scene: data.scene as string,
    keeper: data.keeper as string,
    folded: data.folded as boolean,
  };
}

/** The id of the `sequence`-th record of a room. */
export function chronicleRecordId(sequence: number): ChronicleChange<string> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) return { ok: false, code: "bad_field", path: "sequence" };
  if (sequence > MAX_RECORD_SEQUENCE) return { ok: false, code: "limit_reached", path: "sequence" };
  return { ok: true, data: `c${String(sequence).padStart(6, "0")}` };
}

export interface ChronicleRecordInput {
  readonly text: string;
  readonly keeper?: string;
  readonly characters?: readonly string[];
  readonly scene?: string;
}

/**
 * A new record for `turn` — the engine's own turn index, never a model's argument. Text is
 * trimmed; character names are trimmed, blanks dropped and repeats folded into one.
 */
export function newChronicleRecord(input: ChronicleRecordInput, turn: number): ChronicleChange<ChronicleRecord> {
  if (!isRecordTurn(turn)) return { ok: false, code: "bad_turn", path: "turn" };
  const characters: string[] = [];
  for (const name of input.characters ?? []) {
    const trimmed = name.trim();
    if (trimmed !== "" && !characters.includes(trimmed)) characters.push(trimmed);
  }
  const record: ChronicleRecord = {
    turn,
    text: input.text.trim(),
    characters,
    scene: (input.scene ?? "").trim(),
    keeper: (input.keeper ?? "").trim(),
    folded: false,
  };
  const first = validateChronicleRecord(chronicleRecordData(record))[0];
  return first === undefined ? { ok: true, data: record } : { ok: false, code: first.code as ChronicleRefusalCode, path: first.path };
}

/** The record marked as folded into the summary. */
export function markRecordFolded(record: ChronicleRecord): ChronicleRecord {
  return record.folded ? record : { ...record, folded: true };
}

/** The keeper's view: the whole record. */
export type ChronicleRecordKeeperView = ChronicleRecord;

/** Everyone else's view: the public record of what happened. */
export interface ChronicleRecordPublicView {
  readonly turn: number;
  readonly text: string;
  readonly characters: readonly string[];
  readonly scene: string;
}

export type ChronicleRecordView = ChronicleRecordKeeperView | ChronicleRecordPublicView;

export function projectChronicleRecord(record: ChronicleRecord, viewer: Viewer): ChronicleRecordView {
  if (viewer.grade === "keeper") return { ...record, characters: [...record.characters] };
  return { turn: record.turn, text: record.text, characters: [...record.characters], scene: record.scene };
}

export const chronicleRecordDocumentType: DocumentType<ChronicleRecordView> = {
  name: CHRONICLE_RECORD_TYPE,
  // What play produced: a story reset clears it.
  lifecycle: { reset: "story" },
  version: 1,
  project(document: Document, viewer: Viewer) {
    const record = readChronicleRecord(document.data);
    return record === null ? null : projectChronicleRecord(record, viewer);
  },
  validate: validateChronicleRecord,
};
