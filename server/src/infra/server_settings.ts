// Settings a room's admin changes at run time that belong to the whole SERVER, not to a
// room: the model lanes' and image generation's overrides and the per-provider credential
// books (`gateway/model_settings.ts` owns their meaning). One table in the server's
// database, `server_settings`, of JSON values under fixed names.
//
// Not room state, by design: no room's reset, undo, import, export or delete reads or
// touches this table (it is not a `RoomStorage`, and the store's room operations name their
// own tables). Switching the model is the host's decision for every table on the server.
//
// Secrets at rest. An API key set from chat is stored here in plain text, as the 2.6 server
// stored its overrides and credential book in its database: a restart must keep a key typed
// at run time working, and a key the server can decrypt by itself is no better protected
// than one in plain text beside it. What protects it is where it lives: the data directory
// is created for its owner only (`private_files.ts`) and the database file is made
// owner-readable (`cli/compose.ts` `openData`), as the key file and the transport key are.
// The way out for an operator who wants no secret in the database is unchanged: the
// `TRPG_*` variables, which this table only overrides while an override is set.
import type { Database, Statement } from "./runtime/sqlite.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS server_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

/** The longest stored value, in bytes of JSON: far above any real settings object. */
export const MAX_SETTING_BYTES = 1024 * 1024;

export class ServerSettings {
  readonly #get: Statement<{ value: string }>;
  readonly #put: Statement<never>;
  readonly #delete: Statement<never>;

  constructor(db: Database) {
    db.exec(SCHEMA);
    this.#get = db.prepare("SELECT value FROM server_settings WHERE name = ?");
    this.#put = db.prepare("INSERT INTO server_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value");
    this.#delete = db.prepare("DELETE FROM server_settings WHERE name = ?");
  }

  /** The parsed value under `name`; undefined when absent or not readable JSON (a damaged value counts as unset). */
  get(name: string): unknown {
    const row = this.#get.get(name);
    if (row === null) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  put(name: string, value: unknown): void {
    const text = JSON.stringify(value);
    if (text.length > MAX_SETTING_BYTES) throw new Error(`server setting ${name} is too large`);
    this.#put.run(name, text);
  }

  delete(name: string): void {
    this.#delete.run(name);
  }
}

/** Secrets up to this many characters are shown as stars only. */
const MASK_WHOLE_BELOW = 16;

/**
 * A secret as it may be shown: the first and last four characters, as 2.6's `mask_secret`.
 * 2.6 starred only secrets of 8 characters or fewer, which showed 8 of a 9-character secret;
 * here anything up to 16 characters is all stars.
 */
export function maskSecret(value: string): string {
  if (value === "") return "";
  const chars = [...value];
  if (chars.length <= MASK_WHOLE_BELOW) return "*".repeat(chars.length);
  return `${chars.slice(0, 4).join("")}...${chars.slice(-4).join("")}`;
}
