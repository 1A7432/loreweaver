import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { looksLikeSave, MAX_SAVE_BYTES, resolveSaveDir, SAVE_LIMIT_MB, saveFileName, savedFile, sizeLabel, writeSave } from "./save"
import { MAX_FETCH_BYTES } from "./irohLink"

const AT = new Date(2026, 10, 27, 9, 5, 7)
const bytes = (text: string) => new TextEncoder().encode(text)
const ok = (data: unknown) => ({ ok: true as const, data })
const HASH = "c".repeat(64)

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
  test("writes the save's bytes as they are, readable by this user alone, in a private folder", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "lw-save-")), "saves")
    const data = bytes(JSON.stringify({ format: "loreweaver-room", version: 1, turn: 3, documents: [{ id: "d1", data: "{\"secret\":\"the well\"}" }], events: [] }))
    const written = await writeSave(data, { room: "arkham", at: AT, dir })
    expect(written.path).toBe(join(dir, "arkham-20261127-090507.json"))
    expect(new Uint8Array(await readFile(written.path))).toEqual(data)
    expect(written.bytes).toBe(data.length)
    if (process.platform !== "win32") {
      expect((await stat(written.path)).mode & 0o777).toBe(0o600)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    }
  })

  test("a second save in the same second never replaces the first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-save-"))
    const first = await writeSave(bytes("{\"n\":1}"), { room: "arkham", at: AT, dir })
    const second = await writeSave(bytes("{\"n\":2}"), { room: "arkham", at: AT, dir })
    expect(second.path).not.toBe(first.path)
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({ n: 1 })
    expect(JSON.parse(await readFile(second.path, "utf8"))).toEqual({ n: 2 })
    expect((await readdir(dir)).sort()).toEqual(["arkham-20261127-090507-2.json", "arkham-20261127-090507.json"])
  })

  test("whatever the room is called, the file stays inside the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-save-"))
    const written = await writeSave(bytes("{}"), { room: "../../outside", at: AT, dir })
    expect(dirname(written.path)).toBe(dir)
    expect(relative(dir, written.path).startsWith("..")).toBe(false)
  })
})

describe("what a save answer is", () => {
  const media = { hash: HASH, mime: "application/json", size: 120, name: "save-arkham.json" }

  test("an export answers with a file to fetch: counts and a JSON file's reference", () => {
    expect(savedFile(ok({ documents: 3, events: 9, media }))).toEqual({ hash: HASH, size: 120, name: "save-arkham.json" })
    expect(savedFile(ok({ documents: 3, events: 9, media: { ...media, name: 7 } }))).toEqual({ hash: HASH, size: 120, name: "" })
  })

  test("anything else is not a save's answer: an import's, a roll's, a report page's, a bundle in the data", () => {
    expect(savedFile(ok({ epoch: 2, turn: 4 }))).toBeNull()
    expect(savedFile(ok({ totals: [4] }))).toBeNull()
    expect(savedFile(ok({ format: "html", edition: "player", media: { ...media, mime: "text/html" } }))).toBeNull()
    expect(savedFile(ok({ format: "loreweaver-room", documents: [], events: [] }))).toBeNull()
    expect(savedFile(ok({ documents: 3, events: 9, media: { ...media, hash: "ABC" } }))).toBeNull()
    expect(savedFile(ok({ documents: 3, events: 9, media: { ...media, size: -1 } }))).toBeNull()
    expect(savedFile(ok({ documents: "3", events: 9, media }))).toBeNull()
    expect(savedFile(ok(undefined))).toBeNull()
    expect(savedFile({ ok: false, error: { code: "forbidden", message: "no" } })).toBeNull()
    expect(savedFile(null)).toBeNull()
  })
})

describe("a file that may be a save", () => {
  test("starts like one JSON object; the rest is the server's to judge", () => {
    for (const text of ["{\"format\":\"loreweaver-room\"}", "\ufeff{\"a\":1}", "  \n\t{", "{not json"]) expect(looksLikeSave(bytes(text))).toBe(true)
    for (const text of ["", "[]", "null", "42", "\"a\"", "x{"]) expect(looksLikeSave(bytes(text))).toBe(false)
    expect(looksLikeSave(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
  })
})

describe("the limit", () => {
  test("is the server's default limit for one save file, beyond what this client fetches of any other file", () => {
    expect(MAX_SAVE_BYTES).toBe(256 * 1024 * 1024)
    expect(SAVE_LIMIT_MB).toBe(256)
    expect(MAX_SAVE_BYTES).toBeGreaterThan(MAX_FETCH_BYTES)
  })

  test("sizes read as a person writes them", () => {
    expect(sizeLabel(0)).toBe("0 B")
    expect(sizeLabel(1023)).toBe("1023 B")
    expect(sizeLabel(1536)).toBe("1.5 KB")
    expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB")
  })
})
