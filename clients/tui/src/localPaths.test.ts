import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  defaultLocalServerHome,
  defaultLoreweaverHome,
  expandHome,
  resolveConnectMemoryPath,
  resolveLocalServerPaths,
  type EnvLike,
} from "./localPaths"

const ENV: EnvLike = { HOME: "/home/ada", USERPROFILE: "/users/ignored" }

describe("local path resolution", () => {
  test("defaults client and local server state under the user's .loreweaver directory", () => {
    expect(defaultLoreweaverHome(ENV)).toBe(join("/home/ada", ".loreweaver"))
    expect(defaultLocalServerHome(ENV)).toBe(join("/home/ada", ".loreweaver"))
    expect(resolveConnectMemoryPath(ENV)).toBe(join("/home/ada", ".loreweaver", "tui-connect.json"))
  })

  test("TRPG_HOME moves the client home and also the local server home by default", () => {
    const env = { ...ENV, TRPG_HOME: "/mnt/loreweaver" }
    expect(defaultLoreweaverHome(env)).toBe("/mnt/loreweaver")
    expect(defaultLocalServerHome(env)).toBe("/mnt/loreweaver")
  })

  test("TRPG_LOCAL_SERVER_HOME overrides only the one-click server install/state root", () => {
    const env = { ...ENV, TRPG_HOME: "/mnt/client", TRPG_LOCAL_SERVER_HOME: "/srv/loreweaver-local" }
    expect(defaultLoreweaverHome(env)).toBe("/mnt/client")
    expect(defaultLocalServerHome(env)).toBe("/srv/loreweaver-local")
  })

  test("resolveLocalServerPaths lays out all server-side state under the chosen root", () => {
    const paths = resolveLocalServerPaths("~/server-state", ENV)
    expect(paths.home).toBe(join("/home/ada", "server-state"))
    expect(paths.serverDir).toBe(join(paths.home, "server"))
    expect(paths.binaryDir).toBe(join(paths.home, "server-bin"))
    expect(paths.dataDir).toBe(join(paths.home, "data"))
    expect(paths.envFile).toBe(join(paths.home, ".env"))
    expect(paths.keysFile).toBe(join(paths.home, "local-keys.toml"))
    expect(paths.keeperSidecar).toBe(join(paths.home, "keeper-key.txt"))
  })

  test("expandHome handles bare and prefixed tilde paths", () => {
    expect(expandHome("~", ENV)).toBe("/home/ada")
    expect(expandHome("~/lw", ENV)).toBe(join("/home/ada", "lw"))
    expect(expandHome("/already/absolute", ENV)).toBe("/already/absolute")
  })
})
