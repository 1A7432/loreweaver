import { describe, expect, test } from "bun:test"
import { localeFromEnvironment, normalizeLocale } from "./i18n"

describe("TUI locale defaults", () => {
  test("unknown or absent locale falls back to English", () => {
    expect(normalizeLocale()).toBe("en")
    expect(normalizeLocale("C.UTF-8")).toBe("en")
    expect(localeFromEnvironment({}, "fr-FR")).toBe("en")
  })

  test("TRPG_LOCALE overrides the system locale", () => {
    expect(localeFromEnvironment({ TRPG_LOCALE: "zh-CN", LANG: "en_US.UTF-8" })).toBe("zh")
    expect(localeFromEnvironment({ TRPG_LOCALE: "en", LANG: "zh_CN.UTF-8" })).toBe("en")
  })

  test("uses POSIX locale precedence when there is no explicit override", () => {
    expect(localeFromEnvironment({ LANG: "zh_CN.UTF-8" })).toBe("zh")
    expect(localeFromEnvironment({ LC_MESSAGES: "zh_TW", LANG: "en_US.UTF-8" })).toBe("zh")
    expect(localeFromEnvironment({ LC_ALL: "en_GB", LC_MESSAGES: "zh_CN" })).toBe("en")
  })

  test("falls back to the runtime locale when environment variables are absent", () => {
    expect(localeFromEnvironment({}, "zh-Hant-TW")).toBe("zh")
    expect(localeFromEnvironment({}, "en-US")).toBe("en")
  })
})
