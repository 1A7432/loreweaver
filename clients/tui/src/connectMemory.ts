import { chmod, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { resolveConnectMemoryPath } from "./localPaths"

// One remembered connection: a server address (ws:// URL or Iroh ticket) + its invite key.
export interface SavedServer {
  host: string
  key: string
  name?: string
}

export interface ConnectMemory {
  host?: string
  key?: string
  name?: string
  locale?: "en" | "zh"
  localServerHome?: string
  // Past successful connections, most-recent first — the connect screen offers them to pick.
  servers?: SavedServer[]
}

const MAX_SERVERS = 8

function cleanLocale(value: unknown): "en" | "zh" | undefined {
  return value === "en" || value === "zh" ? value : undefined
}

const MEMORY_PATH = resolveConnectMemoryPath()

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cleanServers(value: unknown): SavedServer[] {
  if (!Array.isArray(value)) return []
  const out: SavedServer[] = []
  for (const entry of value) {
    const host = clean((entry as SavedServer)?.host)
    const key = clean((entry as SavedServer)?.key)
    if (!host || !key) continue
    const name = clean((entry as SavedServer)?.name)
    out.push(name ? { host, key, name } : { host, key })
    if (out.length >= MAX_SERVERS) break
  }
  return out
}

// Float `entry` to the top of the saved list, de-duplicated by host+key (a repeat connection
// moves up rather than piling up), capped at MAX_SERVERS. Pure — returns a fresh list.
export function rememberServer(servers: SavedServer[] | undefined, entry: SavedServer): SavedServer[] {
  const rest = (servers ?? []).filter((s) => !(s.host === entry.host && s.key === entry.key))
  return [entry, ...rest].slice(0, MAX_SERVERS)
}

// Remove the matching host+key entry (the connect screen's per-row delete). Pure — returns a
// fresh list; a no-match input is returned unchanged (as a new array, still no-op for equality
// purposes since callers only care about contents).
export function forgetServer(servers: SavedServer[] | undefined, entry: SavedServer): SavedServer[] {
  return (servers ?? []).filter((s) => !(s.host === entry.host && s.key === entry.key))
}

export async function loadConnectMemory(path = MEMORY_PATH): Promise<ConnectMemory> {
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return {
      host: clean((parsed as ConnectMemory).host),
      key: clean((parsed as ConnectMemory).key),
      name: clean((parsed as ConnectMemory).name),
      locale: cleanLocale((parsed as ConnectMemory).locale),
      localServerHome: clean((parsed as ConnectMemory).localServerHome),
      servers: cleanServers((parsed as ConnectMemory).servers),
    }
  } catch {
    return {}
  }
}

export async function saveConnectMemory(memory: ConnectMemory, path = MEMORY_PATH): Promise<void> {
  const data: ConnectMemory = {
    host: clean(memory.host),
    key: clean(memory.key),
    name: clean(memory.name),
    locale: cleanLocale(memory.locale),
    localServerHome: clean(memory.localServerHome),
    servers: cleanServers(memory.servers),
  }
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`)
  // The invite key is a bearer secret; keep the file owner-only so it isn't world/group
  // readable on a shared machine. Best-effort — a no-op on platforms without POSIX modes.
  try {
    await chmod(path, 0o600)
  } catch {
    // ignore — non-POSIX filesystem / platform
  }
}
