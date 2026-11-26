// Relationship tracks: how one named entity feels toward another, as bounded numbers the
// engine keeps and the Keeper narrates around (iron rule 1 — the values are code, the
// warmth is the model's). Directional: Alice's affection for Bob need not equal Bob's for
// Alice. Subjects and targets are display names (PCs, NPCs, companions).
//
// One `relationships` document per room: `{ tracks: [{ subject, target, track, value }] }`,
// a list (names are content: `__proto__` or `10` must stay ordinary) in the order pairs
// were first written, at most one row per (subject, target, track).
//
// Who sees what:
//   - keeper: every row;
//   - an NPC actor: the rows where it is the subject (by its actor id) — its own feelings
//     are its own knowledge, and it needs them to speak in character;
//   - admin, player, observer: nothing. An NPC's real feeling toward a character is often
//     exactly what the table is meant to discover through play (the smiling patron who is
//     quietly hostile), and the admin is a player at that table.
// Lifecycle `story`: the values are produced by play. A story reset replays the scenario
// with the NPCs meeting the characters for the first time; a character or full reset is
// wider and clears them too.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";

export const RELATIONSHIPS_TYPE = "relationships";
export const RELATIONSHIPS_ID = "relationships";

export const MAX_RELATIONSHIP_ROWS = 1_000;
export const MAX_RELATIONSHIP_NAME_CHARS = 100;

export interface RelationshipTrack {
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

/** The tracks the engine keeps; a value is always within its track's bounds. */
export const RELATIONSHIP_TRACKS: ReadonlyMap<string, RelationshipTrack> = new Map([
  ["affection", { min: -100, max: 100, initial: 0 }],
  ["desire", { min: 0, max: 100, initial: 0 }],
]);

export interface RelationshipRow {
  readonly subject: string;
  readonly target: string;
  readonly track: string;
  readonly value: number;
}

export interface Relationships {
  readonly tracks: readonly RelationshipRow[];
}

export const NO_RELATIONSHIPS: Relationships = Object.freeze({ tracks: Object.freeze([]) });

export type RelationshipRefusalCode =
  /** Not one of `RELATIONSHIP_TRACKS`. */
  | "unknown_track"
  /** A delta or value that is not a safe integer. */
  | "not_an_integer"
  /** A blank name. */
  | "empty"
  | "too_long"
  /** A new row past `MAX_RELATIONSHIP_ROWS`. */
  | "limit_reached";

export type RelationshipChange =
  | { readonly ok: true; readonly data: Relationships; readonly old: number; readonly value: number }
  | { readonly ok: false; readonly code: RelationshipRefusalCode; readonly path: string };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` held within `track`'s bounds — a bounded track's meaning, not a truncation. */
function bound(track: RelationshipTrack, value: number): number {
  return Math.min(track.max, Math.max(track.min, value));
}

/** The current value of a track (its initial value when never written). */
export function relationshipValue(state: Relationships, subject: string, target: string, track: string): number {
  const row = state.tracks.find((item) => item.subject === subject && item.target === target && item.track === track);
  return row?.value ?? RELATIONSHIP_TRACKS.get(track)?.initial ?? 0;
}

function write(state: Relationships, subjectName: string, targetName: string, trackId: string, next: (old: number, track: RelationshipTrack) => number): RelationshipChange {
  const track = RELATIONSHIP_TRACKS.get(trackId);
  if (track === undefined) return { ok: false, code: "unknown_track", path: "track" };
  const subject = subjectName.trim();
  const target = targetName.trim();
  for (const [path, name] of [
    ["subject", subject],
    ["target", target],
  ] as const) {
    if (name === "") return { ok: false, code: "empty", path };
    if (codePoints(name) > MAX_RELATIONSHIP_NAME_CHARS) return { ok: false, code: "too_long", path };
  }
  const index = state.tracks.findIndex((row) => row.subject === subject && row.target === target && row.track === trackId);
  if (index < 0 && state.tracks.length >= MAX_RELATIONSHIP_ROWS) return { ok: false, code: "limit_reached", path: "tracks" };
  const old = index < 0 ? track.initial : (state.tracks[index]?.value ?? track.initial);
  const value = bound(track, next(old, track));
  const row: RelationshipRow = { subject, target, track: trackId, value };
  const tracks = index < 0 ? [...state.tracks, row] : state.tracks.map((item, at) => (at === index ? row : item));
  return { ok: true, data: { tracks }, old, value };
}

/** Nudge a track by a signed whole `delta`; the result stays within the track's bounds. */
export function adjustRelationship(state: Relationships, subject: string, target: string, track: string, delta: number): RelationshipChange {
  if (!Number.isSafeInteger(delta)) return { ok: false, code: "not_an_integer", path: "delta" };
  return write(state, subject, target, track, (old) => old + delta);
}

/** Set a track to a whole `value`, held within the track's bounds. */
export function setRelationship(state: Relationships, subject: string, target: string, track: string, value: number): RelationshipChange {
  if (!Number.isSafeInteger(value)) return { ok: false, code: "not_an_integer", path: "value" };
  return write(state, subject, target, track, () => value);
}

/**
 * The rows that differ from their track's initial value, optionally only those where
 * `entity` is subject or target — sorted by subject, target, track (code-point order), so
 * the same state always reads the same (the Keeper's prompt depends on that).
 */
export function changedRelationships(state: Relationships, entity?: string): RelationshipRow[] {
  const compare = (left: string, right: string): number => {
    const a = Array.from(left);
    const b = Array.from(right);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const difference = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
      if (difference !== 0) return difference;
    }
    return a.length - b.length;
  };
  return state.tracks
    .filter((row) => row.value !== (RELATIONSHIP_TRACKS.get(row.track)?.initial ?? 0))
    .filter((row) => entity === undefined || row.subject === entity || row.target === entity)
    .sort((left, right) => compare(left.subject, right.subject) || compare(left.target, right.target) || compare(left.track, right.track))
    .map((row) => ({ subject: row.subject, target: row.target, track: row.track, value: row.value }));
}

export function relationshipsData(state: Relationships): JsonObject {
  return { tracks: state.tracks.map((row) => ({ subject: row.subject, target: row.target, track: row.track, value: row.value })) };
}

export function validateRelationships(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (key !== "tracks") violations.push({ code: "unknown_field", path: key });
  const rows = data.tracks;
  if (!Array.isArray(rows)) {
    violations.push({ code: "bad_field", path: "tracks" });
    return violations;
  }
  if (rows.length > MAX_RELATIONSHIP_ROWS) violations.push({ code: "too_many", path: "tracks" });
  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    const at = `tracks.${index}`;
    if (!isRecord(raw)) {
      violations.push({ code: "bad_field", path: at });
      return;
    }
    for (const key of Object.keys(raw)) if (!["subject", "target", "track", "value"].includes(key)) violations.push({ code: "unknown_field", path: `${at}.${key}` });
    for (const field of ["subject", "target"] as const) {
      const name = raw[field];
      if (typeof name !== "string" || name === "" || name !== name.trim()) violations.push({ code: "bad_field", path: `${at}.${field}` });
      else if (codePoints(name) > MAX_RELATIONSHIP_NAME_CHARS) violations.push({ code: "too_long", path: `${at}.${field}` });
    }
    const track = typeof raw.track === "string" ? RELATIONSHIP_TRACKS.get(raw.track) : undefined;
    if (track === undefined) violations.push({ code: "unknown_track", path: `${at}.track` });
    else if (typeof raw.value !== "number" || !Number.isSafeInteger(raw.value) || raw.value < track.min || raw.value > track.max) {
      violations.push({ code: "bad_field", path: `${at}.value` });
    }
    // JSON keeps the three strings apart unambiguously, so no separator can collide.
    const key = JSON.stringify([raw.subject, raw.target, raw.track]);
    if (seen.has(key)) violations.push({ code: "duplicate", path: at });
    seen.add(key);
  });
  return violations;
}

/** A stored state read back; an invalid one reads as no relationships. */
export function readRelationships(data: JsonObject): Relationships {
  if (validateRelationships(data).length > 0) return NO_RELATIONSHIPS;
  return {
    tracks: (data.tracks as readonly JsonObject[]).map((raw) => ({
      subject: raw.subject as string,
      target: raw.target as string,
      track: raw.track as string,
      value: raw.value as number,
    })),
  };
}

function projectRelationships(document: Document, viewer: Viewer): Relationships | null {
  const state = readRelationships(document.data);
  if (viewer.grade === "keeper") return state;
  if (viewer.actorId === undefined) return null;
  const actor = viewer.actorId;
  return { tracks: state.tracks.filter((row) => row.subject === actor) };
}

export const relationshipsDocumentType: DocumentType<Relationships> = {
  name: RELATIONSHIPS_TYPE,
  lifecycle: { reset: "story" },
  version: 1,
  project: projectRelationships,
  validate: validateRelationships,
};
