import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { BUNDLE_FORMAT, exportedBundle, MAX_SAVE_BYTES, parseSaveFile, resolveSaveDir, SAVE_LIMIT_MB, saveFileName, savedBundle, sizeLabel, writeSave } from "./save"
import { MAX_LINE_BYTES } from "./irohLink"

const AT = new Date(2026, 10, 27, 9, 5, 7)
const bytes = (text: string) => new TextEncoder().encode(text)
const ok = (data: unknown) => ({ ok: true as const, data })

describe("save file names", () => {
  test("<room>-<YYYYMMDD-HHMMSS>.json, the room made safe exactly as a report page's name is", () => {
    expect(saveFileName("arkham", AT)).toBe("arkham-20261127-090507.json")
    expect(saveFileName("arkham", AT, 2)).toBe("arkham-20261127-090507-2.json")
    // No path leaves the folder: separators and drive marks go, leading dots go.
    expect(saveFileName("../../etc/passwd", AT)).toBe("-..-etc-passwd-20261127-090507.json")
    expect(saveFileName("..\\..\\win", AT)).not.toMatch(/[\\/]/)
    expect(saveFileName("a/b:c*d?e\"f<g>h|i", AT)).toBe("a-b-c-d-e-f-g-h-i-20261127-090507.json")
    expect(saveFileName(".hidden", AT)).toBe("hidden-20261127-090507.json")
    // Control characters are stripped; a CJK name is kept; nothing left falls back to "room".
    expect(saveFileName("a\u001b[31mb\u0007", AT)).not.toMatch(/[\u0000-\u001f]/)
    expect(saveFileName("安土", AT)).toBe("安土-20261127-090507.json")
    expect(saveFileName("", AT)).toBe("room-20261127-090507.json")
    expect(saveFileName(undefined, AT)).toBe("room-20261127-090507.json")
    expect(saveFileName("...", AT)).toBe("room-20261127-090507.json")
    expect(saveFileName("x".repeat(500), AT).length).toBeLessThan(150)
  })

  test("saves live under ~/.loreweaver/saves, and TRPG_HOME moves them", () => {
    expect(resolveSaveDir({ HOME: "/home/ada" })).toBe(join("/home/ada", ".loreweaver", "saves"))
    expect(resolveSaveDir({ HOME: "/home/ada", TRPG_HOME: "/data/lw" })).toBe(join("/data/lw", "saves"))
  })
})

describe("writeSave", () => {
  test("writes the bundle as compact JSON, readable by this user alone, in a private folder", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "lw-save-")), "saves")
    const bundle = { format: BUNDLE_FORMAT, version: 1, turn: 3, documents: [{ id: "d1", data: "{\"secret\":\"the well\"}" }], events: [] }
    const written = await writeSave(bundle, { room: "arkham", at: AT, dir })
    expect(written.path).toBe(join(dir, "arkham-20261127-090507.json"))
    expect(JSON.parse(await readFile(written.path, "utf8"))).toEqual(bundle)
    expect(written.bytes).toBe((await readFile(written.path)).length)
    expect(written.bytes).toBe(JSON.stringify(bundle).length)
    if (process.platform !== "win32") {
      expect((await stat(written.path)).mode & 0o777).toBe(0o600)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    }
  })

  test("a second save in the same second never replaces the first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-save-"))
    const first = await writeSave({ n: 1 }, { room: "arkham", at: AT, dir })
    const second = await writeSave({ n: 2 }, { room: "arkham", at: AT, dir })
    expect(second.path).not.toBe(first.path)
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({ n: 1 })
    expect(JSON.parse(await readFile(second.path, "utf8"))).toEqual({ n: 2 })
    expect((await readdir(dir)).sort()).toEqual(["arkham-20261127-090507-2.json", "arkham-20261127-090507.json"])
  })

  test("whatever the room is called, the file stays inside the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-save-"))
    const written = await writeSave({ n: 1 }, { room: "../../outside", at: AT, dir })
    expect(dirname(written.path)).toBe(dir)
    expect(relative(dir, written.path).startsWith("..")).toBe(false)
  })
})

describe("what a save answer is", () => {
  test("an export's data is the bundle: a plain object", () => {
    const bundle = { format: BUNDLE_FORMAT, documents: [] }
    expect(exportedBundle(ok(bundle))).toEqual(bundle)
    expect(exportedBundle(ok([1]))).toBeNull()
    expect(exportedBundle(ok(null))).toBeNull()
    expect(exportedBundle(ok("text"))).toBeNull()
    expect(exportedBundle({ ok: false, error: { code: "forbidden", message: "no" } })).toBeNull()
    expect(exportedBundle(null)).toBeNull()
  })

  test("a typed command's answer is a save's only when it carries a bundle's own marker", () => {
    expect(savedBundle(ok({ format: BUNDLE_FORMAT, documents: [] }))).not.toBeNull()
    // The answer to an import, to a roll, to a report: not a bundle.
    expect(savedBundle(ok({ epoch: 2, turn: 4 }))).toBeNull()
    expect(savedBundle(ok({ totals: [4] }))).toBeNull()
    expect(savedBundle(ok({ format: "html", edition: "player" }))).toBeNull()
    expect(savedBundle(ok(undefined))).toBeNull()
    expect(savedBundle(null)).toBeNull()
  })
})

describe("reading a save file", () => {
  test("an object of JSON is taken; anything else says what it is", () => {
    expect(parseSaveFile(bytes("{\"format\":\"loreweaver-room\"}"))).toEqual({ ok: true, bundle: { format: "loreweaver-room" } })
    expect(parseSaveFile(bytes("﻿{\"a\":1}"))).toEqual({ ok: true, bundle: { a: 1 } })
    for (const text of ["", "{", "not json", "{'a':1}", "{\"a\":1} trailing"]) expect(parseSaveFile(bytes(text))).toEqual({ ok: false, code: "not_json" })
    expect(parseSaveFile(Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]))).toEqual({ ok: false, code: "not_json" })
    for (const text of ["[]", "[{}]", "null", "42", "true", "\"a\""]) expect(parseSaveFile(bytes(text))).toEqual({ ok: false, code: "not_object" })
  })
})

describe("the limit", () => {
  test("is the largest line this client takes from a server: a room it could save is a room it can restore", () => {
    expect(MAX_SAVE_BYTES).toBe(MAX_LINE_BYTES)
    expect(SAVE_LIMIT_MB).toBe(8)
  })

  test("sizes read as a person writes them", () => {
    expect(sizeLabel(0)).toBe("0 B")
    expect(sizeLabel(1023)).toBe("1023 B")
    expect(sizeLabel(1536)).toBe("1.5 KB")
    expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB")
  })
})
