// A player character as stored: the rule-pack sheet plus what the sheet layer does not
// keep — which pack it belongs to, the member whose sheet it is, an avatar (a media hash)
// and status effects — and who sees what of it (iron rule 3).
//
// Payload `{ pack, owner, avatar, status, sheet }`:
//   - `pack`: the rule pack's id. The sheet's own `system` is set to it, so the two never
//     disagree.
//   - `owner`: the member whose sheet this is, or null (a pregen nobody has taken, a
//     companion's sheet). Ownership decides privacy; who currently PLAYS the character is
//     the room's seating (`seating.ts`). They are kept apart because a projection sees one
//     document only — and because a released character's notes stay its owner's, not the
//     table's, until someone else takes it over (`setOwner`).
//   - `avatar`: a media hash (sha-256 hex), or null. This is the one avatar a character
//     has: the sheet's own `avatar` slot is always null in a stored character.
//   - `status`: short status effects ("poisoned"), as written, in order.
//
// Views — built by naming fields, so a field added later stays private until a view names it:
//   - keeper: the whole character, its sheet as settled by the pack, the derived values;
//   - the owner (a player or admin viewer whose `memberId` is `owner`): the same;
//   - everyone else — admin, player, observer, any NPC actor: name, pack, avatar, status
//     and the pack's resource meters (HP, sanity…). An admin manages seating and the room,
//     neither of which needs another member's stats, background or notes; an admin who
//     plays a character sees their own whole like any owner.
//
// Projecting needs the pack's sheet spec (resources are pack data). The type is therefore
// made by `characterDocumentType(specFor)` from a lookup the caller builds over the packs
// it loaded — no registry is global. A pack that is no longer installed leaves the table
// view without meters and the whole view with the stored sheet as written.
import { HASH_RE } from "../../infra/media/policy.ts";
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import {
  evaluateSheet,
  type FormulaIssue,
  parseSheet,
  type Sheet,
  type SheetSpec,
  type SheetViolation,
  validateSheet,
  type WireResource,
  wireResources,
} from "../sheets/index.ts";
import { cleanText, isRecord, onlyKeys } from "./text.ts";

export const CHARACTER_TYPE = "character";

/** A character's name (the sheet's `name`), in code points. */
export const MAX_CHARACTER_NAME_CHARS = 64;
/** A rule pack id. */
export const MAX_PACK_ID_CHARS = 64;
/** A member id (owner, seat). */
export const MAX_MEMBER_ID_CHARS = 128;
/** Status effects on one character: they share a line on the party panel. */
export const MAX_STATUS_EFFECTS = 12;
/** One status effect, in code points. */
export const MAX_STATUS_CHARS = 80;

export interface Character {
  readonly pack: string;
  readonly owner: string | null;
  readonly avatar: string | null;
  readonly status: readonly string[];
  readonly sheet: Sheet;
}

export type CharacterRefusal =
  /** The sheet has no name, or one longer than `MAX_CHARACTER_NAME_CHARS`. */
  | "bad_name"
  /** The spec handed in is not the character's pack. */
  | "wrong_pack"
  | "bad_owner"
  /** Not a media hash. */
  | "bad_avatar"
  /** Empty, or longer than `MAX_STATUS_CHARS`. */
  | "bad_status"
  | "too_many_status"
  | "status_absent";

export type CharacterChange = { readonly ok: true; readonly data: Character } | { readonly ok: false; readonly code: CharacterRefusal };

/**
 * A sheet write: the character, plus what the sheet layer corrected or reported on the
 * way (a value clamped into its range, a skill budget overspent, a formula that failed).
 * Those are findings, not refusals: the write happened, and the caller decides what to
 * tell the table.
 */
export type SheetWrite =
  | {
      readonly ok: true;
      readonly data: Character;
      readonly violations: readonly SheetViolation[];
      readonly issues: readonly FormulaIssue[];
    }
  | { readonly ok: false; readonly code: CharacterRefusal };

export interface CreateOptions {
  readonly owner?: string | null;
  readonly avatar?: string | null;
  /** How the sheet was made (`point_buy` adds the point-buy check; see `validateSheet`). */
  readonly creationMethod?: string | null;
}

function validOwner(owner: string | null): boolean {
  return owner === null || cleanText(owner, MAX_MEMBER_ID_CHARS) === owner;
}

function validAvatar(avatar: string | null): boolean {
  return avatar === null || HASH_RE.test(avatar);
}

/** The settled sheet with this layer's invariants: system = pack, no sheet-level avatar. */
function finishSheet(spec: SheetSpec, sheet: Sheet): Sheet | null {
  const name = cleanText(sheet.name, MAX_CHARACTER_NAME_CHARS);
  if (name === null) return null;
  return Object.freeze({ ...sheet, name, system: spec.packId, avatar: null });
}

/**
 * A new character from loose sheet input, validated against the pack as a creation
 * (vitals start full, ranges clamped, budgets checked).
 */
export function createCharacter(spec: SheetSpec, input: unknown, options: CreateOptions = {}): SheetWrite {
  const owner = options.owner ?? null;
  const avatar = options.avatar ?? null;
  if (!validOwner(owner)) return { ok: false, code: "bad_owner" };
  if (!validAvatar(avatar)) return { ok: false, code: "bad_avatar" };
  const validated = validateSheet(spec, input, { initializeVitals: true, creationMethod: options.creationMethod ?? null });
  const sheet = finishSheet(spec, validated.sheet);
  if (sheet === null) return { ok: false, code: "bad_name" };
  const data: Character = Object.freeze({ pack: spec.packId, owner, avatar, status: Object.freeze([]), sheet });
  return { ok: true, data, violations: validated.violations, issues: validated.issues };
}

/**
 * The character with its sheet replaced by `input`, validated as an edit (current pools
 * kept and clamped to their maxima). Owner, avatar and status are untouched.
 */
export function updateSheet(spec: SheetSpec, character: Character, input: unknown): SheetWrite {
  if (spec.packId !== character.pack) return { ok: false, code: "wrong_pack" };
  const validated = validateSheet(spec, input);
  const sheet = finishSheet(spec, validated.sheet);
  if (sheet === null) return { ok: false, code: "bad_name" };
  return { ok: true, data: Object.freeze({ ...character, sheet }), violations: validated.violations, issues: validated.issues };
}

export function setOwner(character: Character, owner: string | null): CharacterChange {
  if (!validOwner(owner)) return { ok: false, code: "bad_owner" };
  return { ok: true, data: Object.freeze({ ...character, owner }) };
}

export function setAvatar(character: Character, avatar: string | null): CharacterChange {
  if (!validAvatar(avatar)) return { ok: false, code: "bad_avatar" };
  return { ok: true, data: Object.freeze({ ...character, avatar }) };
}

/** Replace every status effect. Each is trimmed; repeats collapse to one. */
export function setStatus(character: Character, effects: readonly string[]): CharacterChange {
  const status: string[] = [];
  for (const effect of effects) {
    const text = cleanText(effect, MAX_STATUS_CHARS);
    if (text === null) return { ok: false, code: "bad_status" };
    if (!status.includes(text)) status.push(text);
  }
  if (status.length > MAX_STATUS_EFFECTS) return { ok: false, code: "too_many_status" };
  return { ok: true, data: Object.freeze({ ...character, status: Object.freeze(status) }) };
}

/** Add one status effect; one already present leaves the character as it was. */
export function addStatus(character: Character, effect: string): CharacterChange {
  const text = cleanText(effect, MAX_STATUS_CHARS);
  if (text === null) return { ok: false, code: "bad_status" };
  if (character.status.includes(text)) return { ok: true, data: character };
  if (character.status.length >= MAX_STATUS_EFFECTS) return { ok: false, code: "too_many_status" };
  return { ok: true, data: Object.freeze({ ...character, status: Object.freeze([...character.status, text]) }) };
}

export function removeStatus(character: Character, effect: string): CharacterChange {
  const text = effect.trim();
  if (!character.status.includes(text)) return { ok: false, code: "status_absent" };
  return { ok: true, data: Object.freeze({ ...character, status: Object.freeze(character.status.filter((item) => item !== text)) }) };
}

/** The payload to store. */
export function characterData(character: Character): JsonObject {
  return {
    pack: character.pack,
    owner: character.owner,
    avatar: character.avatar,
    status: [...character.status],
    // A `Sheet` is plain JSON by the sheet layer's contract.
    sheet: character.sheet as unknown as JsonObject,
  };
}

const PAYLOAD_KEYS = ["pack", "owner", "avatar", "status", "sheet"] as const;

/** The parts of a stored payload that do not need the pack; null when it is malformed. */
interface StoredCharacter {
  readonly pack: string;
  readonly owner: string | null;
  readonly avatar: string | null;
  readonly status: readonly string[];
  readonly sheet: Readonly<Record<string, unknown>>;
  readonly name: string;
}

function readStored(data: JsonObject): StoredCharacter | null {
  const { pack, owner, avatar, status, sheet } = data;
  if (typeof pack !== "string" || !isRecord(sheet) || typeof sheet.name !== "string") return null;
  if (owner !== null && typeof owner !== "string") return null;
  if (avatar !== null && typeof avatar !== "string") return null;
  if (!Array.isArray(status) || !status.every((item) => typeof item === "string")) return null;
  return { pack, owner, avatar, status: status as readonly string[], sheet, name: sheet.name };
}

/** A stored character read back against its pack's spec; null when the payload is malformed. */
export function readCharacter(spec: SheetSpec, data: JsonObject): Character | null {
  const stored = readStored(data);
  if (stored === null || stored.pack !== spec.packId) return null;
  return Object.freeze({
    pack: stored.pack,
    owner: stored.owner,
    avatar: stored.avatar,
    status: Object.freeze([...stored.status]),
    sheet: parseSheet(spec, stored.sheet).sheet,
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface CharacterTableView {
  readonly name: string;
  readonly pack: string;
  readonly avatar: string | null;
  readonly status: readonly string[];
  /** The pack's meters, labelled in the viewer's locale; empty when the pack is gone. */
  readonly resources: readonly WireResource[];
}

export interface CharacterFullView extends CharacterTableView {
  readonly owner: string | null;
  /** The sheet as the pack settles it (or as stored, when the pack is gone). */
  readonly sheet: JsonObject;
  /** Every derived value that evaluated, in pack order, as `[name, value]` pairs. */
  readonly derived: readonly (readonly [string, number | string])[];
}

export type CharacterView = CharacterTableView | CharacterFullView;

/** Looks up a pack's sheet spec by pack id; null when that pack is not loaded. */
export type SheetSpecLookup = (packId: string) => SheetSpec | null;

function seesWhole(stored: StoredCharacter, viewer: Viewer): boolean {
  if (viewer.grade === "keeper") return true;
  // An NPC actor is never a sheet's owner, whatever member id it might carry.
  if (viewer.actorId !== undefined) return false;
  if (viewer.grade !== "player" && viewer.grade !== "admin") return false;
  return stored.owner !== null && viewer.memberId === stored.owner;
}

function projectCharacter(specFor: SheetSpecLookup, document: Document, viewer: Viewer): CharacterView | null {
  const stored = readStored(document.data);
  if (stored === null) return null;
  const spec = specFor(stored.pack);
  const sheet = spec === null ? null : parseSheet(spec, stored.sheet).sheet;
  const table: CharacterTableView = {
    name: stored.name,
    pack: stored.pack,
    avatar: stored.avatar,
    status: [...stored.status],
    resources: spec === null || sheet === null ? [] : [...wireResources(spec, sheet, viewer.locale).resources],
  };
  if (!seesWhole(stored, viewer)) return table;
  const derived = spec === null || sheet === null ? [] : [...evaluateSheet(spec, sheet).values].map(([name, value]) => [name, value] as const);
  return {
    ...table,
    owner: stored.owner,
    sheet: (sheet ?? stored.sheet) as unknown as JsonObject,
    derived,
  };
}

function sheetPath(violation: SheetViolation): string {
  if (violation.section === "sheet") return "sheet";
  return violation.key === null ? `sheet.${violation.section}` : `sheet.${violation.section}.${violation.key}`;
}

function validateCharacter(specFor: SheetSpecLookup, data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  const extra = onlyKeys(data, PAYLOAD_KEYS);
  if (extra !== null) violations.push({ code: "unknown_field", path: extra });

  const pack = data.pack;
  let spec: SheetSpec | null = null;
  if (typeof pack !== "string" || cleanText(pack, MAX_PACK_ID_CHARS) !== pack) violations.push({ code: "bad_pack", path: "pack" });
  else {
    spec = specFor(pack);
    if (spec === null) violations.push({ code: "unknown_pack", path: "pack" });
  }

  const owner = data.owner;
  if (owner !== null && (typeof owner !== "string" || !validOwner(owner))) violations.push({ code: "bad_owner", path: "owner" });
  const avatar = data.avatar;
  if (avatar !== null && (typeof avatar !== "string" || !validAvatar(avatar))) violations.push({ code: "bad_avatar", path: "avatar" });

  const status = data.status;
  if (!Array.isArray(status)) violations.push({ code: "bad_status", path: "status" });
  else {
    if (status.length > MAX_STATUS_EFFECTS) violations.push({ code: "too_many_status", path: "status" });
    const seen = new Set<string>();
    status.forEach((item, index) => {
      if (typeof item !== "string" || cleanText(item, MAX_STATUS_CHARS) !== item) violations.push({ code: "bad_status", path: `status.${index}` });
      else if (seen.has(item)) violations.push({ code: "duplicate_status", path: `status.${index}` });
      else seen.add(item);
    });
  }

  const sheet = data.sheet;
  if (!isRecord(sheet)) {
    violations.push({ code: "bad_sheet", path: "sheet" });
    return violations;
  }
  if (typeof sheet.name !== "string" || cleanText(sheet.name, MAX_CHARACTER_NAME_CHARS) !== sheet.name) violations.push({ code: "bad_name", path: "sheet.name" });
  if (sheet.system !== pack) violations.push({ code: "system_mismatch", path: "sheet.system" });
  if (sheet.avatar !== null && sheet.avatar !== undefined) violations.push({ code: "sheet_avatar", path: "sheet.avatar" });
  if (spec !== null) {
    // A stored sheet is a settled one: anything parsing would have to correct is refused.
    for (const violation of parseSheet(spec, sheet).violations) violations.push({ code: `sheet_${violation.code}`, path: sheetPath(violation) });
  }
  return violations;
}

/** The `character` document type, projecting with the specs `specFor` finds. */
export function characterDocumentType(specFor: SheetSpecLookup): DocumentType<CharacterView> {
  return {
    name: CHARACTER_TYPE,
    lifecycle: { reset: "chars" },
    version: 1,
    project: (document, viewer) => projectCharacter(specFor, document, viewer),
    validate: (data) => validateCharacter(specFor, data),
  };
}
