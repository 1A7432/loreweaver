// The Keeper's prompt text, in both locales: the Keeper narrates in the room's language.
// Carried over from the 2.6 catalogs under the same key names (see the module docstring
// of `assemble.ts` for what was left behind and what was edited).
import en from "../../../locales/en/prompt.json" with { type: "json" };
import zh from "../../../locales/zh/prompt.json" with { type: "json" };
import { type Catalog, translate } from "../../infra/i18n.ts";

export const PROMPT_CATALOG: Catalog = { en: { ...en }, zh: { ...zh } };

/** A prompt text in `locale`. */
export function promptText(locale: string, key: string, params: Readonly<Record<string, string | number>> = {}): string {
  return translate(PROMPT_CATALOG, locale, key, params);
}
