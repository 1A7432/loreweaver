// The room-state keys the engine commands write. Declared here, by their writer, each with
// what a campaign reset does to it (`infra/lifecycle/declarations.ts`).
import { jsonStateKey, textStateKey } from "../../infra/lifecycle/declarations.ts";

const ROOM_SETTING = "a room setting chosen by the admin, not part of the story: a fresh campaign is still played at the same table, in the same way";

/** The room's language (`en`, `zh`): everything sent to the table is written in it. */
export const ROOM_LOCALE = textStateKey("room.locale", { reset: "never", because: ROOM_SETTING });

/** The house-rule ladder the room chose within its rule system; absent for the system's default. */
export const ROOM_RULE_VARIANT = textStateKey("room.rule_variant", { reset: "never", because: ROOM_SETTING });

/** Whether the Keeper is muted: the table plays on, and the AI does not answer. */
export const KEEPER_MUTED = jsonStateKey("room.keeper_muted", { reset: "never", because: ROOM_SETTING }, (value): value is boolean => typeof value === "boolean");

/** The languages a room may be set to: the ones the server has catalogs for. */
export const ROOM_LOCALES: readonly string[] = ["en", "zh"];
