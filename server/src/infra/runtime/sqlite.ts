// The database driver. SQLite runs inside this process and its calls are synchronous:
// a statement has finished when the call returns, so the store built on it needs no
// lock and never yields to another task.
import { Database as BunDatabase } from "bun:sqlite";

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
