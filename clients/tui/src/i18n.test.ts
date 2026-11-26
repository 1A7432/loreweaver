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

describe("the dictionary", () => {
  test("both languages carry the same keys, and every placeholder of one is in the other", async () => {
    const source = await Bun.file(new URL("./i18n.ts", import.meta.url)).text()
    const block = (name: string, next: string) => source.slice(source.indexOf(`  ${name}: {`), source.indexOf(next, source.indexOf(`  ${name}: {`)))
    const entries = (text: string) => new Map([...text.matchAll(/^\s+"([^"]+)":\s*\n?\s*("(?:[^"\\]|\\.)*")/gm)].map((match) => [match[1] as string, match[2] as string]))
    const en = entries(block("en", "\n  },"))
    const zh = entries(block("zh", "\n  },"))
    expect([...zh.keys()].sort()).toEqual([...en.keys()].sort())
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const [key, text] of en) expect([key, vars(zh.get(key) ?? "")]).toEqual([key, vars(text)])
    expect(en.size).toBeGreaterThan(100)
  })

  test("the human with the admin key is never called the Keeper", async () => {
    const source = await Bun.file(new URL("./i18n.ts", import.meta.url)).text()
    expect(source).not.toMatch(/"menu\.role\.keeper"|keeper key|守秘人密钥|守秘人钥匙/i)
  })
})
