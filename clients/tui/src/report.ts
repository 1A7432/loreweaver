/** Receiving a session report (protocol 2.4 `report` frame).
 *
 * The server announces a generated HTML report to the ONE connection that asked for it
 * (`.report html` / `.report html reveal`); the bytes ride the ordinary media GET. This
 * module fetches them, verifies the sha256 against the announced hash, and saves the file
 * where a person will find it. It never renders the page: the protocol forbids a client
 * from displaying report HTML inside its own UI — the system browser is the sandbox the
 * page was written for, and the player opens the saved file there.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripControlChars, type MediaPayload, type ReportFrame } from "loreweaver-protocol"
import { defaultLoreweaverHome, defaultUserHome, type EnvLike } from "./localPaths"
import { sha256Hex } from "./media"

export interface ReportClient {
  getMedia(hash: string): Promise<MediaPayload>
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Where reports land: `~/Downloads/loreweaver` when the user has a Downloads folder,
 * else `~/.loreweaver/reports` (honours `TRPG_HOME`). */
export function resolveReportDir(env: EnvLike = process.env, dirExists: (path: string) => boolean = isDirectory): string {
  const downloads = join(defaultUserHome(env), "Downloads")
  if (dirExists(downloads)) return join(downloads, "loreweaver")
  return join(defaultLoreweaverHome(env), "reports")
}

/** The server-suggested name reduced to a safe base file name ending in `.html`.
 *
 * `name` is untrusted: path separators, `..`, control characters and the characters
 * Windows forbids are all removed, and an unusable result falls back to the hash. */
export function safeReportName(name: string, hash: string): string {
  const base = stripControlChars(String(name ?? ""))
    .split(/[\\/]/)
    .pop()!
    .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120)
  const stem = base.replace(/\.html?$/i, "").replace(/[. ]+$/, "")
  if (!stem) return `loreweaver-report-${hash.slice(0, 12)}.html`
  return `${stem}.html`
}

function uniquePath(dir: string, fileName: string, exists: (path: string) => boolean): string {
  let candidate = join(dir, fileName)
  const stem = fileName.replace(/\.html$/i, "")
  for (let index = 1; exists(candidate) && index < 1000; index++) {
    candidate = join(dir, `${stem}-${index}.html`)
  }
  return candidate
}

/** Fetch, verify and save one announced report; resolves to the saved path.
 *
 * Throws when the fetch fails (a `reveal` hash fetched by a non-keeper connection is
 * `media_not_found`, like any unknown hash), when the bytes do not match the announced
 * sha256, or when the file cannot be written. The file is owner-only: a reveal edition
 * is a spoiler, and a player edition is that player's own keepsake. */
export async function saveReport(
  client: ReportClient,
  frame: ReportFrame,
  options: { dir?: string; env?: EnvLike } = {},
): Promise<string> {
  const payload = await client.getMedia(frame.hash)
  if (sha256Hex(payload.bytes) !== frame.hash) throw new Error("report checksum mismatch")
  const dir = options.dir ?? resolveReportDir(options.env)
  await mkdir(dir, { recursive: true })
  const path = uniquePath(dir, safeReportName(frame.name, frame.hash), existsSync)
  await writeFile(path, payload.bytes, { mode: 0o600 })
  return path
}
