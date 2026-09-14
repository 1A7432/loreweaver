import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { readdir, writeFile } from "node:fs/promises"
import { PostedIds } from "./postedIds"

describe("postedIds", () => {
  test("persists narrative ids and honours them after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-posted-"))
    const path = join(dir, "123.posted.json")
    const first = await PostedIds.load(path)
    await first.add("n1")
    expect(first.has("n1")).toBe(true)

    const second = await PostedIds.load(path)
    expect(second.has("n1")).toBe(true)
    expect(second.has("n-missing")).toBe(false)

    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test("a truncated file is quarantined and load treats it as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-posted-"))
    const path = join(dir, "g.posted.json")
    await writeFile(path, "[\"n1\", tru")
    const store = await PostedIds.load(path)
    expect(store.has("n1")).toBe(false)
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith("g.posted.json.corrupt-"))).toBe(true)
  })

  test("caps the set by dropping the oldest ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-posted-"))
    const store = await PostedIds.load(join(dir, "g.posted.json"), 3)
    await store.add("a")
    await store.add("b")
    await store.add("c")
    await store.add("d")
    expect(store.has("a")).toBe(false)
    expect(store.has("d")).toBe(true)
  })
})
