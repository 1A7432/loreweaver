// The session report's words: headings, labels, the scoreboard. Carried over from the 2.6
// report where 2.6 had the line.
import en from "../../../locales/en/report.json" with { type: "json" };
import zh from "../../../locales/zh/report.json" with { type: "json" };

import type { Catalog } from "../../infra/i18n.ts";

export const REPORT_CATALOG: Catalog = { en, zh };
