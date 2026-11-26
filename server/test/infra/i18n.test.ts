import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CATALOGS, catalogLocale, t } from "../../src/infra/i18n.ts";

test("every catalog file exists in every locale with exactly the keys of en", () => {
  // Read from disk, so a catalog added by any area is covered without registering it here.
  const root = join(import.meta.dir, "..", "..", "locales");
  const locales = readdirSync(root).sort();
  expect(locales).toContain("en");
  for (const file of readdirSync(join(root, "en")).sort()) {
    const en = Object.keys(JSON.parse(readFileSync(join(root, "en", file), "utf8")) as object).sort();
    for (const locale of locales) {
      const keys = Object.keys(JSON.parse(readFileSync(join(root, locale, file), "utf8")) as object).sort();
      expect([file, locale, keys]).toEqual([file, locale, en]);
    }
  }
});

test("every locale has exactly the keys of en", () => {
  const en = Object.keys(CATALOGS.en ?? {}).sort();
  expect(en.length).toBeGreaterThan(0);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    expect([locale, Object.keys(catalog).sort()]).toEqual([locale, en]);
  }
});

test("lookup falls back to en and then to the key; a missing value leaves its placeholder", () => {
  expect(catalogLocale("zh-CN")).toBe("zh");
  expect(catalogLocale("ZH_tw")).toBe("zh");
  expect(catalogLocale("fr")).toBe("en");
  expect(catalogLocale("constructor")).toBe("en");
  expect(t("fr", "net.error.bad_key")).toBe("That key is not recognised.");
  expect(t("zh", "no.such.key")).toBe("no.such.key");
  expect(t("en", "net.error.protocol_mismatch", { server: "3.0" })).toBe(
    "Protocol mismatch: this server speaks 3.0, the client speaks {client}.",
  );
});
