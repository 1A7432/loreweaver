/** A room save as a file: `save {op: "export"}` answers with the whole room (a bundle) in the
 * result's `data`; it is written under `~/.loreweaver/saves` so an admin can restore it later
 * (`save {op: "import"}`, the restore screen).
 *
 * A bundle holds every secret of the room, so it is handled as a secret here: the file is
 * private to this user (mode 0600, in a 0700 folder), and the bundle is never put in a local
 * line, the transcript or any output — only the path is told. The only copies are the file and
 * the memory of the call that carries it.
 *
 * The protocol document calls the bundle opaque (docs/protocol.md §6.7): this client does not
 * read its inside. It recognises a bundle by its own `format` marker only where a typed `.save`
 * has to be told from any other command's answer; everything else about its shape is the
 * server's to judge when it is sent back.
 */

import { mkdir, open, unlink } from "node:fs/promises"
import { join } from "node:path"
import { stripControlChars, type Result } from "loreweaver-protocol/v3"
import type { Connection } from "./connection"
import { tt } from "./i18n"
import { MAX_LINE_BYTES } from "./irohLink"
import { defaultLoreweaverHome, type EnvLike } from "./localPaths"
import { safeFileStem } from "./report"
import { transcriptStamp } from "./transcript"

/** The marker a bundle carries (server/src/infra/lifecycle/bundle.ts); only used to spot a `.save` answer. */
export const BUNDLE_FORMAT = "loreweaver-room"

/**
 * The largest save this client takes in or sends: one frame carries the whole bundle, and the
 * largest line this client accepts from a server is `MAX_LINE_BYTES`. A save written here came
 * in as such a line, so it is never over this. docs/protocol.md §12.4 lists no frame limit and
 * the server's line reader enforces none, so this is the client's own, and the only one there is.
 */
export const MAX_SAVE_BYTES = MAX_LINE_BYTES
/** The limit in the unit a person reads. */
export const SAVE_LIMIT_MB = Math.round(MAX_SAVE_BYTES / (1024 * 1024))

/** Directory saves land in: `~/.loreweaver/saves` (honours `TRPG_HOME`). */
export function resolveSaveDir(env: EnvLike = process.env): string {
  return join(defaultLoreweaverHome(env), "saves")
}

/** `<room>-<YYYYMMDD-HHMMSS>.json`; `attempt` > 1 adds `-N` when the second's name is taken. */
export function saveFileName(room: string | undefined, at: Date, attempt = 1): string {
  const stem = safeFileStem(room ?? "") || "room"
  return `${stem}-${transcriptStamp(at)}${attempt > 1 ? `-${attempt}` : ""}.json`
}

/** "512 B", "12.3 KB", "4.5 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The bundle a `save` export answered with, or null when the answer carries none. */
export function exportedBundle(result: Result | null): Record<string, unknown> | null {
  if (result === null || !result.ok) return null
  return isPlainObject(result.data) ? result.data : null
}

/** The bundle in a result that is a save's answer; null for any other command's answer. */
export function savedBundle(result: Result | null): Record<string, unknown> | null {
  const bundle = exportedBundle(result)
  return bundle !== null && bundle.format === BUNDLE_FORMAT ? bundle : null
}

export interface WriteSaveOptions {
  readonly room?: string
  readonly at?: Date
  readonly dir?: string
  readonly env?: EnvLike
}

/**
 * Write the bundle as JSON, private to this user, under a name that never replaces an earlier
 * save. A write that fails part-way leaves no half file behind. Resolves with the path.
 */
export async function writeSave(bundle: unknown, options: WriteSaveOptions = {}): Promise<{ path: string; bytes: number }> {
  const dir = options.dir ?? resolveSaveDir(options.env ?? process.env)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const data = new TextEncoder().encode(JSON.stringify(bundle))
  const at = options.at ?? new Date()
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const path = join(dir, saveFileName(options.room, at, attempt))
    let handle
    try {
      // `wx`: the name is ours alone, or the open fails and the next name is tried.
      handle = await open(path, "wx", 0o600)
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") continue
      throw error
    }
    try {
      await handle.writeFile(data)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(path).catch(() => undefined)
      throw error
    }
    await handle.close()
    return { path, bytes: data.length }
  }
  throw new Error("too many saves of this room in one second")
}

export type SaveOutcome =
  | { readonly ok: true; readonly path: string; readonly bytes: number; readonly text: string }
  | { readonly ok: false; readonly text: string }

export interface SaveOptions {
  readonly locale: string
  readonly dir?: string
  readonly at?: Date
}

async function keep(bundle: Record<string, unknown>, connection: Connection, options: SaveOptions): Promise<SaveOutcome> {
  const room = connection.session.getSnapshot().welcome?.room.id
  try {
    const written = await writeSave(bundle, { ...(room === undefined ? {} : { room }), ...(options.at ? { at: options.at } : {}), ...(options.dir ? { dir: options.dir } : {}) })
    return { ok: true, ...written, text: tt(options.locale, "save.saved", { path: written.path, size: sizeLabel(written.bytes) }) }
  } catch (error) {
    return { ok: false, text: tt(options.locale, "save.failed", { error: error instanceof Error ? error.message : String(error) }) }
  }
}

/**
 * Save the room to a file: `save {op: "export"}`, run quietly (nothing of the answer goes to the
 * local lines), the bundle written to disk. The outcome's `text` is what to tell the admin: the
 * path, or why not — the server's own words for a refusal.
 */
export async function saveRoom(connection: Connection, options: SaveOptions): Promise<SaveOutcome> {
  const result = await connection.runCommand("save", { op: "export" }, { quiet: true })
  // No answer: the link went down under the request. A room larger than one frame this client
  // can receive does exactly that, so the words name it.
  if (result === null) return { ok: false, text: tt(options.locale, "save.noAnswer", { mb: SAVE_LIMIT_MB }) }
  if (!result.ok) return { ok: false, text: stripControlChars(result.error.message) }
  const bundle = exportedBundle(result)
  if (bundle === null) return { ok: false, text: tt(options.locale, "save.badAnswer") }
  return keep(bundle, connection, options)
}

/**
 * A typed `.save` (or any command that ends up as one) answered with the bundle in its result:
 * keep it as a file. Null when the result is not a save's answer, so the caller does nothing.
 */
export async function keepSavedResult(connection: Connection, result: Result | null, options: SaveOptions): Promise<SaveOutcome | null> {
  const bundle = savedBundle(result)
  return bundle === null ? null : keep(bundle, connection, options)
}

export type ParsedSave = { readonly ok: true; readonly bundle: Record<string, unknown> } | { readonly ok: false; readonly code: "not_json" | "not_object" }

/** A save file's bytes as a bundle: UTF-8 JSON, and an object. Whatever else is wrong is the server's to say. */
export function parseSaveFile(bytes: Uint8Array): ParsedSave {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return { ok: false, code: "not_json" }
  }
  return isPlainObject(value) ? { ok: true, bundle: value } : { ok: false, code: "not_object" }
}
