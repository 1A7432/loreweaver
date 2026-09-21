import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { DEFERRED_CAP, DeferredStore, LATE_FLUSH_MAX, nextDeferredId } from "./deferred"

function item(now: number, text: string) {
  return {
    id: nextDeferredId(now),
    scope: "group" as const,
    target: "G",
    text,
    media: [{ hash: "h1", name: "still.png" }],
    createdAt: now,
    late: true,
  }
}

describe("deferred store", () => {
  test("persists text and media by hash, never file_info; 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-def-"))
    const path = join(dir, "g.deferred.json")
    const first = await DeferredStore.load(path, { now: () => 0 })
    first.pushGroup(item(0, "hello"))
    first.pushPrivate("admin-u", {
      id: "p1",
      scope: "admin",
      target: "admin-u",
      text: "secret",
      media: [],
      createdAt: 0,
      late: false,
    })
    await first.flush()
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
    const body = await Bun.file(path).text()
    expect(body).not.toContain("file_info")
    expect(body).toContain("h1")

    const second = await DeferredStore.load(path, { now: () => 0 })
    expect(second.items[0]?.text).toBe("hello")
    expect(second.items[0]?.media[0]?.hash).toBe("h1")
    expect(second.privateCount("admin-u")).toBe(1)
  })

  test("cap 50 drops oldest; takeLate is at most 2", async () => {
    let notices = 0
    const store = new DeferredStore("/tmp/unused.json", { now: () => 0 })
    for (let i = 0; i < DEFERRED_CAP + 1; i++) {
      const drop = store.pushGroup(item(0, `n${i}`))
      if (drop?.notice) notices += 1
    }
    expect(store.length).toBe(DEFERRED_CAP)
    expect(store.items[0]?.text).toBe("n1")
    expect(notices).toBe(1)
    const late = store.takeLate()
    expect(late).toHaveLength(LATE_FLUSH_MAX)
    expect(late[0]?.text).toBe("n1")
  })

  test("deferredDropped notice is at most once per hour", () => {
    let now = 0
    const store = new DeferredStore("/tmp/unused.json", { now: () => now })
    for (let i = 0; i < DEFERRED_CAP; i++) store.pushGroup(item(now, `a${i}`))
    const first = store.pushGroup(item(now, "overflow-1"))
    const second = store.pushGroup(item(now, "overflow-2"))
    expect(first?.notice).toBe(true)
    expect(second?.notice).toBe(false)
    now += 60 * 60 * 1000
    const third = store.pushGroup(item(now, "overflow-3"))
    expect(third?.notice).toBe(true)
  })

  test("player holds and C2C outbox are per seat / user", () => {
    const store = new DeferredStore("/tmp/unused.json", { now: () => 0 })
    store.pushPlayerHold("111", item(0, "ada"))
    store.pushPlayerHold("222", item(0, "bao"))
    expect(store.takePlayerHolds("111").map((row) => row.text)).toEqual(["ada"])
    expect(store.takePlayerHolds("111")).toEqual([])
    store.pushPrivate("adm", { ...item(0, "k"), scope: "admin", late: false, target: "adm" })
    expect(store.takePrivate("adm", 1)[0]?.text).toBe("k")
    expect(store.takePrivate("adm", 1)).toEqual([])
  })

  test("items older than 24h are dropped", () => {
    let now = 0
    const store = new DeferredStore("/tmp/unused.json", { now: () => now })
    store.pushGroup(item(0, "old"))
    now = 24 * 60 * 60 * 1000 + 1
    store.expire()
    expect(store.length).toBe(0)
  })
})
