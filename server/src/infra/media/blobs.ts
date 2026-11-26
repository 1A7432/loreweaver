// Blob files on disk: `<data dir>/media/blobs/<sha256>`, one file per distinct content
// whatever the number of rooms holding it. A path is only ever built from a hash that
// has matched `HASH_RE` — never from a room id or a client-supplied name — so no input
// can reach outside the blob directory.
//
// Writing is split in two on purpose. `writeTemp` (async: the bytes may be large) puts
// the content in a temporary file in the same directory and flushes it; `publish`
// (synchronous) renames it into place. The store calls `publish`, the index write, and
// any compensating `remove` inside one synchronous stretch, so no other store operation
// can run between deciding a blob is unreferenced and acting on that decision.
//
// Everything here is portable `node:fs`; nothing needs a runtime-specific call.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { HASH_RE } from "./policy.ts";

const TEMP_RE = /^\.[0-9a-f]{64}\.[A-Za-z0-9-]{1,80}\.tmp$/;

/** Best-effort owner-only mode: some filesystems have no POSIX modes, and that is fine. */
function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // A filesystem without modes; the data is still written.
  }
}

/** Best-effort persistence of a directory entry change, where the platform allows it. */
function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory; some filesystems refuse fsync on one.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class BlobDir {
  readonly #dir: string;
  #serial = 0;

  constructor(dataDir: string) {
    const media = join(resolve(dataDir), "media");
    this.#dir = join(media, "blobs");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    // `mode` above is filtered by the umask and ignored for directories that existed.
    restrict(media, 0o700);
    restrict(this.#dir, 0o700);
  }

  get dir(): string {
    return this.#dir;
  }

  /** The file of a blob. Throws for anything that is not a lowercase hex sha256. */
  pathOf(hash: string): string {
    if (!HASH_RE.test(hash)) throw new RangeError("not a sha256");
    const path = join(this.#dir, hash);
    // Belt and braces: the pattern already excludes separators and dots.
    if (!path.startsWith(this.#dir + sep)) throw new RangeError("outside the blob directory");
    return path;
  }

  /**
   * Write `bytes` to a new owner-only temporary file beside the blob's final place and
   * flush it. `tag` distinguishes concurrent writes of the same content; it is reduced
   * to a safe token here, whatever it was.
   */
  async writeTemp(hash: string, bytes: Uint8Array, tag: string): Promise<string> {
    this.pathOf(hash);
    const token = `${tag.replace(/[^A-Za-z0-9-]/g, "").slice(0, 60) || "w"}-${++this.#serial}`;
    const temp = join(this.#dir, `.${hash}.${token}.tmp`);
    // `wx`: never open a file someone else made; a collision fails instead of sharing it.
    const handle = await open(temp, "wx", 0o600);
    try {
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
        written += bytesWritten;
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      rmSync(temp, { force: true });
      throw error;
    }
    await handle.close();
    restrict(temp, 0o600);
    return temp;
  }

  /** Move a temporary file into place as the blob, replacing an existing copy atomically. */
  publish(temp: string, hash: string): void {
    renameSync(temp, this.pathOf(hash));
    syncDirectory(this.#dir);
  }

  remove(hash: string): void {
    rmSync(this.pathOf(hash), { force: true });
  }

  removeTemp(temp: string): void {
    rmSync(temp, { force: true });
  }

  /** The blob's bytes if the file exists and still hashes to its name. */
  async read(hash: string): Promise<Uint8Array | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.pathOf(hash));
    } catch {
      return undefined;
    }
    return createHash("sha256").update(bytes).digest("hex") === hash ? bytes : undefined;
  }

  /** The directory's entries, sorted into blobs, temporary files and anything else. */
  entries(): { blobs: string[]; temps: string[] } {
    const blobs: string[] = [];
    const temps: string[] = [];
    for (const name of readdirSync(this.#dir)) {
      if (HASH_RE.test(name)) blobs.push(name);
      else if (TEMP_RE.test(name)) temps.push(join(this.#dir, name));
    }
    return { blobs, temps };
  }
}
