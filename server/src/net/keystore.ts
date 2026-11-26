// Access keys. A key binds its holder to one room with one role; there is no
// registration. In memory for now — the file-backed keystore arrives with the admin
// commands that manage it.
import { createHash } from "node:crypto";

import type { Role } from "loreweaver-protocol/v3";

export interface KeyRecord {
  readonly room: string;
  readonly name: string;
  readonly role: Role;
}

export class Keystore {
  readonly #keys = new Map<string, KeyRecord>();

  add(key: string, record: KeyRecord): void {
    this.#keys.set(key, record);
  }

  lookup(key: string): KeyRecord | undefined {
    return this.#keys.get(key);
  }
}

/** A member's stable id: derived from the key, never the key itself. */
export function memberId(key: string): string {
  return `m:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}
