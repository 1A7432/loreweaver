// Access keys. A key binds its holder to one room with one role; there is no
// registration. Keys live in one JSON file (owner-readable only) when the keystore is
// given a path, and in memory otherwise.
//
// A key's VALUE is the secret. Everything that identifies a key to people — listings,
// admin commands, logs — uses its `id`, which is derived from the value and cannot be
// turned back into it.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { Role } from "loreweaver-protocol/v3";

import { writePrivateFile } from "../infra/private_files.ts";

export interface KeyRecord {
  readonly room: string;
  readonly name: string;
  readonly role: Role;
}

/** A key as it may be shown: no value. */
export interface KeyInfo extends KeyRecord {
  readonly id: string;
}

export type KeystoreProblem = "unknown_key" | "last_admin" | "bad_room" | "bad_name";

export class KeystoreError extends Error {
  readonly problem: KeystoreProblem;

  constructor(problem: KeystoreProblem) {
    super(`keystore: ${problem}`);
    this.name = "KeystoreError";
    this.problem = problem;
  }
}

const ROLES: readonly Role[] = ["player", "admin", "observer"];
/** Room ids travel in file paths and SQL parameters; keep them plain. */
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NAME_CHARS = 64;

function digest(prefix: string, key: string): string {
  return `${prefix}:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** A member's stable id: derived from the key, never the key itself. */
export function memberId(key: string): string {
  return digest("m", key);
}

/** A key's public handle. A different derivation from the member id, so one does not reveal the other's use. */
export function keyId(key: string): string {
  return digest("k", `key-id\u0000${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || [...trimmed].length > MAX_NAME_CHARS) throw new KeystoreError("bad_name");
  return trimmed;
}

export class Keystore {
  readonly #path: string | undefined;
  readonly #keys = new Map<string, KeyRecord>();

  /** With a `path`, loads the file if it exists and rewrites it on every change. */
  constructor(path?: string) {
    this.#path = path;
    if (path !== undefined && existsSync(path)) this.#load(path);
  }

  /** Register a key with a known value (tests, and importing an existing key). */
  add(key: string, record: KeyRecord): void {
    this.#keys.set(key, this.#checked(record));
    this.#save();
  }

  lookup(key: string): KeyRecord | undefined {
    return this.#keys.get(key);
  }

  /** Create a key with a fresh random value. The value is returned once, here. */
  mint(record: KeyRecord): { key: string; info: KeyInfo } {
    const key = randomBytes(24).toString("base64url");
    const checked = this.#checked(record);
    this.#keys.set(key, checked);
    this.#save();
    return { key, info: { id: keyId(key), ...checked } };
  }

  /** A room's keys, without their values, in the order they were created. */
  list(room: string): KeyInfo[] {
    return [...this.#keys].filter(([, record]) => record.room === room).map(([key, record]) => ({ id: keyId(key), ...record }));
  }

  /** Change a key's name or role. Refuses to leave a room without an admin key. */
  update(room: string, id: string, change: { name?: string; role?: Role }): KeyInfo {
    const [key, record] = this.#find(room, id);
    const next = this.#checked({ ...record, ...change });
    if (record.role === "admin" && next.role !== "admin" && this.#admins(room) === 1) throw new KeystoreError("last_admin");
    this.#keys.set(key, next);
    this.#save();
    return { id, ...next };
  }

  /** Delete a key. Refuses to delete a room's last admin key: nobody could mint another. */
  delete(room: string, id: string): void {
    const [key, record] = this.#find(room, id);
    if (record.role === "admin" && this.#admins(room) === 1) throw new KeystoreError("last_admin");
    this.#keys.delete(key);
    this.#save();
  }

  /** Delete every key of a room (the room itself is being deleted). */
  deleteRoom(room: string): number {
    const doomed = [...this.#keys].filter(([, record]) => record.room === room).map(([key]) => key);
    for (const key of doomed) this.#keys.delete(key);
    if (doomed.length > 0) this.#save();
    return doomed.length;
  }

  #find(room: string, id: string): [string, KeyRecord] {
    for (const entry of this.#keys) {
      if (entry[1].room === room && keyId(entry[0]) === id) return entry;
    }
    throw new KeystoreError("unknown_key");
  }

  #admins(room: string): number {
    let count = 0;
    for (const record of this.#keys.values()) if (record.room === room && record.role === "admin") count += 1;
    return count;
  }

  #checked(record: KeyRecord): KeyRecord {
    if (!ROOM_ID.test(record.room)) throw new KeystoreError("bad_room");
    const role = ROLES.includes(record.role) ? record.role : "player";
    return { room: record.room, name: checkName(record.name), role };
  }

  #save(): void {
    if (this.#path === undefined) return;
    const keys = [...this.#keys].map(([key, record]) => ({ key, ...record }));
    writePrivateFile(this.#path, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`);
  }

  #load(path: string): void {
    // A keys file that cannot be read is not an empty one: starting with no keys would
    // lock every room out, and the next mint would overwrite the file. Fail loudly.
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      throw new Error(`keystore: ${path} is not a version 1 keys file`);
    }
    for (const entry of parsed.keys as unknown[]) {
      if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.room !== "string" || typeof entry.name !== "string") {
        throw new Error(`keystore: ${path} holds a malformed key entry`);
      }
      const role = ROLES.find((option) => option === entry.role) ?? "player";
      this.#keys.set(entry.key, this.#checked({ room: entry.room, name: entry.name, role }));
    }
  }
}
