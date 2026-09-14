import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export const PRIVATE_FILE_MODE = 0o600

/** Write JSON (or any UTF-8 body) via `<path>.tmp` then `rename`, mode 0600. */
export async function writePrivateAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, body, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
  await chmod(tmp, PRIVATE_FILE_MODE)
  await rename(tmp, path)
  await chmod(path, PRIVATE_FILE_MODE)
}

/**
 * Read JSON. Missing file → `undefined`. Parse/read failure → rename to
 * `<path>.corrupt-<timestamp>` and return `undefined` so a restart can continue.
 */
export async function readPrivateJson(path: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return undefined
    await quarantine(path)
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    await quarantine(path)
    return undefined
  }
}

async function quarantine(path: string): Promise<void> {
  try {
    await rename(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    // already gone, or the filesystem refused — treat as empty either way
  }
}
