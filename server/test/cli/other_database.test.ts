// A data directory whose database is not this server's — a Loreweaver 2 server kept its own
// under the same file name in the same default folder — is refused by every command that
// works on a data directory, and left exactly as it was.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/cli/main.ts";
import { databaseOwner, databasePath } from "../../src/infra/database_owner.ts";
import { openDatabase, tableNames } from "../../src/infra/runtime/sqlite.ts";
import { Store } from "../../src/infra/store.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  // A space and a non-ASCII letter: the file is named to SQLite as a URL.
  const dir = mkdtempSync(join(tmpdir(), "loreweaver other é-"));
  made.push(dir);
  return dir;
}

/** The tables a 2.x server created (its `documents` and `room_state` share names with this store's, with other columns). */
const V2_TABLES = `
CREATE TABLE kv (user_key TEXT, store_key TEXT, value TEXT, PRIMARY KEY (user_key, store_key));
CREATE TABLE documents (room TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, schema_version INTEGER NOT NULL, data TEXT NOT NULL, meta TEXT NOT NULL, grants TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (room, type, id));
CREATE TABLE room_state (room TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (room, key));
INSERT INTO kv VALUES ('u', 'k', 'v');
`;

/**
 * A 2.x server's database, in write-ahead mode as that server kept it. `log: false` is the
 * file alone, its log folded in; `log: true` leaves the log and its index beside it, as a
 * server that was killed does.
 */
function olderDatabase(dir: string, log = false): void {
  const path = databasePath(dir);
  const db = openDatabase(path);
  db.exec(V2_TABLES);
  if (!log) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (log) {
    // Copied while the connection holds them: closing would fold the log away.
    for (const suffix of ["-wal", "-shm"]) copyFileSync(`${path}${suffix}`, `${path}${suffix}.kept`);
  }
  db.close();
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
    if (log) renameSync(`${path}${suffix}.kept`, `${path}${suffix}`);
  }
}

const COMMANDS = (card: string): string[][] => [["serve", "--local"], ["serve"], ["key", "harbor", "admin", "Ada"], ["import-world", "harbor", card], ["install", card], ["packs"], ["uninstall", "nothing"]];

function snapshot(dir: string): [string, string][] {
  return readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name)).toString("base64")]);
}

test("whose database a folder holds: none, ours, another's, and a file that is no database", () => {
  const dir = folder();
  expect(databaseOwner(dir)).toBe("none");
  writeFileSync(databasePath(dir), "");
  expect(databaseOwner(dir)).toBe("none");

  const ours = folder();
  const db = openDatabase(databasePath(ours));
  new Store(db);
  // Still open, its tables in the write-ahead log: read through the log.
  expect(databaseOwner(ours)).toBe("ours");
  db.close();
  expect(databaseOwner(ours)).toBe("ours");

  const older = folder();
  olderDatabase(older);
  expect(tableNames(databasePath(older))).toEqual(["kv", "documents", "room_state"]);
  expect(databaseOwner(older)).toBe("other");

  const junk = folder();
  writeFileSync(databasePath(junk), "this is not a database, only a file with that name\n".repeat(40));
  expect(tableNames(databasePath(junk))).toBeNull();
  expect(databaseOwner(junk)).toBe("other");
});

test("every command on a data directory refuses another's database and writes nothing there", async () => {
  const dir = folder();
  olderDatabase(dir);
  const before = snapshot(dir);
  expect(before.map(([name]) => name)).toEqual(["loreweaver.db"]);
  const env = { TRPG_DATA_DIR: dir };
  const card = join(folder(), "card.json");
  writeFileSync(card, "{}");
  for (const argv of COMMANDS(card)) {
    const outcome = await run(argv, env);
    expect([argv[0], outcome.code, JSON.parse(outcome.out)]).toEqual([argv[0], 2, { ok: false, code: "other_database", data_dir: dir }]);
    expect(outcome.server).toBeUndefined();
  }
  expect(snapshot(dir)).toEqual(before);
});

test("the same with its write-ahead log still beside it: refused, no file added, the database and its log as they were", async () => {
  const dir = folder();
  olderDatabase(dir, true);
  const before = new Map(snapshot(dir));
  expect([...before.keys()]).toEqual(["loreweaver.db", "loreweaver.db-shm", "loreweaver.db-wal"]);
  expect(databaseOwner(dir)).toBe("other");
  const card = join(folder(), "card.json");
  writeFileSync(card, "{}");
  for (const argv of COMMANDS(card)) expect(JSON.parse((await run(argv, { TRPG_DATA_DIR: dir })).out)).toMatchObject({ ok: false, code: "other_database" });
  const after = new Map(snapshot(dir));
  expect([...after.keys()]).toEqual([...before.keys()]);
  // The log's index is shared memory a reader marks its place in; the data is in the other two.
  for (const name of ["loreweaver.db", "loreweaver.db-wal"]) expect(after.get(name)).toBe(before.get(name) as string);
});

test("the store alone would have written into it: what the refusal prevents", () => {
  const dir = folder();
  olderDatabase(dir);
  const db = openDatabase(databasePath(dir));
  expect(() => new Store(db)).toThrow();
  db.close();
  // The file now holds this store's tables beside the older ones.
  expect(tableNames(databasePath(dir))).toContain("store_schema");
});
