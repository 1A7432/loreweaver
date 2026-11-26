// Commands: the one kind of operation a person performs (protocol 3.0 §8.3). The engine's
// commands, a rule pack's command words and the module commands share one table; a text
// line and `command.run` reach the same handler.
export { COMMANDS_CATALOG } from "./catalog.ts";
export { parseAssignments, MAX_SHEET_WRITES } from "./engine/sheet.ts";
export { parseCheckText, subsystemCommandId } from "./engine/checks.ts";
export { RESET_CONFIRM_MS, ResetGate } from "./engine/room.ts";
export { argumentTooLong, inlineRolls, MAX_COMMAND_ARG_CHARS, MAX_INLINE_ROLLS, PREFIXES, splitCommand } from "./parse.ts";
export { CommandRegistry, type InputOutcome, type RegistryOptions } from "./registry.ts";
export { MAX_ARG_CHARS, type ObjectSchema, type Schema, validateArgs } from "./schema.ts";
export { KEEPER_MUTED, MAX_ENABLED_PACKS, MAX_PANELS_OFF, ROOM_LOCALE, ROOM_LOCALES, ROOM_PACKS, ROOM_PANELS_OFF, ROOM_RULE_PACK, ROOM_RULE_VARIANT } from "./state.ts";
export { documentCatalogOf, whoIn } from "./support.ts";
export type {
  Args,
  CommandCall,
  CommandEvent,
  CommandOutcome,
  CommandRefusal,
  CommandRole,
  CommandSignal,
  CommandSource,
  CommandSpec,
  CommandsView,
  CommandSuccess,
  CommandViewEntry,
  LifecycleNotice,
  ModuleCommandEntry,
  ModuleCommands,
} from "./types.ts";
