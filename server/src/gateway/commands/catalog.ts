// The command layer's messages: titles, descriptions, usage lines, results and refusals.
import en from "../../../locales/en/commands.json" with { type: "json" };
import zh from "../../../locales/zh/commands.json" with { type: "json" };

import type { Catalog } from "../../infra/i18n.ts";

export const COMMANDS_CATALOG: Catalog = { en, zh };
