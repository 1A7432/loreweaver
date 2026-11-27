/** The session report as a page: a `report` result names a file; fetch it and keep it.
 *
 * The server answers `report html` with a reference — `{hash, mime, size, name}` — not with
 * the page (docs/protocol.md §6.8). The page is replaced by the next one of its edition, so
 * it is fetched as soon as it is offered and written under `~/.loreweaver/reports`.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stripControlChars, type Result } from "loreweaver-protocol/v3"
import { defaultLoreweaverHome, type EnvLike } from "./localPaths"

export interface ReportOffer {
  readonly hash: string
  readonly name: string
}

/** Directory report pages land in: `~/.loreweaver/reports` (honours `TRPG_HOME`). */
export function resolveReportDir(env: EnvLike = process.env): string {
  return join(defaultLoreweaverHome(env), "reports")
}

/** The page a result offers, or null when it is not a report page. */
export function reportOffer(result: Result | null): ReportOffer | null {
  if (result === null || !result.ok) return null
  const data = result.data as { format?: unknown; media?: { hash?: unknown; mime?: unknown; name?: unknown } } | null | undefined
  if (typeof data !== "object" || data === null || data.format !== "html") return null
  const media = data.media
  if (typeof media !== "object" || media === null || media.mime !== "text/html") return null
  if (typeof media.hash !== "string" || !/^[0-9a-f]{64}$/.test(media.hash)) return null
  return { hash: media.hash, name: typeof media.name === "string" ? media.name : "" }
}

/** A name from the server made safe to be (part of) a file name here: no path, no control characters. */
export function safeFileStem(name: string): string {
  return stripControlChars(name)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120)
}

/** A file name from the server made safe to write here: no path, no control characters, `.html`. */
export function reportFileName(offer: ReportOffer): string {
  const base = safeFileStem(offer.name)
  const named = base === "" ? `report-${offer.hash.slice(0, 12)}` : base
  return /\.html?$/i.test(named) ? named : `${named}.html`
}

/** Write the page's bytes; resolves with the path written. */
export async function saveReport(offer: ReportOffer, bytes: Uint8Array, dir: string = resolveReportDir()): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, reportFileName(offer))
  await writeFile(path, bytes)
  return path
}
