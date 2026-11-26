// The room-state keys the engine commands write. Declared here, by their writer, each with
// what a campaign reset does to it (`infra/lifecycle/declarations.ts`).
import { jsonStateKey, textStateKey } from "../../infra/lifecycle/declarations.ts";

const ROOM_SETTING = "a room setting chosen by the admin, not part of the story: a fresh campaign is still played at the same table, in the same way";

/** The room's language (`en`, `zh`): everything sent to the table is written in it. */
export const ROOM_LOCALE = textStateKey("room.locale", { reset: "never", because: ROOM_SETTING });

/**
 * The room's rule system: a rule-pack id the admin chose. Absent: the server's default
 * system for its rooms (which may be none).
 */
export const ROOM_RULE_PACK = textStateKey("room.rule_pack", { reset: "never", because: ROOM_SETTING });

/** The house-rule ladder the room chose within its rule system; absent for the system's default. */
export const ROOM_RULE_VARIANT = textStateKey("room.rule_variant", { reset: "never", because: ROOM_SETTING });

/** Whether the Keeper is muted: the table plays on, and the AI does not answer. */
export const KEEPER_MUTED = jsonStateKey("room.keeper_muted", { reset: "never", because: ROOM_SETTING }, (value): value is boolean => typeof value === "boolean");

/** The languages a room may be set to: the ones the server has catalogs for. */
export const ROOM_LOCALES: readonly string[] = ["en", "zh"];

/** A room enables at most this many packs at once. */
export const MAX_ENABLED_PACKS = 16;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * The packs enabled in the room, by id, in the order they were enabled (which is the order
 * their modules are called in). A room setting: a campaign reset replays the story at the
 * same table with the same content switched on.
 */
export const ROOM_PACKS = jsonStateKey(
  "room.packs_enabled",
  { reset: "never", because: ROOM_SETTING },
  (value): value is string[] => Array.isArray(value) && value.length <= MAX_ENABLED_PACKS && value.every((item) => typeof item === "string" && PACK_ID.test(item)) && new Set(value).size === value.length,
);

/** At most this many panels switched off in a room: every panel of every enabled pack. */
export const MAX_PANELS_OFF = MAX_ENABLED_PACKS * 16;
const PANEL_WIRE_ID = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * The panels the admin switched off in this room, by `<pack>/<panel>`. A panel of an enabled
 * pack is on unless listed here. A room setting, like the enabled packs it qualifies.
 */
export const ROOM_PANELS_OFF = jsonStateKey(
  "room.panels_off",
  { reset: "never", because: ROOM_SETTING },
  (value): value is string[] => Array.isArray(value) && value.length <= MAX_PANELS_OFF && value.every((item) => typeof item === "string" && PANEL_WIRE_ID.test(item)) && new Set(value).size === value.length,
);
