// Who plays whom, and which characters a room offers to be played.
//
// `seating` (one per room, owned by the engine): member id → character id. A member holds
// at most one character at a time; a member with none is a spectator; a character nobody
// holds is unclaimed. Payload `{ seats: [{ member, character, memberName }] }` — an ordered
// list, because member and character ids are content (`__proto__`, `10`) and the table
// wants seats in the order they were taken. `memberName` is the display name the member
// had when they sat down, so the table can say who holds a character while that member is
// offline and no presence list names them.
//   - every viewer: every seat. Who plays what is table talk.
//
// `claimable_characters` (one per room): the characters a room offers — pregenerated ones
// from packs and ones a module registers. Payload `{ characters: [{ id, name, blurb,
// source: { kind, id }, keeperNote }] }`; `id` is the character a claim seats a member on.
//   - keeper: every entry whole, including the author's `keeperNote` about the character
//     ("secretly the cultist's brother");
//   - everyone else (admin, player, observer, NPC actors): id, name, the one-line
//     player-facing blurb, and where it came from. Never the note.
//
// Which of these characters is taken is the seating's answer, not the list's: the list is
// the world's offer, the seating is the table's state, and they reset at different times.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { MAX_CHARACTER_NAME_CHARS, MAX_MEMBER_ID_CHARS } from "./character.ts";
import { cleanOptionalText, cleanText, isRecord, onlyKeys } from "./text.ts";

export const SEATING_TYPE = "seating";
export const SEATING_ID = "seating";
export const CLAIMABLE_TYPE = "claimable_characters";
export const CLAIMABLE_ID = "claimables";

/** A character document id. */
export const MAX_CHARACTER_ID_CHARS = 128;
/** Seats in one room (one per member at most). */
export const MAX_SEATS = 64;
/** A seated member's display name, in code points. */
export const MAX_MEMBER_NAME_CHARS = 64;
/** Characters one room offers. */
export const MAX_CLAIMABLE = 32;
/** The one-line player-facing blurb. */
export const MAX_BLURB_CHARS = 200;
/** An author's keeper-facing note about a pregen. */
export const MAX_KEEPER_NOTE_CHARS = 2000;
/** The id of the pack or module a claimable character came from. */
export const MAX_SOURCE_ID_CHARS = 128;

// ---------------------------------------------------------------------------
// seating
// ---------------------------------------------------------------------------

export type Seat = {
  readonly member: string;
  readonly character: string;
  readonly memberName: string;
};

export type Seating = { readonly seats: readonly Seat[] };

export const EMPTY_SEATING: Seating = Object.freeze({ seats: Object.freeze([]) });

export type SeatingRefusal =
  | "bad_member"
  | "bad_character"
  | "bad_member_name"
  /** The member already plays a character (`switchCharacter` changes it). */
  | "already_seated"
  /** Another member plays that character. */
  | "taken"
  /** The member plays no character. */
  | "not_seated"
  /** Nobody plays that character. */
  | "unclaimed"
  | "full";

export type SeatingChange = { readonly ok: true; readonly data: Seating } | { readonly ok: false; readonly code: SeatingRefusal };

/** The character `member` plays, or null for a spectator. */
export function characterOf(seating: Seating, member: string): string | null {
  return seating.seats.find((seat) => seat.member === member)?.character ?? null;
}

/** The member who plays `character`, or null when it is unclaimed. */
export function memberOf(seating: Seating, character: string): string | null {
  return seating.seats.find((seat) => seat.character === character)?.member ?? null;
}

function newSeat(member: string, character: string, memberName: string): Seat | SeatingRefusal {
  if (cleanText(member, MAX_MEMBER_ID_CHARS) !== member) return "bad_member";
  if (cleanText(character, MAX_CHARACTER_ID_CHARS) !== character) return "bad_character";
  const name = cleanOptionalText(memberName, MAX_MEMBER_NAME_CHARS);
  if (name === null) return "bad_member_name";
  return Object.freeze({ member, character, memberName: name });
}

function withSeats(seats: readonly Seat[]): SeatingChange {
  return { ok: true, data: Object.freeze({ seats: Object.freeze([...seats]) }) };
}

/**
 * Seat `member` on `character`. Claiming the character one already plays refreshes the
 * stored display name; a member who plays another character must switch instead.
 */
export function claim(seating: Seating, member: string, character: string, memberName: string): SeatingChange {
  const seat = newSeat(member, character, memberName);
  if (typeof seat === "string") return { ok: false, code: seat };
  const holder = memberOf(seating, character);
  if (holder !== null && holder !== member) return { ok: false, code: "taken" };
  const current = characterOf(seating, member);
  if (current === character) return withSeats(seating.seats.map((item) => (item.member === member ? seat : item)));
  if (current !== null) return { ok: false, code: "already_seated" };
  if (seating.seats.length >= MAX_SEATS) return { ok: false, code: "full" };
  return withSeats([...seating.seats, seat]);
}

/** `member` stands up; they become a spectator and their character is unclaimed. */
export function release(seating: Seating, member: string): SeatingChange {
  if (characterOf(seating, member) === null) return { ok: false, code: "not_seated" };
  return withSeats(seating.seats.filter((seat) => seat.member !== member));
}

/**
 * Free `character` whoever plays it: the admin's release. Whether the caller may do this
 * is the caller's permission check, not this function's.
 */
export function releaseCharacter(seating: Seating, character: string): SeatingChange {
  if (memberOf(seating, character) === null) return { ok: false, code: "unclaimed" };
  return withSeats(seating.seats.filter((seat) => seat.character !== character));
}

/**
 * Move `member` to `character` in one step, giving up whatever they played (a spectator
 * simply sits down). Refused when someone else plays `character`; the member's seat keeps
 * its place in the order.
 */
export function switchCharacter(seating: Seating, member: string, character: string, memberName: string): SeatingChange {
  const seat = newSeat(member, character, memberName);
  if (typeof seat === "string") return { ok: false, code: seat };
  const holder = memberOf(seating, character);
  if (holder !== null && holder !== member) return { ok: false, code: "taken" };
  if (characterOf(seating, member) === null) return claim(seating, member, character, memberName);
  return withSeats(seating.seats.map((item) => (item.member === member ? seat : item)));
}

export function seatingData(seating: Seating): JsonObject {
  return { seats: seating.seats.map((seat) => ({ member: seat.member, character: seat.character, memberName: seat.memberName })) };
}

/** A stored seating read back; null when malformed. */
export function readSeating(data: JsonObject): Seating | null {
  if (!Array.isArray(data.seats)) return null;
  const seats: Seat[] = [];
  for (const item of data.seats) {
    if (!isRecord(item)) return null;
    const { member, character, memberName } = item;
    if (typeof member !== "string" || typeof character !== "string" || typeof memberName !== "string") return null;
    seats.push(Object.freeze({ member, character, memberName }));
  }
  return Object.freeze({ seats: Object.freeze(seats) });
}

export interface SeatingView {
  readonly seats: readonly Seat[];
}

function projectSeating(document: Document, _viewer: Viewer): SeatingView | null {
  const seating = readSeating(document.data);
  if (seating === null) return null;
  return { seats: seating.seats.map((seat) => ({ member: seat.member, character: seat.character, memberName: seat.memberName })) };
}

function validateSeating(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["seats"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  if (!Array.isArray(data.seats)) return [{ code: "bad_seats", path: "seats" }];
  const violations: WriteViolation[] = [];
  if (data.seats.length > MAX_SEATS) violations.push({ code: "full", path: "seats" });
  const members = new Set<string>();
  const characters = new Set<string>();
  data.seats.forEach((item, index) => {
    const path = `seats.${index}`;
    if (!isRecord(item) || onlyKeys(item, ["member", "character", "memberName"]) !== null) {
      violations.push({ code: "bad_seat", path });
      return;
    }
    const { member, character, memberName } = item;
    if (typeof member !== "string" || typeof character !== "string" || typeof memberName !== "string") {
      violations.push({ code: "bad_seat", path });
      return;
    }
    const seat = newSeat(member, character, memberName);
    if (typeof seat === "string") violations.push({ code: seat, path });
    else if (seat.memberName !== memberName) violations.push({ code: "bad_member_name", path });
    else {
      // One character per member, one member per character: the invariant claims keep.
      if (members.has(seat.member)) violations.push({ code: "already_seated", path });
      if (characters.has(seat.character)) violations.push({ code: "taken", path });
      members.add(seat.member);
      characters.add(seat.character);
    }
  });
  return violations;
}

export const seatingDocument: DocumentType<SeatingView> = {
  name: SEATING_TYPE,
  // Who plays whom goes with the characters themselves.
  lifecycle: { reset: "chars" },
  version: 1,
  project: projectSeating,
  validate: validateSeating,
};

// ---------------------------------------------------------------------------
// claimable_characters
// ---------------------------------------------------------------------------

export type ClaimableSource = { readonly kind: "pack" | "module"; readonly id: string };

export type ClaimableCharacter = {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly source: ClaimableSource;
  /** The author's keeper-facing note; "" when none. Keeper only. */
  readonly keeperNote: string;
};

export type ClaimableList = { readonly characters: readonly ClaimableCharacter[] };

export const EMPTY_CLAIMABLE: ClaimableList = Object.freeze({ characters: Object.freeze([]) });

export type ClaimableRefusal = "bad_id" | "bad_name" | "bad_blurb" | "bad_source" | "bad_keeper_note" | "full" | "unknown";

export type ClaimableChange = { readonly ok: true; readonly data: ClaimableList } | { readonly ok: false; readonly code: ClaimableRefusal };

function cleanEntry(entry: ClaimableCharacter): ClaimableCharacter | ClaimableRefusal {
  if (cleanText(entry.id, MAX_CHARACTER_ID_CHARS) !== entry.id) return "bad_id";
  const name = cleanText(entry.name, MAX_CHARACTER_NAME_CHARS);
  if (name === null) return "bad_name";
  const blurb = cleanOptionalText(entry.blurb, MAX_BLURB_CHARS);
  if (blurb === null) return "bad_blurb";
  const kind = entry.source.kind;
  if ((kind !== "pack" && kind !== "module") || cleanText(entry.source.id, MAX_SOURCE_ID_CHARS) !== entry.source.id) return "bad_source";
  const keeperNote = cleanOptionalText(entry.keeperNote, MAX_KEEPER_NOTE_CHARS);
  if (keeperNote === null) return "bad_keeper_note";
  return Object.freeze({ id: entry.id, name, blurb, source: Object.freeze({ kind, id: entry.source.id }), keeperNote });
}

/**
 * Offer a character. Offering an id already listed replaces that entry in place: a module
 * re-imported refreshes its cast without reordering it.
 */
export function offerCharacter(list: ClaimableList, entry: ClaimableCharacter): ClaimableChange {
  const clean = cleanEntry(entry);
  if (typeof clean === "string") return { ok: false, code: clean };
  const at = list.characters.findIndex((item) => item.id === clean.id);
  if (at >= 0) return { ok: true, data: Object.freeze({ characters: Object.freeze(list.characters.map((item, index) => (index === at ? clean : item))) }) };
  if (list.characters.length >= MAX_CLAIMABLE) return { ok: false, code: "full" };
  return { ok: true, data: Object.freeze({ characters: Object.freeze([...list.characters, clean]) }) };
}

export function withdrawCharacter(list: ClaimableList, id: string): ClaimableChange {
  if (!list.characters.some((item) => item.id === id)) return { ok: false, code: "unknown" };
  return { ok: true, data: Object.freeze({ characters: Object.freeze(list.characters.filter((item) => item.id !== id)) }) };
}

export function claimableData(list: ClaimableList): JsonObject {
  return {
    characters: list.characters.map((entry) => ({
      id: entry.id,
      name: entry.name,
      blurb: entry.blurb,
      source: { kind: entry.source.kind, id: entry.source.id },
      keeperNote: entry.keeperNote,
    })),
  };
}

function readEntry(item: unknown): ClaimableCharacter | null {
  if (!isRecord(item) || !isRecord(item.source)) return null;
  const { id, name, blurb, keeperNote } = item;
  const { kind, id: sourceId } = item.source;
  if (typeof id !== "string" || typeof name !== "string" || typeof blurb !== "string" || typeof keeperNote !== "string") return null;
  if ((kind !== "pack" && kind !== "module") || typeof sourceId !== "string") return null;
  return Object.freeze({ id, name, blurb, source: Object.freeze({ kind, id: sourceId }), keeperNote });
}

/** A stored list read back; null when malformed. */
export function readClaimable(data: JsonObject): ClaimableList | null {
  if (!Array.isArray(data.characters)) return null;
  const characters: ClaimableCharacter[] = [];
  for (const item of data.characters) {
    const entry = readEntry(item);
    if (entry === null) return null;
    characters.push(entry);
  }
  return Object.freeze({ characters: Object.freeze(characters) });
}

export interface ClaimableTableEntry {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly source: ClaimableSource;
}

export interface ClaimableKeeperEntry extends ClaimableTableEntry {
  readonly keeperNote: string;
}

export interface ClaimableView {
  readonly characters: readonly (ClaimableTableEntry | ClaimableKeeperEntry)[];
}

function projectClaimable(document: Document, viewer: Viewer): ClaimableView | null {
  const list = readClaimable(document.data);
  if (list === null) return null;
  const keeper = viewer.grade === "keeper";
  return {
    characters: list.characters.map((entry) => {
      const table: ClaimableTableEntry = { id: entry.id, name: entry.name, blurb: entry.blurb, source: { kind: entry.source.kind, id: entry.source.id } };
      return keeper ? { ...table, keeperNote: entry.keeperNote } : table;
    }),
  };
}

function validateClaimable(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["characters"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  if (!Array.isArray(data.characters)) return [{ code: "bad_characters", path: "characters" }];
  const violations: WriteViolation[] = [];
  if (data.characters.length > MAX_CLAIMABLE) violations.push({ code: "full", path: "characters" });
  const ids = new Set<string>();
  data.characters.forEach((item, index) => {
    const path = `characters.${index}`;
    const entry = readEntry(item);
    if (entry === null || !isRecord(item) || onlyKeys(item, ["id", "name", "blurb", "source", "keeperNote"]) !== null) {
      violations.push({ code: "bad_entry", path });
      return;
    }
    const clean = cleanEntry(entry);
    if (typeof clean === "string") violations.push({ code: clean, path });
    else if (clean.name !== entry.name || clean.blurb !== entry.blurb || clean.keeperNote !== entry.keeperNote) violations.push({ code: "untrimmed", path });
    if (ids.has(entry.id)) violations.push({ code: "duplicate_id", path });
    ids.add(entry.id);
  });
  return violations;
}

export const claimableDocument: DocumentType<ClaimableView> = {
  name: CLAIMABLE_TYPE,
  // A pack's pregens and a module's registered characters belong to the installed world:
  // a story or character reset replays the same module with the same cast on offer, and
  // only removing the world takes them away.
  lifecycle: { reset: "all" },
  version: 1,
  project: projectClaimable,
  validate: validateClaimable,
};
