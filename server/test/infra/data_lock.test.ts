// One server per data directory.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCK_FILE, lockHolder, runningServer, takeDataLock } from "../../src/infra/data_lock.ts";

const root = mkdtempSync(join(tmpdir(), "loreweaver-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
const dir = (): string => mkdtempSync(join(root, `d${(serial += 1)}-`));

/** A process id nothing runs under: the highest ids are never handed out in a test run. */
const GONE = 0x3ffffffe;
/** A process that certainly runs and is not this one: the test runner's parent. */
const OTHER = process.ppid;

test("a free directory is taken, named, and given back", () => {
  const d = dir();
  const lock = takeDataLock(d);
  if (!lock.held) throw new Error("refused");
  expect(lockHolder(d)).toBe(process.pid);
  if (process.platform !== "win32") expect(statSync(join(d, LOCK_FILE)).mode & 0o777).toBe(0o600);
  // The holder itself is not "another server".
  expect(runningServer(d)).toBeNull();
  lock.release();
  expect(existsSync(join(d, LOCK_FILE))).toBe(false);
});

test("a directory held by a live process is refused, naming it", () => {
  const d = dir();
  writeFileSync(join(d, LOCK_FILE), JSON.stringify({ pid: OTHER }));
  expect(runningServer(d)).toBe(OTHER);
  expect(takeDataLock(d)).toEqual({ held: false, pid: OTHER });
  // Refusing changed nothing.
  expect(JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8"))).toEqual({ pid: OTHER });
});

test("a lock whose process is gone, or that cannot be read, is stale and taken over", () => {
  for (const stale of [JSON.stringify({ pid: GONE }), "not json", JSON.stringify({ pid: "12" }), JSON.stringify({ pid: -4 }), ""]) {
    const d = dir();
    writeFileSync(join(d, LOCK_FILE), stale);
    expect([stale, runningServer(d)]).toEqual([stale, null]);
    const lock = takeDataLock(d);
    expect([stale, lock.held]).toEqual([stale, true]);
    expect(lockHolder(d)).toBe(process.pid);
  }
});

test("releasing does not remove a lock that has become someone else's", () => {
  const d = dir();
  const lock = takeDataLock(d);
  if (!lock.held) throw new Error("refused");
  writeFileSync(join(d, LOCK_FILE), JSON.stringify({ pid: OTHER }));
  lock.release();
  expect(lockHolder(d)).toBe(OTHER);
});
