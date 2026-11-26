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

export function t(locale: string, key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const template = CATALOGS[catalogLocale(locale)]?.[key] ?? CATALOGS[DEFAULT_LOCALE]?.[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}
