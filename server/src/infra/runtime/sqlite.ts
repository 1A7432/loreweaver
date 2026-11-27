// The database driver. SQLite runs inside this process and its calls are synchronous:
// a statement has finished when the call returns, so the store built on it needs no
// lock and never yields to another task.
import { Database as BunDatabase, constants } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface Statement<Row> {
  all(...params: SqlValue[]): Row[];
  get(...params: SqlValue[]): Row | null;
  run(...params: SqlValue[]): void;
}

export interface Database {
  exec(sql: string): void;
  prepare<Row = unknown>(sql: string): Statement<Row>;
  /** Run `body` in one transaction: every write lands, or none does. */
  transaction<T>(body: () => T): T;
  close(): void;
}

/** Open (creating if needed) a database file, or `":memory:"`. */
export function openDatabase(path: string): Database {
  const db = new BunDatabase(path, { create: true, strict: true });
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: <Row>(sql: string): Statement<Row> => {
      const statement = db.query<Row, SqlValue[]>(sql);
      return {
        all: (...params) => statement.all(...params),
        get: (...params) => statement.get(...params),
        run: (...params) => {
          statement.run(...params);
        },
      };
    },
    transaction: (body) => db.transaction(body)(),
    close: () => {
      db.close();
    },
  };
}

/**
 * The names of the tables in a database file, read without changing the file and without
 * creating one beside it; null when the file is not a database SQLite reads. For looking at a
 * file before deciding whether it is ours to open: `openDatabase` switches the journal mode
 * and its callers create tables at once.
 *
 * The file is read as it lies on disk (`immutable`): no lock, no journal, nothing written. When
 * a write-ahead log lies beside it the newest tables may be in the log only, so the file is
 * read through an ordinary read-only connection first, which follows the log.
 */
export function tableNames(path: string): readonly string[] | null {
  const read = (db: BunDatabase): string[] => {
    try {
      return db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    } finally {
      db.close();
    }
  };
  if (existsSync(`${path}-wal`)) {
    try {
      return read(new BunDatabase(path, { readonly: true }));
    } catch {
      // The log cannot be followed (its index is missing or locked away): the file itself still reads.
    }
  }
  try {
    return read(new BunDatabase(`${pathToFileURL(resolve(path)).href}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI));
  } catch {
    return null;
  }
}
