// The turn's own text, in both locales: the end-of-turn re-asks and the finalizer's
// instruction are written FOR THE MODEL in the room's language, and the max-rounds
// fallback and the provider diagnoses are read by the table. Carried over unchanged from
// the 2.6 `locales/*/loop.json` under the same key names.
import en from "../../../locales/en/turn.json" with { type: "json" };
import zh from "../../../locales/zh/turn.json" with { type: "json" };
import { type Catalog, translate } from "../../infra/i18n.ts";

export const TURN_CATALOG: Catalog = { en: { ...en }, zh: { ...zh } };

/** A turn text in `locale`. */
export function turnText(locale: string, key: string, params: Readonly<Record<string, string | number>> = {}): string {
  return translate(TURN_CATALOG, locale, key, params);
}
