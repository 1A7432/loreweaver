// The zip subset a pack uses, read and written on `node:zlib`. This is the security
// boundary of installing a pack: an archive is untrusted bytes from anywhere, so reading
// is strict and bounded, and every refusal is a stable code (with the entry's path when
// there is one).
//
// What is read: stored (method 0) and deflate (method 8) entries of a single-disk archive
// with a classic end-of-central-directory record. Zip64, encryption, multi-disk archives,
// other methods and symbolic links are refused. Sizes are enforced WHILE inflating — the
// inflater is given the declared size as its hard output ceiling, and an entry that
// produces more or less than it declared is refused — so a header that lies about its
// size cannot make the reader allocate past the caps. Entries may not overlap (the
// "overlapping files" zip bomb), and every CRC is checked.
//
// Reading yields `(path, bytes)` pairs and never touches the filesystem; writing takes the
// same pairs and returns the archive's bytes. A writer that is handed its entries in the
// same order produces the same bytes: every entry is stamped with the zip epoch
// (1980-01-01 00:00) and a regular-file mode, and compressed at one fixed level.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/** The largest archive read, in bytes. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
/** The most entries an archive may hold (directory entries included). */
export const MAX_ENTRIES = 2048;
/** The largest one entry may inflate to. */
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
/** The most all entries together may inflate to. */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** The highest uncompressed:compressed ratio accepted for an entry over `RATIO_FLOOR_BYTES`. */
export const MAX_RATIO = 100;
/** Entries that inflate to less than this are exempt from the ratio rule (a small text compresses well). */
export const RATIO_FLOOR_BYTES = 1024 * 1024;
/** The longest entry path, in code points, and the longest single segment. */
export const MAX_PATH_CHARS = 512;
export const MAX_SEGMENT_CHARS = 255;

export type ZipCode =
  /** Larger than `MAX_ARCHIVE_BYTES`. */
  | "archive_too_large"
  /** No end-of-central-directory record: not a zip archive (or a truncated one). */
  | "not_a_zip"
  /** The archive spans several disks. */
  | "multi_disk"
  /** The archive (or an entry) needs zip64. */
  | "zip64"
  /** A record does not fit inside the archive or does not carry its signature. */
  | "corrupt"
  /** More than `MAX_ENTRIES` entries. */
  | "too_many_entries"
  /** An entry is encrypted. */
  | "encrypted"
  /** An entry uses a compression method other than stored or deflate. */
  | "unsupported_method"
  /** An entry is a symbolic link. */
  | "symlink"
  /** An entry's name breaks the path rules (see `checkEntryPath`). */
  | "bad_path"
  /** Two entries have the same name once normalised (Unicode NFC, case-folded). */
  | "duplicate_path"
  /** An entry's data overlaps another entry's. */
  | "overlapping_entries"
  /** The local header disagrees with the central directory. */
  | "header_mismatch"
  /** An entry is over `MAX_ENTRY_BYTES`. */
  | "entry_too_large"
  /** All entries together are over `MAX_TOTAL_BYTES`. */
  | "total_too_large"
  /** An entry compresses better than `MAX_RATIO` allows. */
  | "ratio_too_high"
  /** An entry inflated to a size other than the one it declared, or does not inflate. */
  | "size_mismatch"
  /** An entry's CRC does not match its bytes. */
  | "crc_mismatch";

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type ZipRead = { readonly ok: true; readonly entries: readonly ZipEntry[] } | { readonly ok: false; readonly code: ZipCode; readonly path?: string; readonly detail?: string };

/** Why a path is unsafe, as a short detail code; null when it is safe. */
export type PathProblem =
  | "empty"
  | "too_long"
  | "segment_too_long"
  | "absolute"
  | "backslash"
  | "control_character"
  | "drive_letter"
  | "colon"
  | "dot_segment"
  | "empty_segment"
  | "trailing_dot_or_space"
  | "reserved_name";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const END_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
/** 1980-01-01 00:00:00 in MS-DOS date and time fields. */
const DOS_DATE_EPOCH = (0 << 9) | (1 << 5) | 1;
const DOS_TIME_EPOCH = 0;
const DEFLATE_LEVEL = 9;
// Windows device names: a file named one of these (with any extension) cannot be created there.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CP437_SAFE = /^[\x20-\x7e]*$/u;

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * Whether `path` is a safe relative path inside an archive or a pack: `/`-separated, not
 * absolute, no `.`/`..`/empty segment, no backslash, no NUL or other control character,
 * no drive letter or other colon, no segment a Windows filesystem would alter (a trailing
 * dot or space) or refuse (a device name), and within the length caps. The same rule
 * guards the names in a manifest and the files an install writes.
 */
export function checkEntryPath(path: string): PathProblem | null {
  if (path === "") return "empty";
  if (codePoints(path) > MAX_PATH_CHARS) return "too_long";
  if (path.includes("\\")) return "backslash";
  if (/[\u0000-\u001f\u007f]/u.test(path)) return "control_character";
  if (path.startsWith("/")) return "absolute";
  const segments = path.split("/");
  if (/^[A-Za-z]:/u.test(segments[0] ?? "")) return "drive_letter";
  if (path.includes(":")) return "colon";
  for (const segment of segments) {
    if (segment === "") return "empty_segment";
    if (segment === "." || segment === "..") return "dot_segment";
    if (segment.trim() === "") return "empty_segment";
    if (codePoints(segment) > MAX_SEGMENT_CHARS) return "segment_too_long";
    if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing_dot_or_space";
    if (RESERVED.test(segment)) return "reserved_name";
  }
  return null;
}

/** The form two names are compared in for duplicates: a case-insensitive filesystem would merge them. */
export function normalisedPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

class Refusal extends Error {
  readonly code: ZipCode;
  readonly path: string | undefined;
  readonly detail: string | undefined;

  constructor(code: ZipCode, path?: string, detail?: string) {
    super(code);
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

interface Central {
  readonly path: string;
  readonly directory: boolean;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

function findEnd(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - END_SIZE - MAX_COMMENT);
  for (let at = view.byteLength - END_SIZE; at >= lowest; at--) {
    if (view.getUint32(at, true) !== SIG_END) continue;
    // The comment length must reach exactly to the end, or this is a stray signature.
    if (at + END_SIZE + view.getUint16(at + 20, true) === view.byteLength) return at;
  }
  return -1;
}

function decodeName(raw: Uint8Array, flags: number): string | null {
  if ((flags & FLAG_UTF8) !== 0) {
    try {
      return UTF8.decode(raw);
    } catch {
      return null;
    }
  }
  // Without the UTF-8 flag a name is CP437: accept the part that reads the same in both.
  const text = String.fromCharCode(...raw);
  return CP437_SAFE.test(text) ? text : null;
}

function readCentral(bytes: Uint8Array, view: DataView): Central[] {
  const end = findEnd(view);
  if (end < 0) throw new Refusal("not_a_zip");
  if (end >= 20 && view.getUint32(end - 20, true) === SIG_ZIP64_LOCATOR) throw new Refusal("zip64");
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const entriesHere = view.getUint16(end + 8, true);
  const entriesTotal = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (entriesTotal === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Refusal("zip64");
  if (disk !== 0 || centralDisk !== 0 || entriesHere !== entriesTotal) throw new Refusal("multi_disk");
  if (entriesTotal > MAX_ENTRIES) throw new Refusal("too_many_entries");
  if (centralOffset + centralSize > end) throw new Refusal("corrupt", undefined, "central_directory_bounds");
  const out: Central[] = [];
  let at = centralOffset;
  for (let index = 0; index < entriesTotal; index++) {
    if (at + CENTRAL_SIZE > centralOffset + centralSize || view.getUint32(at, true) !== SIG_CENTRAL) throw new Refusal("corrupt", undefined, "central_record");
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const startDisk = view.getUint16(at + 34, true);
    const external = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new Refusal("corrupt", undefined, "central_record");
    const name = decodeName(bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength), flags);
    if (name === null) throw new Refusal("bad_path", undefined, "not_utf8");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Refusal("zip64", name);
    if (startDisk !== 0) throw new Refusal("multi_disk", name);
    if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) throw new Refusal("encrypted", name);
    const host = madeBy >>> 8;
    const mode = external >>> 16;
    if (host === HOST_UNIX && (mode & S_IFMT) === S_IFLNK) throw new Refusal("symlink", name);
    const directory = name.endsWith("/");
    const path = directory ? name.slice(0, -1) : name;
    const problem = checkEntryPath(path);
    if (problem !== null) throw new Refusal("bad_path", name, problem);
    if (!directory && method !== METHOD_STORED && method !== METHOD_DEFLATE) throw new Refusal("unsupported_method", name, String(method));
    if (directory && size !== 0) throw new Refusal("corrupt", name, "directory_with_data");
    out.push({ path, directory, method, crc, compressedSize, size, localOffset });
    at = next;
  }
  return out;
}

/** Inflate `data` to exactly `size` bytes, never producing more than that. */
function inflateExactly(data: Uint8Array, size: number, path: string): Uint8Array {
  let out: Uint8Array;
  try {
    // The ceiling is the DECLARED size: a stream that would produce more stops here.
    out = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
  } catch {
    throw new Refusal("size_mismatch", path);
  }
  if (out.length !== size) throw new Refusal("size_mismatch", path);
  return out;
}

/** Read an archive. Strict: the first problem refuses the whole archive. */
export function readZip(bytes: Uint8Array): ZipRead {
  try {
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Refusal("archive_too_large");
    if (bytes.length < END_SIZE) throw new Refusal("not_a_zip");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const central = readCentral(bytes, view);
    const seen = new Set<string>();
    let declaredTotal = 0;
    for (const entry of central) {
      const key = normalisedPath(entry.path);
      if (seen.has(key)) throw new Refusal("duplicate_path", entry.path);
      seen.add(key);
      if (entry.directory) continue;
      if (entry.size > MAX_ENTRY_BYTES) throw new Refusal("entry_too_large", entry.path);
      declaredTotal += entry.size;
      if (declaredTotal > MAX_TOTAL_BYTES) throw new Refusal("total_too_large", entry.path);
    }
    for (const entry of central) {
      if (entry.directory) continue;
      if (entry.size > RATIO_FLOOR_BYTES && entry.size > entry.compressedSize * MAX_RATIO) throw new Refusal("ratio_too_high", entry.path);
      if (entry.method === METHOD_STORED && entry.compressedSize !== entry.size) throw new Refusal("size_mismatch", entry.path);
    }
    // Local records: each inside the archive, in order, none overlapping the next.
    const spans: { start: number; end: number; entry: Central; dataStart: number }[] = [];
    for (const entry of central) {
      const at = entry.localOffset;
      if (at + LOCAL_SIZE > bytes.length || view.getUint32(at, true) !== SIG_LOCAL) throw new Refusal("corrupt", entry.path, "local_header");
      const flags = view.getUint16(at + 6, true);
      const method = view.getUint16(at + 8, true);
      const nameLength = view.getUint16(at + 26, true);
      const extraLength = view.getUint16(at + 28, true);
      const dataStart = at + LOCAL_SIZE + nameLength + extraLength;
      const name = decodeName(bytes.subarray(at + LOCAL_SIZE, at + LOCAL_SIZE + nameLength), flags);
      const expected = entry.directory ? `${entry.path}/` : entry.path;
      if (name !== expected || method !== entry.method || (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) throw new Refusal("header_mismatch", entry.path);
      const end = dataStart + entry.compressedSize;
      if (end > bytes.length) throw new Refusal("corrupt", entry.path, "data_bounds");
      spans.push({ start: at, end, entry, dataStart });
    }
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index++) {
      const before = ordered[index - 1] as (typeof ordered)[number];
      const after = ordered[index] as (typeof ordered)[number];
      if (after.start < before.end) throw new Refusal("overlapping_entries", after.entry.path);
    }
    const entries: ZipEntry[] = [];
    let inflatedTotal = 0;
    for (const { entry, dataStart } of spans) {
      if (entry.directory) continue;
      const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
      const out = entry.method === METHOD_STORED ? data.slice() : inflateExactly(data, entry.size, entry.path);
      inflatedTotal += out.length;
      if (inflatedTotal > MAX_TOTAL_BYTES) throw new Refusal("total_too_large", entry.path);
      if (crc32(out) >>> 0 !== entry.crc >>> 0) throw new Refusal("crc_mismatch", entry.path);
      entries.push({ path: entry.path, bytes: out });
    }
    return { ok: true, entries };
  } catch (error) {
    if (error instanceof Refusal) {
      const refusal: { ok: false; code: ZipCode; path?: string; detail?: string } = { ok: false, code: error.code };
      if (error.path !== undefined) refusal.path = error.path;
      if (error.detail !== undefined) refusal.detail = error.detail;
      return refusal;
    }
    throw error;
  }
}

/**
 * Write an archive of `entries`, in the order given. Throws on a path that breaks the
 * path rules, a repeated path or a size the format cannot hold without zip64: a writer's
 * caller is the engine, and handing it such input is a bug, not content.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error(`zip: more than ${MAX_ENTRIES} entries`);
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    const problem = checkEntryPath(entry.path);
    if (problem !== null) throw new Error(`zip: unsafe path ${JSON.stringify(entry.path)} (${problem})`);
    const key = normalisedPath(entry.path);
    if (seen.has(key)) throw new Error(`zip: repeated path ${JSON.stringify(entry.path)}`);
    seen.add(key);
    const name = encoder.encode(entry.path);
    const deflated = deflateRawSync(entry.bytes, { level: DEFLATE_LEVEL });
    // Stored when deflate does not help: the archive stays as small as it can be.
    const stored = deflated.length >= entry.bytes.length;
    const data = stored ? entry.bytes : deflated;
    const method = stored ? METHOD_STORED : METHOD_DEFLATE;
    const crc = crc32(entry.bytes) >>> 0;
    if (offset > 0xfffffffe || entry.bytes.length > 0xfffffffe) throw new Error("zip: too large without zip64");
    const local = new Uint8Array(LOCAL_SIZE + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME_EPOCH, true);
    lv.setUint16(12, DOS_DATE_EPOCH, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, entry.bytes.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, LOCAL_SIZE);
    const central = new Uint8Array(CENTRAL_SIZE + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, (HOST_UNIX << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME_EPOCH, true);
    cv.setUint16(14, DOS_DATE_EPOCH, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, entry.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((S_IFREG | 0o644) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, CENTRAL_SIZE);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(END_SIZE);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_END, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + END_SIZE);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
