import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyId, Keystore, KeystoreError, memberId } from "../../src/net/keystore.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "loreweaver-keys-"));
  dirs.push(dir);
  return join(dir, "keys.json");
}

function problem(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof KeystoreError) return error.problem;
    throw error;
  }
  return "ok";
}

test("a minted key is random, looks up, and is listed without its value", () => {
  const keys = new Keystore();
  const a = keys.mint({ room: "table", name: " Ada ", role: "admin" });
  const b = keys.mint({ room: "table", name: "Bao", role: "player" });
  expect(a.key).not.toBe(b.key);
  expect(a.key.length).toBeGreaterThanOrEqual(32);
  expect(keys.lookup(a.key)).toEqual({ room: "table", name: "Ada", role: "admin" });
  expect(keys.list("table")).toEqual([
    { id: a.info.id, room: "table", name: "Ada", role: "admin" },
    { id: b.info.id, room: "table", name: "Bao", role: "player" },
  ]);
  expect(JSON.stringify(keys.list("table"))).not.toContain(a.key);
  expect(keys.list("elsewhere")).toEqual([]);
});

test("ids are derived from the key, differ from the member id, and do not contain it", () => {
  expect(keyId("secret")).toBe(keyId("secret"));
  expect(keyId("secret")).not.toBe(memberId("secret"));
  expect(keyId("secret").slice(2)).not.toBe(memberId("secret").slice(2));
  expect(keyId("secret")).not.toContain("secret");
});

test("a room is never left without an admin key", () => {
  const keys = new Keystore();
  const admin = keys.mint({ room: "table", name: "Ada", role: "admin" });
  const player = keys.mint({ room: "table", name: "Bao", role: "player" });
  expect(problem(() => keys.delete("table", admin.info.id))).toBe("last_admin");
  expect(problem(() => keys.update("table", admin.info.id, { role: "player" }))).toBe("last_admin");
  keys.update("table", player.info.id, { role: "admin" });
  keys.delete("table", admin.info.id);
  expect(keys.lookup(admin.key)).toBeUndefined();
  expect(keys.list("table").map((key) => key.role)).toEqual(["admin"]);
});

test("a key is managed only from its own room", () => {
  const keys = new Keystore();
  const other = keys.mint({ room: "other", name: "Eve", role: "admin" });
  expect(problem(() => keys.delete("table", other.info.id))).toBe("unknown_key");
  expect(problem(() => keys.update("table", other.info.id, { name: "x" }))).toBe("unknown_key");
});

test("room ids and names are checked", () => {
  const keys = new Keystore();
  for (const room of ["", "../x", "a/b", "a b", "x".repeat(65)]) {
    expect([room, problem(() => keys.mint({ room, name: "n", role: "player" }))]).toEqual([room, "bad_room"]);
  }
  expect(problem(() => keys.mint({ room: "r", name: "  ", role: "player" }))).toBe("bad_name");
  expect(problem(() => keys.mint({ room: "r", name: "汉".repeat(65), role: "player" }))).toBe("bad_name");
  expect(keys.mint({ room: "r", name: "汉".repeat(64), role: "player" }).info.name).toHaveLength(64);
});

test("with a path, keys survive a restart in an owner-only file", () => {
  const path = file();
  const first = new Keystore(path);
  const minted = first.mint({ room: "table", name: "Ada", role: "admin" });
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, keys: [{ key: minted.key, room: "table", role: "admin" }] });
  const second = new Keystore(path);
  expect(second.lookup(minted.key)).toEqual({ room: "table", name: "Ada", role: "admin" });
  expect(second.deleteRoom("table")).toBe(1);
  expect(new Keystore(path).list("table")).toEqual([]);
});

test("a keys file that cannot be read stops the start instead of becoming an empty keystore", () => {
  const path = file();
  writeFileSync(path, "{broken");
  expect(() => new Keystore(path)).toThrow();
  writeFileSync(path, JSON.stringify({ version: 2, keys: [] }));
  expect(() => new Keystore(path)).toThrow("not a version 1 keys file");
  expect(readFileSync(path, "utf8")).toContain('"version":2');
});
