import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadConnectMemory, saveConnectMemory } from "./connectMemory"

describe("connectMemory", () => {
  test("missing or malformed memory returns empty defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-tui-"))
    expect(await loadConnectMemory(join(dir, "missing.json"))).toEqual({})
  })

  test("saves and loads the last successful connection fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-tui-"))
    const path = join(dir, "nested", "connect.json")

    await saveConnectMemory({ host: " ws://127.0.0.1:8787 ", key: " keeper-key ", name: " 漱雪 " }, path)

    expect(await loadConnectMemory(path)).toEqual({
      host: "ws://127.0.0.1:8787",
      key: "keeper-key",
      name: "漱雪",
    })
  })
})
