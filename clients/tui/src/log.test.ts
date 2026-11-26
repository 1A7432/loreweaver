import { describe, expect, test } from "bun:test"
import type { EventFrame } from "loreweaver-protocol/v3"
import type { LocalLine } from "./connection"
import { lastChoicesIndex, logItems } from "./log"

function narrative(seq: number, text = `line ${seq}`): EventFrame {
  return { type: "event", seq, id: `e${seq}`, ts: seq, kind: "narrative", data: { speaker: "kp", text, format: "markdown" } }
}

function blocks(seq: number, id: string, label: string, replace?: boolean, choices = false): EventFrame {
  const list = choices ? [{ kind: "choices" as const, options: [{ id: "a", label, command: "roll" }] }] : [{ kind: "badge" as const, label }]
  return { type: "event", seq, id, ts: seq, kind: "blocks", data: { blocks: list, ...(replace === undefined ? {} : { replace }) } }
}

function line(id: number, after: number, text = `local ${id}`): LocalLine {
  return { id, after, kind: "result", level: "info", text }
}

const keys = (items: ReturnType<typeof logItems>) => items.map((item) => item.key)

describe("logItems", () => {
  test("events in order, each local line after the event it followed, drafts last", () => {
    const items = logItems([narrative(1), narrative(2), narrative(5)], [{ id: "d1", text: "Rain…" }], [line(1, 0), line(2, 2), line(3, 3), line(4, 5)])
    expect(keys(items)).toEqual(["l1", "e1", "e2", "l2", "l3", "e5", "l4", "dd1"])
  })

  test("a blocks event with replace updates the earlier one with its id in place", () => {
    const items = logItems([blocks(1, "card", "old"), narrative(2), blocks(3, "card", "new", true), blocks(4, "other", "kept")], [], [])
    expect(keys(items)).toEqual(["e1", "e2", "e4"])
    const first = items[0]
    expect(first?.kind === "event" && first.blocks?.blocks[0]).toEqual({ kind: "badge", label: "new" })
  })

  test("a later blocks event with the same id but no replace is a block of its own", () => {
    expect(keys(logItems([blocks(1, "card", "a"), blocks(2, "card", "b")], [], []))).toEqual(["e1", "e2"])
  })

  test("Ctrl+L hides events and local lines up to the mark", () => {
    const items = logItems([narrative(1), narrative(2), narrative(3)], [], [line(1, 1), line(2, 3)], { seq: 2, lineId: 1 })
    expect(keys(items)).toEqual(["e3", "l2"])
  })

  test("the live choices block is the last one", () => {
    const items = logItems([blocks(1, "a", "x", undefined, true), narrative(2), blocks(3, "b", "y", undefined, true), narrative(4)], [], [])
    expect(lastChoicesIndex(items)).toBe(2)
    expect(lastChoicesIndex(logItems([narrative(1)], [], []))).toBe(-1)
  })
})
