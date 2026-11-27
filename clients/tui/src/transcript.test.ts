import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DiceData, EventFrame } from "loreweaver-protocol/v3"
import { logItems, type LogItem } from "./log"
import { itemsToTranscript, resolveTranscriptDir, slugifyRoom, transcriptFileName, transcriptLine, transcriptStamp, writeTranscript } from "./transcript"

const AT = new Date(2026, 6, 25, 21, 4, 5)

function event(seq: number, rest: Pick<EventFrame, "kind" | "data">): EventFrame {
  return { type: "event", seq, id: `e${seq}`, ts: seq, ...rest } as EventFrame
}
const one = (frame: EventFrame): LogItem => ({ kind: "event", key: "k", event: frame })

describe("transcriptLine", () => {
  test("narrative speakers keep the labels the log showed", () => {
    expect(transcriptLine(one(event(1, { kind: "narrative", data: { speaker: "kp", text: "**Dust.**", format: "markdown" } })))).toBe("KP: **Dust.**")
    expect(transcriptLine(one(event(2, { kind: "narrative", data: { speaker: "npc", name: "Martha", text: "Hush.", format: "plain" } })))).toBe("[Martha]: Hush.")
    expect(transcriptLine(one(event(3, { kind: "narrative", data: { speaker: "player", name: "Liu", text: "I search.", format: "plain" } })))).toBe("Liu: I search.")
  })

  test("blocks write one plain line per block, options by label only", () => {
    const line = transcriptLine(
      one(event(4, { kind: "blocks", data: { blocks: [{ kind: "badge", label: "Chapter 2" }, { kind: "meter", label: "Fear", value: 3, min: 0, max: 10 }, { kind: "choices", prompt: "Pick", options: [{ id: "a", label: "Attack", command: "check" }] }] } })),
    )
    expect(line).toBe("[Chapter 2]\nFear ▒▒▒░░░░░░░ 3/10\nPick\n▫ Attack")
  })

  test("a dice line carries the effective target and the outcome; a plain roll neither", () => {
    expect(
      transcriptLine(one(event(5, { kind: "dice", data: { actor: "Liu", kind: "check", expr: "1d100", rolls: [24], total: 24, target: 70, effectiveTarget: 35, outcome: { id: "hard", label: "HARD SUCCESS", success: true, critical: false, fumble: false, tier: 3 } } }))),
    ).toBe("⚄ Liu 1d100 24 vs 35 -> HARD SUCCESS")
    expect(transcriptLine(one(event(6, { kind: "dice", data: { actor: "Goblin", kind: "roll", expr: "1d6", rolls: [4], total: 4 } })))).toBe("⚄ Goblin 1d6 4")
  })

  test("a dice line shows what was rolled for before the numbers, and the server's own line when it sent one", () => {
    const check: DiceData = { actor: "Alice", kind: "check", expr: "1d100", rolls: [19], total: 19, target: 25, label: "Spot Hidden", outcome: { id: "regular", label: "Success", success: true, critical: false, fumble: false, tier: 2 } }
    expect(transcriptLine(one(event(7, { kind: "dice", data: check })))).toBe("⚄ Alice Spot Hidden 1d100 19 vs 25 -> Success")
    const opposed: DiceData = {
      actor: "Alice",
      kind: "opposed",
      subsystem: "opposed_check",
      subsystemLabel: "Opposed check",
      expr: "1d100",
      rolls: [28, 53],
      total: 28,
      label: "Fighting (Brawl)",
      text: "Fighting (Brawl) 28 (Failure) vs Dodge 53 (Failure): Dodge wins (higher value)",
      detail: { winner: "b" },
    }
    expect(transcriptLine(one(event(8, { kind: "dice", data: opposed })))).toBe("⚄ Opposed check · Alice: Fighting (Brawl) 28 (Failure) vs Dodge 53 (Failure): Dodge wins (higher value)")
    const plain: DiceData = { actor: "Ada", kind: "roll", expr: "2d6", rolls: [4, 3], total: 7, text: "2d6 (4, 3) = 7\u001b[31m" }
    expect(transcriptLine(one(event(9, { kind: "dice", data: plain })))).toBe("⚄ Ada: 2d6 (4, 3) = 7[31m")
  })

  test("local lines are kept, a spinner and a draft are not; control characters are stripped", () => {
    const items = logItems(
      [event(1, { kind: "narrative", data: { speaker: "kp", text: "a\u001b[31mb", format: "markdown" } })],
      [{ id: "d", text: "half a sentence" }],
      [
        { id: 1, after: 1, kind: "result", level: "info", text: "STR 50" },
        { id: 2, after: 1, kind: "notice", level: "info", text: "Importing", spinner: true },
        { id: 3, after: 1, kind: "refusal", level: "warn", text: "No.", code: "forbidden" },
      ],
    )
    expect(items.map((item) => transcriptLine(item))).toEqual(["KP: a[31mb", "STR 50", undefined, "✖ No.", undefined])
  })
})

describe("transcript files", () => {
  test("names sort by time and keep only a safe slug of the room", () => {
    expect(transcriptStamp(AT)).toBe("20260725-210405")
    expect(slugifyRoom("../etc/passwd")).toBe("etc-passwd")
    expect(slugifyRoom("灯下")).toBe("room")
    expect(transcriptFileName(AT, "main")).toBe("main-20260725-210405.txt")
    expect(resolveTranscriptDir({ HOME: "/home/ada" })).toBe(join("/home/ada", ".loreweaver", "transcripts"))
  })

  test("the file has a header and every line in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-transcript-"))
    const items = logItems([event(1, { kind: "narrative", data: { speaker: "kp", text: "Rain.", format: "markdown" } }), event(2, { kind: "rewind", data: { from: 2, kept: [], epoch: 2 } })], [], [])
    const path = await writeTranscript(items, { room: "main", at: AT, dir })
    const body = await readFile(path, "utf8")
    expect(body).toBe(itemsToTranscript(items, { room: "main", at: AT }))
    expect(body).toContain("# room: main")
    expect(body).toContain("KP: Rain.\n↶ The last turn was undone\n")
  })
})
