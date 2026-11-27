/** A room save as a file: `save {op: "export"}` stores the whole room on the server as a file
 * only admins can fetch and answers with its reference (docs/protocol.md §6.7); this client
 * fetches it over the byte channel and writes it under `~/.loreweaver/saves`, so an admin can
 * restore it later (the restore screen uploads it with `purpose: "save"` and runs
 * `save {op: "import", file}`).
 *
 * A save holds every secret of the room, so it is handled as a secret here: it is fetched
 * around the media cache (which is not private), the file is private to this user (mode 0600,
 * in a 0700 folder), and its content is never put in a local line, the transcript or any
 * output — only the path is told.
 *
 * The protocol document calls the bundle opaque: this client never reads its inside. The file
 * travels as bytes, checked against the hash the server named; what it holds is the server's
 * to judge when it is sent back.
 */

import { mkdir, open, unlink } from "node:fs/promises"
import { join } from "node:path"
import { isContentHash, stripControlChars, type Result } from "loreweaver-protocol/v3"
import type { Connection } from "./connection"
import { tt } from "./i18n"
import { defaultLoreweaverHome, type EnvLike } from "./localPaths"
import { safeFileStem } from "./report"
import { transcriptStamp } from "./transcript"
import { transferErrorText } from "./transfer"

/** The type a save travels as, both ways. */
export const SAVE_MIME = "application/json"

/**
 * The largest save this client fetches or sends: the server's default limit for one save file
 * (`MAX_SAVE_FILE_BYTES`). The protocol package does not state it, so it is kept here — a server
 * configured lower still refuses with its own coded answer.
 */
export const MAX_SAVE_BYTES = 256 * 1024 * 1024
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

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** The file a `save` export answered with: `data {documents, events, media}`. */
export interface SaveOffer {
  readonly hash: string
  readonly size: number
  readonly name: string
}

/** The save file a result names, or null when the result is not a save export's answer. */
export function savedFile(result: Result | null): SaveOffer | null {
  if (result === null || !result.ok || !isPlainObject(result.data)) return null
  const { documents, events, media } = result.data
  if (!isCount(documents) || !isCount(events) || !isPlainObject(media)) return null
  if (media.mime !== SAVE_MIME || !isContentHash(media.hash) || !isCount(media.size)) return null
  return { hash: media.hash, size: media.size, name: typeof media.name === "string" ? media.name : "" }
}

/**
 * Whether bytes start the way a save does: one JSON object (an optional byte-order mark and
 * whitespace, then `{`). The server judges the rest; this only keeps a picture or a list from
 * being sent as a room.
 */
export function looksLikeSave(bytes: Uint8Array): boolean {
  let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at += 1
  return bytes[at] === 0x7b
}

export interface WriteSaveOptions {
  readonly room?: string
  readonly at?: Date
  readonly dir?: string
  readonly env?: EnvLike
}

/**
 * Write the save's bytes, private to this user, under a name that never replaces an earlier
 * save. A write that fails part-way leaves no half file behind. Resolves with the path.
 */
export async function writeSave(data: Uint8Array, options: WriteSaveOptions = {}): Promise<{ path: string; bytes: number }> {
  const dir = options.dir ?? resolveSaveDir(options.env ?? process.env)
  await mkdir(dir, { recursive: true, mode: 0o700 })
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

/** Fetch the file a save export named — checked against its hash and size — and write it. */
async function keep(offer: SaveOffer, connection: Connection, options: SaveOptions): Promise<SaveOutcome> {
  if (offer.size > MAX_SAVE_BYTES) return { ok: false, text: tt(options.locale, "save.tooLarge", { mb: SAVE_LIMIT_MB }) }
  let bytes: Uint8Array
  try {
    // The byte channel checks the bytes against the hash; the size is the answer's own word.
    const fetched = await connection.fetchPrivate(offer.hash, MAX_SAVE_BYTES)
    if (fetched.bytes.length !== offer.size) return { ok: false, text: tt(options.locale, "save.badAnswer") }
    bytes = fetched.bytes
  } catch (error) {
    return { ok: false, text: tt(options.locale, "save.fetchFailed", { error: transferErrorText(error, options.locale, SAVE_LIMIT_MB) }) }
  }
  const room = connection.session.getSnapshot().welcome?.room.id
  try {
    const written = await writeSave(bytes, { ...(room === undefined ? {} : { room }), ...(options.at ? { at: options.at } : {}), ...(options.dir ? { dir: options.dir } : {}) })
    return { ok: true, ...written, text: tt(options.locale, "save.saved", { path: written.path, size: sizeLabel(written.bytes) }) }
  } catch (error) {
    return { ok: false, text: tt(options.locale, "save.failed", { error: error instanceof Error ? error.message : String(error) }) }
  }
}

/**
 * Save the room to a file: `save {op: "export"}`, run quietly (nothing of the answer goes to the
 * local lines), then the file it names fetched over the byte channel and written to disk. The
 * outcome's `text` is what to tell the admin: the path, or why not — the server's own words for
 * a refusal.
 */
export async function saveRoom(connection: Connection, options: SaveOptions): Promise<SaveOutcome> {
  const result = await connection.runCommand("save", { op: "export" }, { quiet: true })
  if (result === null) return { ok: false, text: tt(options.locale, "save.noAnswer") }
  if (!result.ok) return { ok: false, text: stripControlChars(result.error.message) }
  const offer = savedFile(result)
  if (offer === null) return { ok: false, text: tt(options.locale, "save.badAnswer") }
  return keep(offer, connection, options)
}

/**
 * A typed `.save` (or any command that ends up as one) answered with a save file: fetch it and
 * keep it, as a report page is. Null when the result is not a save's answer, so the caller does
 * nothing.
 */
export async function keepSavedResult(connection: Connection, result: Result | null, options: SaveOptions): Promise<SaveOutcome | null> {
  const offer = savedFile(result)
  return offer === null ? null : keep(offer, connection, options)
}
