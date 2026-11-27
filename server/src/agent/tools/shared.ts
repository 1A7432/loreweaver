// What several tools share: reading and writing room documents through the context, the
// acting character, refusals, and the small renderings of findings the model reads.
// Everything here is text for the MODEL; nothing in it reaches the table.
import { type Character, characterData, CHARACTER_TYPE, findModuleCharacter, readCharacter, type SheetWrite, splitModuleCharacterId, updateSheet } from "../../core/characters/index.ts";
import { GAME_CLOCK_ID, GAME_CLOCK_TYPE, readGameClock } from "../../core/clock/index.ts";
import type { Document, JsonObject } from "../../core/documents/model.ts";
import type { RulePack } from "../../core/rulepacks/index.ts";
import type { Sheet, SheetViolation } from "../../core/sheets/index.ts";
import type { RoomContext } from "../context.ts";
import type { ToolResult } from "./types.ts";

/** A refusal: nothing was written. */
export function refuse(code: string, text: string): ToolResult {
  return { status: "refused", code, text };
}

export function getDocument(context: RoomContext, type: string, id: string): Document | null {
  return context.services.documents.get(context.room, type, id);
}

export function listDocuments(context: RoomContext, type: string): Document[] {
  return context.services.documents.list(context.room, type);
}

/** Write a document, keeping the provenance (`meta`) the previous version carried. */
export function putDocument(context: RoomContext, type: string, id: string, data: JsonObject, previous: Document | null): void {
  context.services.documents.put(context.writer, type, id, data, previous?.meta ?? {});
}

/** The game clock's text now, for stamping notes; null when the clock is unset. */
export function clockText(context: RoomContext): string | null {
  const document = getDocument(context, GAME_CLOCK_TYPE, GAME_CLOCK_ID);
  if (document === null || document.corrupt) return null;
  const clock = readGameClock(document.data);
  return clock === null || clock.now === "" ? null : clock.now;
}

/** Code points, for the caps the model is told about. */
export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export interface LoadedCharacter {
  readonly id: string;
  readonly document: Document;
  readonly pack: RulePack;
  readonly character: Character;
}

export type CharacterLoad = { readonly ok: true; readonly loaded: LoadedCharacter } | { readonly ok: false; readonly result: ToolResult };

export const NO_CHARACTER = refuse(
  "no_character",
  "The acting member plays no character in this room, so there is no sheet to use. A player takes a character with the room's character commands; for a non-player actor, use the actor arguments where a tool has them.",
);

/** A character document read against its own rule pack. */
export function loadCharacter(context: RoomContext, id: string): CharacterLoad {
  const document = getDocument(context, CHARACTER_TYPE, id);
  if (document === null) return { ok: false, result: refuse("no_character", `No character "${id}" exists in this room.`) };
  const packId = document.data.pack;
  const pack = typeof packId === "string" ? context.services.packs.get(packId) : null;
  const character = document.corrupt || pack === null ? null : readCharacter(pack.sheet, document.data);
  if (character === null || pack === null) {
    return {
      ok: false,
      result: refuse(
        "character_unreadable",
        "This character's stored data is unreadable (corrupt, or its rule pack is not installed), so the sheet cannot be used safely. No changes were made.",
      ),
    };
  }
  return { ok: true, loaded: { id, document, pack, character } };
}

/**
 * A seat on a module's character as the model reads it: its name and resources as the module
 * last gave them, and that the module keeps it; null for any other character. The engine has
 * no sheet for such a character.
 */
export function moduleCharacterLines(context: RoomContext, id: string): string[] | null {
  const split = splitModuleCharacterId(id);
  if (split === null) return null;
  const kept = findModuleCharacter(context.moduleCharacters ?? [], id);
  const lines = [`Character: ${kept?.name ?? id} — kept by module ${split.module}; the engine holds no sheet for it.`];
  const resources = (kept?.resources ?? []).map((resource) => `  ${resource.label}: ${resource.value}${resource.max === null ? "" : `/${resource.max}`}`);
  if (resources.length > 0) lines.push("Resources:", ...resources);
  if (kept === null) lines.push("(The module does not list this character now.)");
  return lines;
}

/** The character the acting member plays. A module's character has no sheet: the answer names it, its resources and its module. */
export function activeCharacter(context: RoomContext): CharacterLoad {
  const seat = context.who.character;
  if (seat === null) return { ok: false, result: NO_CHARACTER };
  const kept = moduleCharacterLines(context, seat.id);
  if (kept !== null) {
    return { ok: false, result: refuse("module_character", [...kept, "There is no sheet to read or change: use that module's own commands (run_command)."].join("\n")) };
  }
  return loadCharacter(context, seat.id);
}

export type SheetSave =
  | { readonly ok: true; readonly character: Character; readonly violations: readonly SheetViolation[] }
  | { readonly ok: false; readonly result: ToolResult };

/** Replace a character's sheet (validated as an edit by its pack) and store it. */
export function saveSheet(context: RoomContext, loaded: LoadedCharacter, sheet: Sheet): SheetSave {
  const write: SheetWrite = updateSheet(loaded.pack.sheet, loaded.character, sheet);
  if (!write.ok) return { ok: false, result: refuse(`sheet_${write.code}`, `The rule pack refused the sheet (${write.code}); nothing was changed.`) };
  putDocument(context, CHARACTER_TYPE, loaded.id, characterData(write.data), loaded.document);
  return { ok: true, character: write.data, violations: write.violations };
}

/** Store a character whose non-sheet parts changed (status effects). */
export function saveCharacter(context: RoomContext, loaded: LoadedCharacter, character: Character): void {
  putDocument(context, CHARACTER_TYPE, loaded.id, characterData(character), loaded.document);
}

/** The rule findings of a sheet write, one line each, for the model. Empty when there were none. */
export function violationNotice(violations: readonly SheetViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map((violation) => {
    const where = violation.key === null ? violation.section : `${violation.section}.${violation.key}`;
    const corrected = violation.corrected === null ? "" : ` → ${violation.corrected}`;
    const limit = violation.limit === null ? "" : Array.isArray(violation.limit) ? ` (allowed ${violation.limit[0]}..${violation.limit[1]})` : ` (budget ${violation.limit})`;
    return `- ${where}: ${violation.code}${corrected}${limit}`;
  });
  return ["The rule pack corrected the sheet:", ...lines].join("\n");
}

/** A value as the model reads it. */
export function shown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "(none)";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
