import { homedir } from "node:os"
import { join } from "node:path"

export interface EnvLike {
  HOME?: string
  USERPROFILE?: string
  TRPG_HOME?: string
  TRPG_LOCAL_SERVER_HOME?: string
}

export interface LocalServerPaths {
  /** The local server's folder. */
  home: string
  /** Where a prebuilt server binary is looked for. */
  binary: string
  /** The server's data directory (`TRPG_DATA_DIR`): database, keys, transport identity. */
  dataDir: string
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function defaultUserHome(env: EnvLike = process.env): string {
  const resolved = clean(env.HOME) ?? clean(env.USERPROFILE) ?? homedir()
  return resolved || "."
}

export function expandHome(path: string, env: EnvLike = process.env): string {
  if (path === "~") return defaultUserHome(env)
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(defaultUserHome(env), path.slice(2))
  return path
}

export function defaultLoreweaverHome(env: EnvLike = process.env): string {
  return expandHome(clean(env.TRPG_HOME) ?? join(defaultUserHome(env), ".loreweaver"), env)
}

export function defaultLocalServerHome(env: EnvLike = process.env): string {
  return expandHome(clean(env.TRPG_LOCAL_SERVER_HOME) ?? defaultLoreweaverHome(env), env)
}

export function resolveConnectMemoryPath(env: EnvLike = process.env): string {
  return join(defaultLoreweaverHome(env), "tui-connect.json")
}

export function resolveLocalServerPaths(home?: string, env: EnvLike = process.env): LocalServerPaths {
  const root = expandHome(clean(home) ?? defaultLocalServerHome(env), env)
  return {
    home: root,
    binary: join(root, "server-bin", process.platform === "win32" ? "loreweaver.exe" : "loreweaver"),
    dataDir: join(root, "data"),
  }
}
