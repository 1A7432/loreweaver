import { expect, test } from "bun:test";

import { CATALOGS, catalogLocale, t } from "../../src/infra/i18n.ts";

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
