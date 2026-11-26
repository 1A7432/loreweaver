// Pack files on disk: reading an author's source tree, and the data directory's installed
// packs — `<dataDir>/packs/<id>/<version>/…` and the index that lists them.
//
// Every path that reaches the filesystem passes the archive's path rules again
// (`checkEntryPath`), is joined under its root segment by segment, and must still resolve
// inside that root once symbolic links are followed; a symbolic link is never read or
// written through. Installed files are private to the server's user. An install is staged
// in a sibling directory and renamed into place, so a failure part-way never leaves a half
// pack where a whole one is expected.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { ensurePrivateDir, writePrivateFile } from "../private_files.ts";
import { checkEntryPath, MAX_ENTRIES, MAX_TOTAL_BYTES, type ZipEntry } from "../zip.ts";

/** The directory of installed packs inside the data directory. */
export const PACKS_DIR = "packs";
export const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;
const STAGING_PREFIX = ".staging-";
/** The most packs an index lists. */
export const MAX_INSTALLED_PACKS = 256;

export type FileCode =
  /** A path that breaks the path rules. */
  | "bad_path"
  /** A path that is, or passes through, a symbolic link, or resolves outside its root. */
  | "outside_root"
  | "not_found"
  /** Not a regular file. */
  | "not_a_file"
  | "too_large"
  | "unreadable";

export type FileRead = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly code: FileCode; readonly path: string };

function inside(root: string, path: string): boolean {
  const base = realpathSync(root);
  const resolved = realpathSync(path);
  return resolved === base || resolved.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** `rel` (a `/`-separated relative path) under `root`, or a refusal. Nothing is read. */
export function confinedPath(root: string, rel: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly code: FileCode } {
  if (checkEntryPath(rel) !== null) return { ok: false, code: "bad_path" };
  return { ok: true, path: join(root, ...rel.split("/")) };
}

/** Read one file of a tree: a regular file, no symbolic link on the way, inside `root`, within `maxBytes`. */
export function readConfined(root: string, rel: string, maxBytes: number): FileRead {
  const confined = confinedPath(root, rel);
  if (!confined.ok) return { ok: false, code: confined.code, path: rel };
  let current = root;
  for (const segment of rel.split("/")) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return { ok: false, code: "not_found", path: rel };
    }
    if (stat.isSymbolicLink()) return { ok: false, code: "outside_root", path: rel };
  }
  try {
    if (!inside(root, confined.path)) return { ok: false, code: "outside_root", path: rel };
    const stat = lstatSync(confined.path);
    if (!stat.isFile()) return { ok: false, code: "not_a_file", path: rel };
    if (stat.size > maxBytes) return { ok: false, code: "too_large", path: rel };
    return { ok: true, bytes: new Uint8Array(readFileSync(confined.path)) };
  } catch {
    return { ok: false, code: "unreadable", path: rel };
  }
}

/** Whether `rel` names an existing regular file under `root` (no symbolic links). */
export function hasConfinedFile(root: string, rel: string): boolean {
  const read = confinedPath(root, rel);
  if (!read.ok) return false;
  try {
    const stat = lstatSync(read.path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export interface IndexEntry {
  readonly id: string;
  readonly version: string;
  /** The sha256 of the archive it was installed from. */
  readonly sha256: string;
  readonly installedAt: number;
}

export type IndexRead = { readonly ok: true; readonly entries: readonly IndexEntry[] } | { readonly ok: false; readonly code: "index_unreadable" };

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/u;
const SHA = /^[0-9a-f]{64}$/u;

function isEntry(value: unknown): value is { id: string; version: string; sha256: string; installed_at: number } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    SLUG.test(record.id) &&
    typeof record.version === "string" &&
    VERSION.test(record.version) &&
    typeof record.sha256 === "string" &&
    SHA.test(record.sha256) &&
    typeof record.installed_at === "number" &&
    Number.isSafeInteger(record.installed_at)
  );
}

/** The installed packs of one data directory. */
export class PackDirectory {
  readonly root: string;

  constructor(dataDir: string) {
    // Absolute: these paths are handed to a worker thread and to the module loader, and
    // must mean the same file whatever the process's working directory is by then.
    this.root = resolve(dataDir, PACKS_DIR);
  }

  /** The index, in install order. A missing index is an empty one; a damaged one is a refusal. */
  index(): IndexRead {
    const path = join(this.root, INDEX_FILE);
    if (!existsSync(path)) return { ok: true, entries: [] };
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== INDEX_VERSION) return { ok: false, code: "index_unreadable" };
      const packs = (raw as { packs?: unknown }).packs;
      if (!Array.isArray(packs) || packs.length > MAX_INSTALLED_PACKS || !packs.every(isEntry)) return { ok: false, code: "index_unreadable" };
      const ids = new Set(packs.map((entry) => entry.id));
      if (ids.size !== packs.length) return { ok: false, code: "index_unreadable" };
      return { ok: true, entries: packs.map((entry) => ({ id: entry.id, version: entry.version, sha256: entry.sha256, installedAt: entry.installed_at })) };
    } catch {
      return { ok: false, code: "index_unreadable" };
    }
  }

  #writeIndex(entries: readonly IndexEntry[]): void {
    const packs = entries.map((entry) => ({ id: entry.id, version: entry.version, sha256: entry.sha256, installed_at: entry.installedAt }));
    writePrivateFile(join(this.root, INDEX_FILE), `${JSON.stringify({ version: INDEX_VERSION, packs }, null, 2)}\n`);
  }

  /** Where an installed pack's files are. */
  home(id: string, version: string): string {
    return join(this.root, id, version);
  }

  /**
   * Write a validated pack's files as `<id>/<version>/`, then list it in the index — in its
   * old place when another version of it was installed (that version's files are removed
   * after the index no longer names them), at the end otherwise.
   */
  install(entry: IndexEntry, files: readonly ZipEntry[], entries: readonly IndexEntry[]): void {
    if (!SLUG.test(entry.id) || !VERSION.test(entry.version)) throw new Error("pack directory: bad id or version");
    ensurePrivateDir(this.root);
    const staging = join(this.root, `${STAGING_PREFIX}${crypto.randomUUID()}`);
    ensurePrivateDir(staging);
    try {
      for (const file of files) {
        const confined = confinedPath(staging, file.path);
        if (!confined.ok) throw new Error(`pack directory: unsafe path ${JSON.stringify(file.path)}`);
        const segments = file.path.split("/");
        let dir = staging;
        for (const segment of segments.slice(0, -1)) {
          dir = join(dir, segment);
          if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("pack directory: symbolic link in the staging tree");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        writeFileSync(confined.path, file.bytes, { mode: 0o600, flag: "wx" });
      }
      const target = this.home(entry.id, entry.version);
      ensurePrivateDir(join(this.root, entry.id));
      // A directory left by an install that never reached the index is not a pack.
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    const previous = entries.find((item) => item.id === entry.id);
    const next = previous === undefined ? [...entries, entry] : entries.map((item) => (item.id === entry.id ? entry : item));
    this.#writeIndex(next);
    if (previous !== undefined && previous.version !== entry.version) rmSync(this.home(previous.id, previous.version), { recursive: true, force: true });
  }

  /** Remove `id` from the index, then its files. False when it was not installed. */
  uninstall(id: string, entries: readonly IndexEntry[]): boolean {
    if (!entries.some((entry) => entry.id === id)) return false;
    this.#writeIndex(entries.filter((entry) => entry.id !== id));
    if (SLUG.test(id)) rmSync(join(this.root, id), { recursive: true, force: true });
    return true;
  }

  /**
   * Every file of an installed pack, as `(path, bytes)` pairs, for `readPack` to validate
   * again: what is on disk is as untrusted as the archive was. A symbolic link anywhere,
   * or a tree past the archive caps, is a refusal.
   */
  read(id: string, version: string): { readonly ok: true; readonly entries: readonly ZipEntry[] } | { readonly ok: false; readonly code: FileCode | "too_many_files"; readonly path: string } {
    const home = this.home(id, version);
    const out: ZipEntry[] = [];
    let total = 0;
    const walk = (dir: string, prefix: string): { ok: false; code: FileCode | "too_many_files"; path: string } | null => {
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        return { ok: false, code: prefix === "" ? "not_found" : "unreadable", path: prefix };
      }
      for (const name of names) {
        const rel = prefix === "" ? name : `${prefix}/${name}`;
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return { ok: false, code: "outside_root", path: rel };
        if (stat.isDirectory()) {
          const inner = walk(path, rel);
          if (inner !== null) return inner;
          continue;
        }
        if (!stat.isFile()) return { ok: false, code: "not_a_file", path: rel };
        if (checkEntryPath(rel) !== null) return { ok: false, code: "bad_path", path: rel };
        total += stat.size;
        if (total > MAX_TOTAL_BYTES) return { ok: false, code: "too_large", path: rel };
        if (out.length >= MAX_ENTRIES) return { ok: false, code: "too_many_files", path: rel };
        out.push({ path: rel, bytes: new Uint8Array(readFileSync(path)) });
      }
      return null;
    };
    const failed = walk(home, "");
    return failed === null ? { ok: true, entries: out } : failed;
  }
}
