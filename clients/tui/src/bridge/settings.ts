import type { GroupMode } from "./config"
import { readPrivateJson, writePrivateAtomic } from "./persist"

export function settingsPath(stateDir: string, groupId: string): string {
  return `${stateDir.replace(/\/+$/, "")}/${groupId}.settings.json`
}

export interface GroupRuntimeSettings {
  admins: string[]
  mode: GroupMode
  busyNotice: boolean
}

export async function loadGroupSettings(
  path: string,
  defaults: GroupRuntimeSettings,
): Promise<GroupRuntimeSettings> {
  const parsed = await readPrivateJson(path)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaults, admins: [...defaults.admins] }
  const rec = parsed as Record<string, unknown>
  const admins = Array.isArray(rec.admins)
    ? rec.admins.map((item) => String(item).trim()).filter(Boolean)
    : [...defaults.admins]
  const mode = rec.mode === "all" || rec.mode === "mention" ? rec.mode : defaults.mode
  const busyNotice = typeof rec.busyNotice === "boolean" ? rec.busyNotice : defaults.busyNotice
  return { admins, mode, busyNotice }
}

const writeChains = new Map<string, Promise<void>>()

export async function saveGroupSettings(path: string, settings: GroupRuntimeSettings): Promise<void> {
  const body = JSON.stringify(settings)
  const next = (writeChains.get(path) ?? Promise.resolve()).then(() => writePrivateAtomic(path, body))
  writeChains.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** Wait for every in-flight settings write. Shutdown flushes through this. */
export async function flushSettingsWrites(): Promise<void> {
  await Promise.all([...writeChains.values()])
}
