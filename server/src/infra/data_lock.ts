// One server per data directory.
//
// Two servers over one directory would write the same database, the same key file and the
// same media folder behind each other's backs — and a desktop client and a terminal client
// that both "host locally" in the same folder do exactly that. A running server holds
// `server.lock` in its data directory, naming its process; a second one is refused. A lock
// whose process is gone (a crash, a kill) is stale and is taken over.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writePrivateFile } from "./private_files.ts";

export const LOCK_FILE = "server.lock";

export type DataLock = { readonly held: true; release(): void } | { readonly held: false; readonly pid: number };

/** Whether a process with this id exists (signal 0 asks without sending anything). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is someone else's. Anything else: it is not there.
    return (error as { code?: string }).code === "EPERM";
  }
}

/** The process a lock file names, or null when there is none or it cannot be read. */
export function lockHolder(dataDir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, LOCK_FILE), "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** The live process holding `dataDir`, other than `self`; null when nobody does. */
export function runningServer(dataDir: string, self: number = process.pid): number | null {
  const holder = lockHolder(dataDir);
  return holder !== null && holder !== self && alive(holder) ? holder : null;
}

/** Take the directory for `self`; refused while another live process holds it. */
export function takeDataLock(dataDir: string, self: number = process.pid): DataLock {
  const other = runningServer(dataDir, self);
  if (other !== null) return { held: false, pid: other };
  const path = join(dataDir, LOCK_FILE);
  writePrivateFile(path, `${JSON.stringify({ pid: self })}\n`);
  return {
    held: true,
    release: () => {
      // Only our own lock: a server that took a stale one over must not lose it to us.
      if (lockHolder(dataDir) === self) rmSync(path, { force: true });
    },
  };
}
