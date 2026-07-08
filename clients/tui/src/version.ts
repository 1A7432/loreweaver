import { readFileSync } from "node:fs"

const FALLBACK_CLIENT_VERSION = "0.5.0"
type Env = Record<string, string | undefined>

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : FALLBACK_CLIENT_VERSION
  } catch {
    return FALLBACK_CLIENT_VERSION
  }
}

function releaseVersionFile(): string | undefined {
  try {
    const raw = readFileSync(new URL("../../release-version.json", import.meta.url), "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : undefined
  } catch {
    return undefined
  }
}

export function resolveClientVersion(env: Env = process.env): string {
  return clean(env.TRPG_CLIENT_VERSION) ?? clean(env.TRPG_RELEASE_VERSION) ?? releaseVersionFile() ?? packageVersion()
}

export function clientInfo(env: Env = process.env): { name: string; version: string } {
  return { name: "loreweaver-tui", version: resolveClientVersion(env) }
}
