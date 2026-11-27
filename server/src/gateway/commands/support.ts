// What the engine commands share: who is calling and what they play, reading and writing
// the documents a command rewrites, and turning engine results into table events.
//
// Content shown to a person is read through projections (`services.views`) with the
// caller's viewer. Whole documents (`services.documents`) are read only where a command
// rewrites one, or computes from one without showing it (a check reads the stat it rolls
// against).
import type { Outcome } from "loreweaver-protocol/v3";
import type { Who } from "loreweaver/module";

import { type RoomContext, type Services, viewerOf } from "../../agent/context.ts";
import {
  type Character,
  CHARACTER_TYPE,
  type CharacterView,
  characterData,
  EMPTY_SEATING,
  isModuleCharacterId,
  type ModuleCharacter,
  moduleCharacterName,
  readCharacter,
  splitModuleCharacterId,
  readSeating,
  type Seating,
  seatingData,
  SEATING_ID,
  SEATING_TYPE,
  type SeatingView,
} from "../../core/characters/index.ts";
import type { Document, JsonObject, Viewer } from "../../core/documents/index.ts";
import { keptFaces, primaryDice, type Roll } from "../../core/dice/index.ts";
import type { CheckOutcome } from "../../core/resolution/index.ts";
import { rankDisplay, type RulePack } from "../../core/rulepacks/index.ts";
import type { DocumentCatalog } from "../../infra/lifecycle/bundle.ts";
import { type CommandCall, isRefused, refuse, type Refused } from "./types.ts";

/** The caller's member id, or null for work nobody at the table started. */
export function memberIdOf(context: RoomContext): string | null {
  return context.who.member?.id ?? null;
}

/** The name the table knows the caller by: their character's, else their own. */
export function actorName(context: RoomContext): string {
  return context.who.character?.name ?? context.who.member?.name ?? "";
}

/** The caller as a viewer, with results labelled in the caller's own language. */
export function callerViewer(call: CommandCall): Viewer {
  return { ...viewerOf(call.context), locale: call.locale };
}

/**
 * The Keeper's grade, for the admin's console onto the Keeper's own records (an NPC's
 * whole record, the chronicle's margins, the table's habits). What a command reads this
 * way is answered to the admin alone, never to the table.
 */
export function keeperViewer(call: CommandCall): Viewer {
  return { grade: "keeper", locale: call.locale };
}

export function isAdmin(context: RoomContext): boolean {
  return context.who.member?.role === "admin";
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** A whole stored document, or a refusal when it exists but cannot be read (never overwrite damage). */
export function readDocument(call: CommandCall, type: string, id: string): Document | null | Refused {
  const document = call.context.services.documents.get(call.context.room, type, id);
  if (document !== null && document.corrupt) return refuse("document_unreadable");
  return document;
}

export function putDocument(call: CommandCall, type: string, id: string, data: JsonObject, meta?: JsonObject): void {
  call.context.services.documents.put(call.context.writer, type, id, data, meta);
}

export function seating(call: CommandCall): Seating | Refused {
  const document = readDocument(call, SEATING_TYPE, SEATING_ID);
  if (document === null) return EMPTY_SEATING;
  if ("refused" in document) return document;
  return readSeating(document.data) ?? refuse("document_unreadable");
}

export function saveSeating(call: CommandCall, value: Seating): void {
  putDocument(call, SEATING_TYPE, SEATING_ID, seatingData(value));
}

/**
 * Free every seat on a character of one of `modules` (the pack that carried them is being
 * disabled), in the caller's write. Unreadable seating is left as it is. The number freed.
 */
export function releaseModuleSeats(call: CommandCall, modules: ReadonlySet<string>): number {
  const seats = seating(call);
  if (isRefused(seats)) return 0;
  const kept = seats.seats.filter((seat) => {
    const split = splitModuleCharacterId(seat.character);
    return split === null || !modules.has(split.module);
  });
  if (kept.length === seats.seats.length) return 0;
  saveSeating(call, { seats: kept });
  return seats.seats.length - kept.length;
}

/** A stored character with the pack it belongs to. */
export interface StoredCharacter {
  readonly id: string;
  readonly character: Character;
  readonly pack: RulePack;
}

/** The character document `id`, read against its own pack. */
export function storedCharacter(call: CommandCall, id: string): StoredCharacter | null | Refused {
  const document = readDocument(call, CHARACTER_TYPE, id);
  if (document === null || "refused" in document) return document;
  const packId = document.data.pack;
  const pack = typeof packId === "string" ? call.context.services.packs.get(packId) : null;
  if (pack === null) return refuse("pack_missing");
  const character = readCharacter(pack.sheet, document.data);
  return character === null ? refuse("document_unreadable") : { id, character, pack };
}

/**
 * `no_sheet` when the caller sits on a module's character, which a module keeps and the
 * engine has no sheet for; null otherwise. Every command that needs the caller's sheet
 * answers it for such a member.
 */
export function moduleSeatRefusal(call: CommandCall): Refused | null {
  const seat = call.context.who.character;
  const split = seat === null ? null : splitModuleCharacterId(seat.id);
  return seat === null || split === null ? null : refuse("no_sheet", { name: seat.name, module: split.module });
}

/** The character the caller plays, or a refusal (`no_character` for a spectator, `no_sheet` on a module's character). */
export function callerCharacter(call: CommandCall): StoredCharacter | Refused {
  const seat = call.context.who.character;
  if (seat === null) return refuse("no_character");
  const kept = moduleSeatRefusal(call);
  if (kept !== null) return kept;
  const found = storedCharacter(call, seat.id);
  return found === null ? refuse("no_character") : found;
}

export function saveCharacter(call: CommandCall, id: string, character: Character): void {
  putDocument(call, CHARACTER_TYPE, id, characterData(character));
}

/** Every character name the table can see, case-folded, except the document `except`. */
export function tableCharacterNames(call: CommandCall, except: string | null): Set<string> {
  const names = new Set<string>();
  const viewer = callerViewer(call);
  for (const entry of call.context.services.views.views(call.context.room, CHARACTER_TYPE, viewer)) {
    if (entry.id === except) continue;
    const name = (entry.view as CharacterView).name;
    names.add(name.trim().toLowerCase());
  }
  return names;
}

/**
 * Who a member is in a room: the member and the character the seating gives them. The
 * gateway builds a command's `Who` this way; it reads the seating and the character's
 * table view, both of which every member may see. A seat on a module's character carries
 * the namespaced id and the name from the modules' last render (`moduleCharacters`), or the
 * id itself until one has run.
 */
export function whoIn(
  services: Services,
  room: string,
  member: { readonly id: string; readonly name: string; readonly role: "player" | "admin" | "observer" },
  locale: string,
  moduleCharacters: readonly ModuleCharacter[] = [],
): Who {
  const viewer: Viewer = { grade: "observer", locale };
  const seats = services.views.view(room, SEATING_TYPE, SEATING_ID, viewer) as SeatingView | null;
  const seat = seats?.seats.find((item) => item.member === member.id);
  if (seat === undefined) return { member, character: null };
  if (isModuleCharacterId(seat.character)) return { member, character: { id: seat.character, name: moduleCharacterName(moduleCharacters, seat.character) } };
  const view = services.views.view(room, CHARACTER_TYPE, seat.character, viewer) as CharacterView | null;
  return { member, character: view === null ? null : { id: seat.character, name: view.name } };
}

// ---------------------------------------------------------------------------
// Dice and outcomes, as the table sees them
// ---------------------------------------------------------------------------

/** The kept faces of a roll's main dice group; the total when it has none. */
export function facesOf(roll: Roll): number[] {
  const group = primaryDice(roll);
  return group === null ? [roll.total] : keptFaces(group);
}

/** A graded outcome as the wire carries it, its label in the room's language. */
export function wireOutcome(pack: RulePack, outcome: CheckOutcome, locale: string): Outcome {
  const wire: { -readonly [K in keyof Outcome]: Outcome[K] } = {
    id: outcome.rank.id,
    label: rankDisplay(pack, outcome.rank.id, locale),
    success: outcome.rank.success,
    critical: outcome.rank.critical,
    fumble: outcome.rank.fumble,
    tier: outcome.rank.tier,
  };
  if (outcome.margin !== null) wire.margin = outcome.margin;
  return wire;
}

// ---------------------------------------------------------------------------
// The store's lifecycle needs to know the document types
// ---------------------------------------------------------------------------

function parseObject(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
  } catch {
    return null;
  }
}

/**
 * What reset and import ask of the document types: each type's lifecycle, and on import a
 * payload's own check. The same rules as the document layer's catalog — a payload that
 * cannot be read is carried as it is (the room held it that way), a readable one the type
 * rejects, or one written by a newer version of the type, is refused.
 */
export function documentCatalogOf(services: Services): DocumentCatalog {
  const known = (type: string): boolean => services.types.names().includes(type);
  return {
    lifecycleOf: (type) => (known(type) ? services.types.get(type).lifecycle : undefined),
    check: (type, version, data) => {
      const definition = services.types.get(type);
      if (version > definition.version) return "version_ahead";
      const payload = parseObject(data);
      if (payload === null) return null;
      const current = version < definition.version && definition.migrate ? definition.migrate(payload, version) : payload;
      const violations = definition.validate?.(current) ?? [];
      return violations[0]?.code ?? null;
    },
  };
}
