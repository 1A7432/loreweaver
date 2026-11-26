// The only source of text a person reads. Catalogs are `server/locales/<locale>/*.json`
// (flat, namespaced keys); each file is imported here so a compiled binary carries
// them. Lookup falls back: the asked locale, then `en`, then the key itself. A
// placeholder with no value is left as written — a message never throws.
import enNet from "../../locales/en/net.json" with { type: "json" };
import zhNet from "../../locales/zh/net.json" with { type: "json" };

export const CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: { ...enNet },
  zh: { ...zhNet },
};

export const DEFAULT_LOCALE = "en";

/** `zh-CN`, `zh_TW`, `ZH` → `zh`; anything without a catalog → `en`. */
export function catalogLocale(locale: string): string {
  const language = locale.toLowerCase().split(/[-_]/, 1)[0] ?? "";
  // `hasOwn`, not `in`: a locale is client input, and "constructor" is not a language.
  return Object.hasOwn(CATALOGS, language) ? language : DEFAULT_LOCALE;
}

/** A set of messages by locale: what one area of the server imports from its JSON files. */
export type Catalog = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Look `key` up in a catalog. Each area of the server owns its catalog (a `catalog.ts`
 * beside its code importing `server/locales/<locale>/<area>.json`) and passes it here, so
 * areas built in parallel never edit one shared registry.
 */
export function translate(
  catalog: Catalog,
  locale: string,
  key: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const language = locale.toLowerCase().split(/[-_]/, 1)[0] ?? "";
  const own = Object.hasOwn(catalog, language) ? catalog[language] : undefined;
  const template = own?.[key] ?? catalog[DEFAULT_LOCALE]?.[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export function t(locale: string, key: string, params: Readonly<Record<string, string | number>> = {}): string {
  return translate(CATALOGS, locale, key, params);
}
