import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  AnchorRegistry,
  C2C_BUDGET,
  DEFAULT_SEND_TIMEOUT_MS,
  GROUP_BUDGET,
  GROUP_WINDOW_MS,
  MIN_MARGIN_MS,
  computeExpiresAt,
} from "./anchors"

describe("anchors", () => {
  test("expires_at is platform timestamp minus remaining planned sends × timeout, floor 10s", () => {
    const received = 1_000_000
    const expires = computeExpiresAt(received, "group", GROUP_BUDGET, DEFAULT_SEND_TIMEOUT_MS)
    const margin = GROUP_BUDGET * DEFAULT_SEND_TIMEOUT_MS
    expect(margin).toBeGreaterThan(MIN_MARGIN_MS)
    expect(expires).toBe(received + GROUP_WINDOW_MS - margin)
    const tight = computeExpiresAt(received, "c2c", 0, DEFAULT_SEND_TIMEOUT_MS)
    expect(tight).toBe(received + 60 * 60 * 1000 - MIN_MARGIN_MS)
  })

  test("seq is the attempt counter; budget group 5 / C2C 4; persist restores seq", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-anc-"))
    const path = join(dir, "g.anchors.json")
    const first = await AnchorRegistry.load(path, { now: () => 0 })
    const group = first.create({ id: "m1", scope: "group", target: "G", seat: "u1", receivedAt: 0 })
    expect(group.budget).toBe(GROUP_BUDGET)
    expect(first.bumpSeq(group)).toBe(1)
    expect(first.bumpSeq(group)).toBe(2)
    const c2c = first.create({ id: "c1", scope: "c2c", target: "U", receivedAt: 0 })
    expect(c2c.budget).toBe(C2C_BUDGET)
    await first.flush()
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)

    const second = await AnchorRegistry.load(path, { now: () => 0 })
    expect(second.get("m1")?.seq).toBe(2)
    expect(second.bumpSeq(second.get("m1")!)).toBe(3)
  })

  test("newest OPEN group anchor at arrival; spent/dead/expired are skipped", () => {
    const now = 10_000
    const store = new AnchorRegistry("/tmp/unused.json", { now: () => now })
    const a = store.create({ id: "a", scope: "group", target: "G", receivedAt: 1000 })
    const b = store.create({ id: "b", scope: "group", target: "G", receivedAt: 2000 })
    expect(store.newestOpen("group", "G", now)?.id).toBe("b")
    store.markDead(b)
    expect(store.newestOpen("group", "G", now)?.id).toBe("a")
    a.budget = 0
    expect(store.newestOpen("group", "G", now)).toBeUndefined()
  })

  test("newestOpenForSeat never returns another player's anchor", () => {
    const store = new AnchorRegistry("/tmp/unused.json", { now: () => 0 })
    store.create({ id: "a", scope: "group", target: "G", seat: "111", receivedAt: 1 })
    store.create({ id: "b", scope: "group", target: "G", seat: "222", receivedAt: 2 })
    expect(store.newestOpenForSeat("111", 0)?.id).toBe("a")
    expect(store.newestOpenForSeat("222", 0)?.id).toBe("b")
    expect(store.newestOpenForSeat("333", 0)).toBeUndefined()
  })
})
