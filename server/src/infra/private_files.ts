// Files that hold secrets (access keys, the transport's secret key): written whole or
// not at all, and readable by their owner only where the platform has such a notion.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Create `dir` (and parents) for the owner only. An existing directory is left as it is. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Replace `path` with `data`, atomically: a reader sees the old file or the new one,
 * never a half-written one, and a crash mid-write leaves the old file in place.
 */
export function writePrivateFile(path: string, data: string | Uint8Array): void {
  ensurePrivateDir(dirname(path));
  const temp = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    // `mode` is filtered by the process umask on creation; this is not.
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
