/**
 * Looking up a pack's presentation data for a viewer locale. The pack's text is content
 * the pack author wrote (rank labels, expertise prompts, subsystem and table names); the
 * engine only picks the entry. Each lookup tries the locale's base language (the part
 * before `-`/`_`, case-folded) first; the fallbacks differ by kind, as the format sets
 * them.
 */

import { localizedName } from "../subsystems/spec.ts";
import type { DrawTable, SubsystemSpec } from "../subsystems/spec.ts";
import { baseLocale } from "./raw.ts";
import type { RankLabel, RulePack } from "./types.ts";

/** A rank's label for `locale`: its base language, then `en`; null when the pack labels it in neither. */
export function rankLabel(pack: RulePack, rankId: string, locale: string | null | undefined): RankLabel | null {
  for (const table of [pack.labels.get(baseLocale(locale)), pack.labels.get("en")]) {
    const label = table?.get(rankId);
    if (label !== undefined) return label;
  }
  return null;
}

/** The rank's display text for `locale`, falling back to the rank id itself. */
export function rankDisplay(pack: RulePack, rankId: string, locale: string | null | undefined): string {
  return rankLabel(pack, rankId, locale)?.display ?? rankId;
}

/** The pack's keeper-expertise text for `locale` (base language, then `en`); empty when undeclared. */
export function expertiseText(pack: RulePack, locale: string | null | undefined): string {
  const base = baseLocale(locale === null || locale === undefined || locale === "" ? "en" : locale);
  return pack.expertise.get(base) ?? pack.expertise.get("en") ?? "";
}

/** A subsystem's display name for `locale`: base language, `en`, any declared name, then its id. */
export function subsystemName(spec: SubsystemSpec, locale: string | null | undefined): string {
  return localizedName(spec.labels, locale, spec.id);
}

/** A draw table's display name for `locale`: base language, `en`, then its id. */
export function tableName(table: DrawTable, locale: string | null | undefined): string {
  const base = baseLocale(locale === null || locale === undefined || locale === "" ? "en" : locale);
  return table.labels.get(base) ?? table.labels.get("en") ?? table.id;
}
