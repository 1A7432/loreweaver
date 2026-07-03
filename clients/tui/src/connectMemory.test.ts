import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadConnectMemory, rememberServer, saveConnectMemory } from "./connectMemory"

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
      servers: [],
    })
  })

  test("saves and loads the servers list, dropping entries missing host or key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-tui-"))
    const path = join(dir, "connect.json")
    await saveConnectMemory(
      {
        servers: [
          { host: "endpointaaa…", key: "k1", name: "Home" },
          { host: "", key: "k2" } as never, // no host -> dropped
          { host: "ws://h", key: "k3" },
        ],
      },
      path,
    )
    const loaded = await loadConnectMemory(path)
    expect(loaded.servers).toEqual([
      { host: "endpointaaa…", key: "k1", name: "Home" },
      { host: "ws://h", key: "k3" },
    ])
  })

  test("rememberServer floats a repeat to the top, dedupes by host+key, caps at 8", () => {
    let servers = rememberServer(undefined, { host: "a", key: "1", name: "A" })
    servers = rememberServer(servers, { host: "b", key: "2" })
    servers = rememberServer(servers, { host: "a", key: "1", name: "A2" }) // same host+key -> updated + to top
    expect(servers).toEqual([
      { host: "a", key: "1", name: "A2" },
      { host: "b", key: "2" },
    ])

    let many: ReturnType<typeof rememberServer> | undefined
    for (let i = 0; i < 12; i++) many = rememberServer(many, { host: `h${i}`, key: `k${i}` })
    expect(many?.length).toBe(8)
    expect(many?.[0]).toEqual({ host: "h11", key: "k11" })
  })
})
