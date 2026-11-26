// What an imported world card leaves with the Keeper: one `world_card` document per card
// a room imported as its world (the admin's world import, `agent/card_import.ts`).
//
// Payload `{ name, description, personality, scenario, examples, creatorNotes, head,
// postHistory, opening, alternates, provenance: { hash, importedAt, importedBy, format } }`:
//   - `name`: the card's name, as written; the document id is `card:<name>`, the same
//     string the card's lore entries carry as their source, so a re-import of the same
//     card replaces both together.
//   - the card's prose (description, personality, scenario, example messages, creator
//     notes), kept verbatim: the module's pitch and setup, for the Keeper to read.
//   - `head`, `postHistory`: the card's standing directives (V2 `system_prompt`,
//     `post_history_instructions`), prepared at import by `prepareDirective` — template
//     code removed, `{{original}}` and comment macros dropped, `{{char}}` bound to the
//     card's name. The head text rides the cached head of the Keeper's prompt verbatim; the
//     post-history text gets the per-turn macro pass (`agent/card_import.ts`).
//   - `opening`, `alternates`: the card's first message and alternate greetings, as
//     written (template code included: a greeting is rendered like lore before it is
//     spoken).
//   - `provenance`: a sha-256 of the parsed card, when it was imported (ms), the member
//     who imported it (null when no member did), and which format it came in.
//
// The document's existence is the room's "a world was imported" marker: there is no
// second record to drift from it.
//
// Who sees what (iron rule 3):
//   - keeper: everything.
//   - admin (as themself): the name, the provenance and the SIZES of what the card left
//     (directive lengths, how many openings) — enough to manage the room and to see that
//     the card speaks in the Keeper's prompt; never the text. The admin is also a player:
//     a card's scenario, openings and directives routinely carry setup the table is meant
//     to discover in play.
//   - player, observer, an NPC actor: the name alone. The table knows which world it is
//     playing — the name is the module's title, which the room's own receipt of the import
//     and the pack listing already show. The opening is not a view: once the Keeper or a
//     command speaks it, it is an event in the log like any other narration.
// Views are built by naming fields, so a field added later stays keeper-only until a view
// names it.
import { codePoints } from "../variables/index.ts";
import type { Document, DocumentType, Json, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { stripTemplates } from "./split.ts";

export const WORLD_CARD_TYPE = "world_card";

/** The card's name, in code points (a lore entry title's bound: the name is their source). */
export const MAX_WORLD_NAME_CHARS = 200;
/** One prose field (description, personality, scenario, examples, creator notes). */
export const MAX_WORLD_PROSE_CHARS = 100_000;
/** One standing directive, after preparation. It rides every Keeper prompt. */
export const MAX_DIRECTIVE_CHARS = 50_000;
/** The first message, and each alternate greeting. */
export const MAX_OPENING_CHARS = 50_000;
/** Alternate greetings a card may carry. */
export const MAX_ALTERNATE_GREETINGS = 64;
/** The importing member's id. */
export const MAX_IMPORTER_ID_CHARS = 128;

export type WorldCardFormat = "sillytavern" | "lorecard";

export interface WorldCardProvenance {
  /** sha-256 (lowercase hex) of the parsed card. */
  readonly hash: string;
  /** Milliseconds since the epoch. */
  readonly importedAt: number;
  /** The member who imported it; null when nobody at the table did (a pack install). */
  readonly importedBy: string | null;
  readonly format: WorldCardFormat;
}

export interface WorldCard {
  readonly name: string;
  readonly description: string;
  readonly personality: string;
  readonly scenario: string;
  readonly examples: string;
  readonly creatorNotes: string;
  readonly head: string;
  readonly postHistory: string;
  readonly opening: string;
  readonly alternates: readonly string[];
  readonly provenance: WorldCardProvenance;
}

const PROSE_FIELDS = ["description", "personality", "scenario", "examples", "creatorNotes"] as const;
const PAYLOAD_KEYS: readonly string[] = ["name", ...PROSE_FIELDS, "head", "postHistory", "opening", "alternates", "provenance"];
const PROVENANCE_KEYS: readonly string[] = ["hash", "importedAt", "importedBy", "format"];
const HASH = /^[0-9a-f]{64}$/u;

/** The document id of the world card named `name` (also its lore entries' source). */
export function worldCardId(name: string): string {
  return `card:${name}`;
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

// `{{original}}` is where SillyTavern splices the preset's own prompt into a card's
// override; the engine has no preset prompt to splice, so the macro is dropped rather
// than left as literal noise.
const ORIGINAL_MACRO = /\{\{\s*original\s*\}\}/giu;
const COMMENT_MACRO = /\{\{\s*\/\/[^{}]*\}\}/gu;
const CHAR_MACRO = /\{\{\s*char\s*\}\}/giu;

/**
 * The import-time copy of one directive: template code removed (raw template syntax never
 * reaches the model from this path), `{{original}}` and comment macros dropped, `{{char}}`
 * bound to the card's name, trimmed. Every other macro is left for the per-turn pass on
 * the post-history text; the head text stays byte-stable across turns.
 */
export function prepareDirective(text: string, cardName: string): string {
  let clean = stripTemplates(text).text;
  clean = clean.replace(ORIGINAL_MACRO, "").replace(COMMENT_MACRO, "");
  if (cardName !== "") clean = clean.replace(CHAR_MACRO, () => cardName);
  return clean.trim();
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** The payload to store. */
export function worldCardData(card: WorldCard): JsonObject {
  const data: Record<string, Json> = { name: card.name };
  for (const field of PROSE_FIELDS) data[field] = card[field];
  data.head = card.head;
  data.postHistory = card.postHistory;
  data.opening = card.opening;
  data.alternates = [...card.alternates];
  data.provenance = {
    hash: card.provenance.hash,
    importedAt: card.provenance.importedAt,
    importedBy: card.provenance.importedBy,
    format: card.provenance.format,
  };
  return data;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textWithin(violations: WriteViolation[], value: unknown, path: string, max: number): void {
  if (typeof value !== "string") violations.push({ code: "bad_field", path });
  else if (codePoints(value) > max) violations.push({ code: "too_long", path });
}

/** Problems with a stored payload; empty when it is a valid world card. */
export function validateWorldCard(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (!PAYLOAD_KEYS.includes(key)) violations.push({ code: "unknown_field", path: key });
  textWithin(violations, data.name, "name", MAX_WORLD_NAME_CHARS);
  for (const field of PROSE_FIELDS) textWithin(violations, data[field], field, MAX_WORLD_PROSE_CHARS);
  textWithin(violations, data.head, "head", MAX_DIRECTIVE_CHARS);
  textWithin(violations, data.postHistory, "postHistory", MAX_DIRECTIVE_CHARS);
  textWithin(violations, data.opening, "opening", MAX_OPENING_CHARS);
  const alternates = data.alternates;
  if (!Array.isArray(alternates)) violations.push({ code: "bad_field", path: "alternates" });
  else {
    if (alternates.length > MAX_ALTERNATE_GREETINGS) violations.push({ code: "too_many", path: "alternates" });
    alternates.forEach((item, index) => textWithin(violations, item, `alternates.${index}`, MAX_OPENING_CHARS));
  }
  const provenance = data.provenance;
  if (!isRecord(provenance)) {
    violations.push({ code: "bad_field", path: "provenance" });
    return violations;
  }
  for (const key of Object.keys(provenance)) if (!PROVENANCE_KEYS.includes(key)) violations.push({ code: "unknown_field", path: `provenance.${key}` });
  if (typeof provenance.hash !== "string" || !HASH.test(provenance.hash)) violations.push({ code: "bad_field", path: "provenance.hash" });
  const at = provenance.importedAt;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) violations.push({ code: "bad_field", path: "provenance.importedAt" });
  const by = provenance.importedBy;
  if (by !== null && (typeof by !== "string" || by === "" || codePoints(by) > MAX_IMPORTER_ID_CHARS)) violations.push({ code: "bad_field", path: "provenance.importedBy" });
  if (provenance.format !== "sillytavern" && provenance.format !== "lorecard") violations.push({ code: "bad_field", path: "provenance.format" });
  return violations;
}

/** A stored world card read back; null when the payload is not a valid one. */
export function readWorldCardDocument(document: Document): WorldCard | null {
  if (document.corrupt || validateWorldCard(document.data).length > 0) return null;
  const data = document.data;
  const provenance = data.provenance as JsonObject;
  return {
    name: data.name as string,
    description: data.description as string,
    personality: data.personality as string,
    scenario: data.scenario as string,
    examples: data.examples as string,
    creatorNotes: data.creatorNotes as string,
    head: data.head as string,
    postHistory: data.postHistory as string,
    opening: data.opening as string,
    alternates: [...(data.alternates as readonly string[])],
    provenance: {
      hash: provenance.hash as string,
      importedAt: provenance.importedAt as number,
      importedBy: provenance.importedBy as string | null,
      format: provenance.format as WorldCardFormat,
    },
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface WorldCardKeeperView extends WorldCard {
  readonly view: "keeper";
  readonly id: string;
}

export interface WorldCardAdminView {
  readonly view: "admin";
  readonly id: string;
  readonly name: string;
  readonly provenance: WorldCardProvenance;
  /** Lengths in code points of the directive texts (0 when the card has none). */
  readonly headChars: number;
  readonly postHistoryChars: number;
  /** The first message (when non-blank) plus the alternate greetings. */
  readonly openings: number;
}

export interface WorldCardTableView {
  readonly view: "table";
  readonly id: string;
  readonly name: string;
}

export type WorldCardView = WorldCardKeeperView | WorldCardAdminView | WorldCardTableView;

/** How many openings a card offers: its first message when non-blank, and each alternate. */
export function openingCount(card: WorldCard): number {
  return (card.opening.trim() === "" ? 0 : 1) + card.alternates.length;
}

/** What `viewer` may see of a world card (every viewer sees at least its name). */
export function projectWorldCard(id: string, card: WorldCard, viewer: Viewer): WorldCardView {
  if (viewer.grade === "keeper") {
    return {
      view: "keeper",
      id,
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      examples: card.examples,
      creatorNotes: card.creatorNotes,
      head: card.head,
      postHistory: card.postHistory,
      opening: card.opening,
      alternates: [...card.alternates],
      provenance: { ...card.provenance },
    };
  }
  if (viewer.grade === "admin" && viewer.actorId === undefined) {
    return {
      view: "admin",
      id,
      name: card.name,
      provenance: { ...card.provenance },
      headChars: codePoints(card.head),
      postHistoryChars: codePoints(card.postHistory),
      openings: openingCount(card),
    };
  }
  return { view: "table", id, name: card.name };
}

export const worldCardDocumentType: DocumentType<WorldCardView> = {
  name: WORLD_CARD_TYPE,
  // Part of the imported world, like its lore entries and variable tree: a story or a
  // character reset replays the same world, and only a reset of the whole room removes it.
  lifecycle: { reset: "all" },
  version: 1,
  project(document, viewer) {
    const card = readWorldCardDocument(document);
    return card === null ? null : projectWorldCard(document.id, card, viewer);
  },
  validate: validateWorldCard,
};
