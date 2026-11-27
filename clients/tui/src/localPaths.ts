import { homedir } from "node:os"
import { join } from "node:path"

export interface EnvLike {
  // `process.env` itself must fit: without this, an all-optional interface is a "weak type" that
  // an environment naming none of these keys is refused for.
  readonly [name: string]: string | undefined
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

/**
 * The local server's folder inside the client's home. Its own folder, not the home itself:
 * Loreweaver 2 hosted its server straight from `~/.loreweaver` (its database is
 * `~/.loreweaver/data/loreweaver.db`), and a 3.x server neither reads that database nor
 * writes beside it. A machine that hosted with 2 keeps that table where it was.
 */
export const LOCAL_SERVER_FOLDER = "v3"

export function defaultLocalServerHome(env: EnvLike = process.env): string {
  return expandHome(clean(env.TRPG_LOCAL_SERVER_HOME) ?? join(defaultLoreweaverHome(env), LOCAL_SERVER_FOLDER), env)
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
