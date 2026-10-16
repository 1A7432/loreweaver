import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FrameType, type MediaPayload, type ReportFrame } from "loreweaver-protocol"
import { sha256Hex } from "./media"
import { resolveReportDir, safeReportName, saveReport } from "./report"

const HTML = new TextEncoder().encode("<!DOCTYPE html><title>Report</title><p>The ledger.</p>")
const HASH = sha256Hex(HTML)

function frame(overrides: Partial<ReportFrame> = {}): ReportFrame {
  return {
    type: FrameType.Report,
    hash: HASH,
    name: "loreweaver-report-lamp-20261016-120000.html",
    size: HTML.length,
    mime: "text/html",
    variant: "player",
    ...overrides,
  }
}

function client(bytes: Uint8Array | Error) {
  const requested: string[] = []
  return {
    requested,
    getMedia(hash: string): Promise<MediaPayload> {
      requested.push(hash)
      if (bytes instanceof Error) return Promise.reject(bytes)
      return Promise.resolve({ hash, mime: "text/html", name: "x.html", bytes })
    },
  }
}

describe("report directory", () => {
  test("prefers a loreweaver folder inside an existing Downloads", () => {
    const env = { HOME: "/home/ada" }
    expect(resolveReportDir(env, (path) => path === "/home/ada/Downloads")).toBe("/home/ada/Downloads/loreweaver")
  })

  test("falls back to ~/.loreweaver/reports, honouring TRPG_HOME", () => {
    expect(resolveReportDir({ HOME: "/home/ada" }, () => false)).toBe("/home/ada/.loreweaver/reports")
    expect(resolveReportDir({ HOME: "/home/ada", TRPG_HOME: "/srv/lw" }, () => false)).toBe("/srv/lw/reports")
  })
})

describe("safeReportName", () => {
  test("keeps a plain server name", () => {
    expect(safeReportName("loreweaver-report-a-1.html", HASH)).toBe("loreweaver-report-a-1.html")
  })

  test("strips directories, traversal, control and reserved characters", () => {
    expect(safeReportName("../../etc/passwd", HASH)).toBe("passwd.html")
    expect(safeReportName("..\\..\\evil.html", HASH)).toBe("evil.html")
    expect(safeReportName('a<b>:"c|?*\u0007.html', HASH)).toBe("a-b---c---.html")
    expect(safeReportName(".hidden", HASH)).toBe("hidden.html")
  })

  test("an unusable name falls back to the hash", () => {
    expect(safeReportName("", HASH)).toBe(`loreweaver-report-${HASH.slice(0, 12)}.html`)
    expect(safeReportName("../..", HASH)).toBe(`loreweaver-report-${HASH.slice(0, 12)}.html`)
  })
})

describe("saveReport", () => {
  test("fetches by hash, verifies, and writes an owner-only file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-report-"))
    const mock = client(HTML)
    const path = await saveReport(mock, frame(), { dir })
    expect(mock.requested).toEqual([HASH])
    expect(path).toBe(join(dir, "loreweaver-report-lamp-20261016-120000.html"))
    expect(new Uint8Array(await readFile(path))).toEqual(HTML)
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("never overwrites an earlier report with the same name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-report-dup-"))
    const first = await saveReport(client(HTML), frame(), { dir })
    const second = await saveReport(client(HTML), frame(), { dir })
    expect(second).not.toBe(first)
    expect(second).toBe(join(dir, "loreweaver-report-lamp-20261016-120000-1.html"))
  })

  test("refuses bytes that do not match the announced hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-report-bad-"))
    await expect(saveReport(client(new TextEncoder().encode("tampered")), frame(), { dir })).rejects.toThrow(
      "checksum",
    )
  })

  test("surfaces a failed fetch (e.g. a reveal hash on a player connection)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-report-404-"))
    await expect(saveReport(client(new Error("media_not_found")), frame({ variant: "reveal" }), { dir })).rejects.toThrow(
      "media_not_found",
    )
  })
})
