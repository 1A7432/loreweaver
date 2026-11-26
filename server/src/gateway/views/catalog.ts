// The views' labels: role names and language names, in the viewer's language.
import en from "../../../locales/en/views.json" with { type: "json" };
import zh from "../../../locales/zh/views.json" with { type: "json" };

import type { Catalog } from "../../infra/i18n.ts";

export const VIEWS_CATALOG: Catalog = { en, zh };
