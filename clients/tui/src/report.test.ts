import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Result } from "loreweaver-protocol/v3"
import { reportFileName, reportOffer, saveReport } from "./report"

const HASH = "a".repeat(64)
const page = (media: Record<string, unknown>, format = "html"): Result => ({ ok: true, data: { format, edition: "player", media } })

describe("a report page", () => {
  test("is recognised by its shape, and by nothing less", () => {
    expect(reportOffer(page({ hash: HASH, mime: "text/html", size: 10, name: "session-report-main-20261127-1100.html" }))).toEqual({ hash: HASH, name: "session-report-main-20261127-1100.html" })
    expect(reportOffer(null)).toBeNull()
    expect(reportOffer({ ok: false, error: { code: "forbidden", message: "no" } })).toBeNull()
    expect(reportOffer({ ok: true, data: { format: "text", players: [] } })).toBeNull()
    expect(reportOffer({ ok: true, data: null })).toBeNull()
    // Another command's result that happens to name a file is not a report.
    expect(reportOffer(page({ hash: HASH, mime: "image/png", name: "x.png" }))).toBeNull()
    expect(reportOffer(page({ hash: "../../etc/passwd", mime: "text/html", name: "x.html" }))).toBeNull()
    expect(reportOffer(page({ hash: HASH, mime: "text/html" }))).toEqual({ hash: HASH, name: "" })
  })

  test("is written under a name that cannot leave the reports folder", async () => {
    expect(reportFileName({ hash: HASH, name: "团报-雾港-20261127-1100.html" })).toBe("团报-雾港-20261127-1100.html")
    expect(reportFileName({ hash: HASH, name: "../../.ssh/authorized_keys" })).toBe("-..-.ssh-authorized_keys.html")
    expect(reportFileName({ hash: HASH, name: "C:\\Users\\x\\report.html" })).toBe("C--Users-x-report.html")
    expect(reportFileName({ hash: HASH, name: "\u0000\u001b[2J" })).toBe("[2J.html")
    expect(reportFileName({ hash: HASH, name: "" })).toBe(`report-${HASH.slice(0, 12)}.html`)
    expect(reportFileName({ hash: HASH, name: "...." })).toBe(`report-${HASH.slice(0, 12)}.html`)
    expect(reportFileName({ hash: HASH, name: "x".repeat(500) }).length).toBeLessThanOrEqual(125)

    const dir = join(await mkdtemp(join(tmpdir(), "lw-report-")), "reports")
    const path = await saveReport({ hash: HASH, name: "../escape.html" }, new TextEncoder().encode("<!DOCTYPE html>"), dir)
    expect(path.startsWith(dir)).toBe(true)
    expect(await readFile(path, "utf8")).toBe("<!DOCTYPE html>")
  })
})
