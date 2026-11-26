// The words for the byte channel's outcomes, and whether this member may upload at all. A refusal
// the server worded is shown as it came (already in this member's language, control-stripped);
// a failure on this side of the line is worded here, in both languages.
import { builtInView, stripControlChars, type SessionSnapshot } from "loreweaver-protocol/v3"
import { tt, type MessageKey } from "./i18n"
import { ByteError } from "./irohLink"
import { LocalFileError, type LocalFileCode } from "./media"

const FILE_KEYS: Record<LocalFileCode, MessageKey> = {
  empty_path: "file.error.emptyPath",
  not_found: "file.error.notFound",
  is_directory: "file.error.isDirectory",
  not_a_file: "file.error.notAFile",
  too_large: "file.error.tooLarge",
  empty: "file.error.empty",
  bad_type: "file.error.badType",
  unreadable: "file.error.unreadable",
}

const BYTE_KEYS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ["not_connected", "log.notConnected"],
  ["upload_busy", "transfer.error.busy"],
  ["too_large", "transfer.error.tooLarge"],
  ["too_much", "transfer.error.tooMuch"],
  ["hash_mismatch", "transfer.error.hashMismatch"],
  ["stalled", "transfer.error.stalled"],
  ["stream_ended", "transfer.error.streamEnded"],
])

/** What a person reads for a failed fetch, upload or file read. */
export function transferErrorText(error: unknown, locale: string | undefined, mb: number = 8): string {
  if (error instanceof LocalFileError) return tt(locale, FILE_KEYS[error.code], { path: error.path, mb })
  if (error instanceof ByteError) {
    if (error.server && error.message) return stripControlChars(error.message)
    const key = BYTE_KEYS.get(error.code)
    return key ? tt(locale, key) : tt(locale, "transfer.error.generic", { code: error.code })
  }
  return tt(locale, "transfer.error.generic", { code: error instanceof Error ? error.message : String(error) })
}

/** A failed fetch as the connection keeps it: the server's words, or ours for its code. */
export function fetchFailureText(failure: { code: string; message: string }, locale: string | undefined): string {
  return transferErrorText(new ByteError(failure.code, failure.message, failure.message !== ""), locale)
}

/**
 * Why this member may not upload now, or null when nothing on this side says so: an observer
 * never uploads; nobody does while the `room` view says the admin turned uploads off. (The
 * server decides in the end; this only keeps a form from offering what it would refuse.)
 */
export function uploadBlocked(snapshot: SessionSnapshot): MessageKey | null {
  const role = builtInView(snapshot, "me")?.data.member.role ?? snapshot.welcome?.you.role
  if (role === "observer") return "upload.blocked.observer"
  if (builtInView(snapshot, "room")?.data.uploads === false) return "upload.blocked.off"
  return null
}

/** "12%": how far an upload has got. */
export function percent(sent: number, size: number): number {
  return size <= 0 ? 100 : Math.min(100, Math.floor((sent / size) * 100))
}
