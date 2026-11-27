// A module's characters, as the engine sees them: an OVERLAY, never documents. A module keeps
// its own characters; the room keeps the list the module's `characters()` gave at the last
// render (beside the module views and the module clock), and the seating records only who
// sits on which one. The engine never writes a sheet for such a character.
//
// Outside its module a module's character is named `<module>:<id>` — the module id, a colon,
// the module's own id for it — so a module can never name an engine character (those are
// `ch-<id>`, and a module id has no `-`) and two modules never collide. Inside the module's
// own handlers it is the module's bare id (the SDK runner strips the prefix).
//
// What such a character shows is the module's own offer to the table — name, blurb,
// resources — and is table-grade by definition: no Keeper-only part exists.

/** A module id: the SDK's name pattern (`[a-z][a-z0-9_]*`, at most 64 characters). */
const MODULE_PREFIX = /^([a-z][a-z0-9_]{0,63}):/u;
/** The longest module id. */
export const MAX_MODULE_ID_CHARS = 64;
/** The longest id a module gives one of its characters, in code points (the module caps' `characterTextChars`). */
export const MAX_MODULE_CHARACTER_ID_CHARS = 200;
/** The longest character id a seat holds: an engine character's, or a module's namespaced one. */
export const MAX_SEAT_CHARACTER_CHARS = MAX_MODULE_ID_CHARS + 1 + MAX_MODULE_CHARACTER_ID_CHARS;

export interface ModuleResource {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly max: number | null;
}

/** One character a module offers, as validated from its `characters()`. `id` is the module's own. */
export interface ModuleCharacter {
  readonly module: string;
  readonly id: string;
  readonly name: string;
  readonly blurb: string | null;
  readonly resources: readonly ModuleResource[];
}

/** The id the engine knows a module's character by. */
export function moduleCharacterId(module: string, id: string): string {
  return `${module}:${id}`;
}

/** The module and the module's own id a namespaced id names; null for any other id (an engine character's). */
export function splitModuleCharacterId(id: string): { readonly module: string; readonly id: string } | null {
  const match = MODULE_PREFIX.exec(id);
  if (match === null) return null;
  const module = match[1] as string;
  const own = id.slice(module.length + 1);
  return own === "" ? null : { module, id: own };
}

/** Whether a character id names a module's character. */
export function isModuleCharacterId(id: string): boolean {
  return splitModuleCharacterId(id) !== null;
}

/** The character a namespaced id names in the room's last list, or null when the module does not offer it now. */
export function findModuleCharacter(characters: readonly ModuleCharacter[], id: string): ModuleCharacter | null {
  const split = splitModuleCharacterId(id);
  if (split === null) return null;
  return characters.find((character) => character.module === split.module && character.id === split.id) ?? null;
}

/**
 * How a seated module character reads: its name from the last list, or its id until the module
 * offers it (again) — the engine does not write during a render, so a seat whose character the
 * module dropped stays, shown by id, until the module unseats it.
 */
export function moduleCharacterName(characters: readonly ModuleCharacter[], id: string): string {
  return findModuleCharacter(characters, id)?.name ?? id;
}
