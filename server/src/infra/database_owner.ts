// Whose database a data directory holds. A Loreweaver 2 server kept its database under the
// same file name in the same default folder, with other tables: this server's store would
// create its own beside them and then fail on the first statement, having written into a
// file that is not its own. So every command that would write to a data directory asks
// first, and the asking writes nothing.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { tableNames } from "./runtime/sqlite.ts";

/** The database's file name in a data directory. */
export const DATABASE_FILE = "loreweaver.db";
/** The table this server's store stamps its layout in (`infra/store.ts`). */
export const STORE_STAMP_TABLE = "store_schema";

export function databasePath(dataDir: string): string {
  return join(dataDir, DATABASE_FILE);
}

/**
 * `none`: no database yet (no file, or one without tables). `ours`: one this server's store
 * stamped. `other`: a file with tables and no stamp, or one that is not a database — an
 * earlier Loreweaver's, or something else's; not this server's to open.
 */
export function databaseOwner(dataDir: string): "none" | "ours" | "other" {
  const path = databasePath(dataDir);
  if (!existsSync(path)) return "none";
  const tables = tableNames(path);
  if (tables === null) return "other";
  if (tables.includes(STORE_STAMP_TABLE)) return "ours";
  return tables.length === 0 ? "none" : "other";
}
