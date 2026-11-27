// What the tools tell the TABLE, in the room's language: the lines a dice event carries for a
// person (`label`, `text`). What a tool tells the model stays in English beside its code.
import en from "../../../locales/en/tools.json" with { type: "json" };
import zh from "../../../locales/zh/tools.json" with { type: "json" };

import { type Catalog, translate } from "../../infra/i18n.ts";
import type { RoomContext } from "../context.ts";

export const TOOLS_CATALOG: Catalog = { en, zh };

/** A line for the table, in the room's language. */
export function tableLine(context: RoomContext, key: string, params: Readonly<Record<string, string | number>> = {}): string {
  return translate(TOOLS_CATALOG, context.locale, key, params);
}
