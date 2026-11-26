// The chronicle fold's prompt text, carried over verbatim from the 2.6 server
// (`locales/*/prompt.json`, keys `prompt.chronicle.*`).
import en from "../../../locales/en/fold.json" with { type: "json" };
import zh from "../../../locales/zh/fold.json" with { type: "json" };

import type { Catalog } from "../../infra/i18n.ts";

export const FOLD_CATALOG: Catalog = { en, zh };
