import { homedir } from "node:os"
import { join } from "node:path"

export interface EnvLike {
  HOME?: string
  USERPROFILE?: string
  TRPG_HOME?: string
  TRPG_LOCAL_SERVER_HOME?: string
}

export interface LocalServerPaths {
  home: string
  serverDir: string
  binaryDir: string
  dataDir: string
  envFile: string
  keysFile: string
  keeperSidecar: string
  sourceArchive: string
  uvInstallScript: string
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
    serverDir: join(root, "server"),
    binaryDir: join(root, "server-bin"),
    dataDir: join(root, "data"),
    envFile: join(root, ".env"),
    keysFile: join(root, "local-keys.toml"),
    keeperSidecar: join(root, "keeper-key.txt"),
    sourceArchive: join(root, "server-src.tar.gz"),
    uvInstallScript: join(root, "uv-install.sh"),
  }
}
