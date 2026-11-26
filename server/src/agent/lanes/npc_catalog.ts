// The NPC actor's prompt text, carried over verbatim from the 2.6 server
// (`locales/*/npc.json`, keys `npc.actor_system*` and `npc.actor_user.*`).
import en from "../../../locales/en/npc.json" with { type: "json" };
import zh from "../../../locales/zh/npc.json" with { type: "json" };

import type { Catalog } from "../../infra/i18n.ts";

export const NPC_CATALOG: Catalog = { en, zh };
