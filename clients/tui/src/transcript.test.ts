import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FrameType } from "@loreweaver/protocol"
import type { LogFrame } from "./components/NarrativeLog"
import {
  framesToTranscript,
  resolveTranscriptDir,
  slugifyRoom,
  transcriptFileName,
  transcriptLine,
  transcriptStamp,
  writeTranscript,
} from "./transcript"

const AT = new Date(2026, 6, 25, 21, 4, 5)

describe("transcriptLine", () => {
  test("narrative speakers keep the labels the log showed", () => {
    expect(
      transcriptLine({ type: FrameType.Narrative, id: "1", speaker: "kp", text: "**Dust.**", format: "markdown" }),
    ).toBe("KP: **Dust.**")
    expect(
      transcriptLine({ type: FrameType.Narrative, id: "2", speaker: "npc", name: "Martha", text: "Hush.", format: "markdown" }),
    ).toBe("[Martha]: Hush.")
    expect(
      transcriptLine({ type: FrameType.Narrative, id: "3", speaker: "player", name: "Liu", text: "I search.", format: "text" }),
    ).toBe("Liu: I search.")
  })

  test("a v1.7 ui frame writes one plain line per block, options by label only", () => {
    expect(
      transcriptLine({
        type: FrameType.Ui,
        panel: "inline",
        blocks: [
          { kind: "badge", label: "Chapter 2" },
          { kind: "meter", label: "Fear", value: 3, min: 0, max: 10 },
          { kind: "choices", prompt: "Pick", options: [{ id: "a", label: "Attack", input: ".ra fight" }] },
        ],
      }),
    ).toBe("[Chapter 2]\nFear ▒▒▒░░░░░░░ 3/10\nPick\n▫ Attack")
  })

  test("a dice line carries target and outcome, and a targetless roll neither", () => {
    expect(
      transcriptLine({
        type: FrameType.Dice,
        actor: "Liu",
        kind: "check",
        expr: "1d100",
        rolls: [24],
        total: 24,
        target: 70,
        level: "HARD SUCCESS",
      }),
    ).toBe("⚄ Liu 1d100 24 vs 70 -> HARD SUCCESS")
    expect(transcriptLine({ type: FrameType.Dice, actor: "Goblin", kind: "roll", expr: "1d6", rolls: [4], total: 4 })).toBe(
      "⚄ Goblin 1d6 4",
    )
  })

  test("a live spinner is UI state, not transcript content", () => {
    expect(transcriptLine({ type: FrameType.System, level: "info", text: "thinking", spinner: true })).toBeUndefined()
    expect(transcriptLine({ type: FrameType.System, level: "warn", text: "rate limited" })).toBe("[WARN] rate limited")
  })

  test("media and audio frames degrade to readable placeholders", () => {
    expect(
      transcriptLine({
        type: FrameType.Media,
        id: "m1",
        name: "map.png",
        from: "KP",
        ts: 0,
        hash: "abc",
        mime: "image/png",
        size: 10,
      }),
    ).toBe("[image] KP: map.png")
    expect(
      transcriptLine({
        type: FrameType.AudioControl,
        id: "a1",
        action: "play",
        layer: "bgm",
        title: "Rain",
      }),
    ).toBe("[BGM] play · Rain")
  })

  test("control bytes from a hostile name or text never reach the file", () => {
    const line = transcriptLine({
      type: FrameType.Narrative,
      id: "4",
      speaker: "npc",
      name: "Ma\u001b[31mrtha",
      text: "hi\u0007there",
      format: "text",
    })
    expect(line).not.toContain("\u001b")
    expect(line).not.toContain("\u0007")
  })
})

describe("framesToTranscript", () => {
  test("writes a provenance header and skips frames with no content", () => {
    const frames: LogFrame[] = [
      { type: FrameType.System, level: "info", text: "thinking", spinner: true },
      { type: FrameType.Narrative, id: "1", speaker: "kp", text: "The door gives.", format: "markdown" },
    ]
    const text = framesToTranscript(frames, { room: "lighthouse", at: AT })
    expect(text).toContain("# Loreweaver transcript")
    expect(text).toContain("# room: lighthouse")
    expect(text).toContain(`# saved: ${AT.toISOString()}`)
    expect(text).toContain("KP: The door gives.")
    expect(text).not.toContain("thinking")
    expect(text.endsWith("\n")).toBe(true)
  })
})

describe("file naming", () => {
  test("the stamp is local wall-clock time, zero-padded and sortable", () => {
    expect(transcriptStamp(AT)).toBe("20260725-210405")
  })

  test("a room name is reduced to a safe fragment", () => {
    expect(slugifyRoom("Blackmoor Lighthouse")).toBe("Blackmoor-Lighthouse")
    expect(transcriptFileName(AT, "lighthouse")).toBe("lighthouse-20260725-210405.txt")
  })

  test("path traversal and a fully non-ASCII name cannot escape the transcript dir", () => {
    // The room name is server-supplied, so this is the confinement guarantee.
    expect(slugifyRoom("../../etc/passwd")).toBe("etc-passwd")
    expect(slugifyRoom("黑沼灯塔")).toBe("room")
    expect(slugifyRoom("")).toBe("room")
    expect(transcriptFileName(AT, "../../evil")).not.toContain("/")
  })

  test("the default directory honours TRPG_HOME", () => {
    expect(resolveTranscriptDir({ TRPG_HOME: "/tmp/lw-home" })).toBe("/tmp/lw-home/transcripts")
  })
})

describe("writeTranscript", () => {
  test("creates the file and returns the path written", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "lw-transcript-")), "nested")
    const path = await writeTranscript(
      [{ type: FrameType.Narrative, id: "1", speaker: "kp", text: "Saved.", format: "markdown" }],
      { room: "lighthouse", at: AT, dir },
    )
    expect(path).toBe(join(dir, "lighthouse-20260725-210405.txt"))
    expect(await readFile(path, "utf8")).toContain("KP: Saved.")
  })
})
