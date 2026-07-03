import { chmod, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export interface ConnectMemory {
  host?: string
  key?: string
  name?: string
  locale?: "en" | "zh"
}

function cleanLocale(value: unknown): "en" | "zh" | undefined {
  return value === "en" || value === "zh" ? value : undefined
}

const MEMORY_PATH = `${process.env.HOME ?? "."}/.loreweaver/tui-connect.json`

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
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
