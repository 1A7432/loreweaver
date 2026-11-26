// The store. Every method is synchronous (see `runtime/sqlite.ts`): between two awaits
// of a turn — a model call, a worker exchange, outbound network — everything that reads
// and writes here is one uninterruptible stretch.
//
// Tables: the room record (its generation — `epoch`, moved by undo, reset and import —
// and the head of its log); the event log, stored as sent; module checkpoints;
// documents, which hold all room CONTENT (lore, characters, variables, notes…) in one
// table so that export, reset and deletion enumerate a room without a per-feature list;
// and room state, the small runtime values (counters, pointers, switches) that are not
// content. This file knows rows, not meanings: what a document is and who may see which
// part of it is `core/documents`.
import type { Database, Statement } from "./runtime/sqlite.ts";

export interface RoomMeta {
  readonly epoch: number;
  /** `seq` of the newest log entry; 0 for an empty log. */
  readonly head: number;
}

export interface StoredEvent {
  readonly seq: number;
  readonly id: string;
  readonly ts: number;
  readonly kind: string;
  readonly turn?: number;
  readonly data: unknown;
}

export interface EventDraft {
  readonly id: string;
  readonly ts: number;
  readonly kind: string;
  readonly turn?: number;
  readonly data: unknown;
}

/** One stored document, its payload still text: parsing is the document layer's job. */
export interface DocumentRow {
  readonly type: string;
  readonly id: string;
  readonly version: number;
  readonly data: string;
  readonly meta: string;
  /** Position within its (room, type), in the order documents were first written. */
  readonly seq: number;
}

interface EventRow {
  seq: number;
  id: string;
  ts: number;
  kind: string;
  turn: number | null;
  data: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  room TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  head INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  room TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  turn INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (room, seq)
) STRICT;
CREATE TABLE IF NOT EXISTS documents (
  room TEXT NOT NULL,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  meta TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (room, type, id)
) STRICT;
CREATE TABLE IF NOT EXISTS room_state (
  room TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (room, key)
) STRICT;
CREATE TABLE IF NOT EXISTS module_state (
  room TEXT NOT NULL,
  module TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (room, module)
) STRICT;
`;

function toEvent(row: EventRow): StoredEvent {
  const event = { seq: row.seq, id: row.id, ts: row.ts, kind: row.kind, data: JSON.parse(row.data) as unknown };
  return row.turn === null ? event : { ...event, turn: row.turn };
}

export class Store {
  readonly #db: Database;
  readonly #meta: Statement<RoomMeta>;
  readonly #createRoom: Statement<unknown>;
  readonly #setHead: Statement<unknown>;
  readonly #setEpoch: Statement<unknown>;
  readonly #insert: Statement<unknown>;
  readonly #after: Statement<EventRow>;
  readonly #before: Statement<EventRow>;
  readonly #cut: Statement<unknown>;
  readonly #lastTurn: Statement<{ turn: number | null }>;
  readonly #docGet: Statement<DocumentRow>;
  readonly #docList: Statement<DocumentRow>;
  readonly #docListType: Statement<DocumentRow>;
  readonly #docNextSeq: Statement<{ next: number }>;
  readonly #docInsert: Statement<unknown>;
  readonly #docUpdate: Statement<unknown>;
  readonly #docDelete: Statement<unknown>;
  readonly #docDeleteType: Statement<unknown>;
  readonly #docDeleteRoom: Statement<unknown>;
  readonly #stateGet: Statement<{ value: string }>;
  readonly #stateList: Statement<{ key: string; value: string }>;
  readonly #statePut: Statement<unknown>;
  readonly #stateDelete: Statement<unknown>;
  readonly #stateDeleteRoom: Statement<unknown>;
  readonly #moduleStates: Statement<{ module: string; snapshot: string }>;
  readonly #setModuleState: Statement<unknown>;

  constructor(db: Database) {
    this.#db = db;
    db.exec(SCHEMA);
    this.#meta = db.prepare("SELECT epoch, head FROM rooms WHERE room = ?");
    this.#createRoom = db.prepare("INSERT OR IGNORE INTO rooms (room, epoch, head) VALUES (?, 1, 0)");
    this.#setHead = db.prepare("UPDATE rooms SET head = ? WHERE room = ?");
    this.#setEpoch = db.prepare("UPDATE rooms SET epoch = ?, head = ? WHERE room = ?");
    this.#insert = db.prepare("INSERT INTO events (room, seq, id, ts, kind, turn, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.#after = db.prepare(
      "SELECT seq, id, ts, kind, turn, data FROM events WHERE room = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    );
    this.#before = db.prepare(
      "SELECT seq, id, ts, kind, turn, data FROM events WHERE room = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    );
    this.#cut = db.prepare("DELETE FROM events WHERE room = ? AND seq > ?");
    this.#lastTurn = db.prepare("SELECT MAX(turn) AS turn FROM events WHERE room = ?");
    const columns = "type, id, version, data, meta, seq";
    this.#docGet = db.prepare(`SELECT ${columns} FROM documents WHERE room = ? AND type = ? AND id = ?`);
    this.#docList = db.prepare(`SELECT ${columns} FROM documents WHERE room = ? ORDER BY type ASC, seq ASC`);
    this.#docListType = db.prepare(`SELECT ${columns} FROM documents WHERE room = ? AND type = ? ORDER BY seq ASC`);
    this.#docNextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM documents WHERE room = ? AND type = ?");
    this.#docInsert = db.prepare(
      "INSERT INTO documents (room, type, id, version, data, meta, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.#docUpdate = db.prepare(
      "UPDATE documents SET version = ?, data = ?, meta = ? WHERE room = ? AND type = ? AND id = ?",
    );
    this.#docDelete = db.prepare("DELETE FROM documents WHERE room = ? AND type = ? AND id = ?");
    this.#docDeleteType = db.prepare("DELETE FROM documents WHERE room = ? AND type = ?");
    this.#docDeleteRoom = db.prepare("DELETE FROM documents WHERE room = ?");
    this.#stateGet = db.prepare("SELECT value FROM room_state WHERE room = ? AND key = ?");
    this.#stateList = db.prepare("SELECT key, value FROM room_state WHERE room = ? ORDER BY key ASC");
    this.#statePut = db.prepare(
      "INSERT INTO room_state (room, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT (room, key) DO UPDATE SET value = excluded.value",
    );
    this.#stateDelete = db.prepare("DELETE FROM room_state WHERE room = ? AND key = ?");
    this.#stateDeleteRoom = db.prepare("DELETE FROM room_state WHERE room = ?");
    this.#moduleStates = db.prepare("SELECT module, snapshot FROM module_state WHERE room = ?");
    this.#setModuleState = db.prepare(
      "INSERT INTO module_state (room, module, snapshot) VALUES (?, ?, ?) " +
        "ON CONFLICT (room, module) DO UPDATE SET snapshot = excluded.snapshot",
    );
  }

  /** The room's record, created on first sight. */
  room(room: string): RoomMeta {
    this.#createRoom.run(room);
    return this.#meta.get(room) as RoomMeta;
  }

  /** Append one event to the room's log and return it with its number. */
  appendEvent(room: string, draft: EventDraft): StoredEvent {
    return this.#db.transaction(() => {
      const seq = this.room(room).head + 1;
      this.#insert.run(room, seq, draft.id, draft.ts, draft.kind, draft.turn ?? null, JSON.stringify(draft.data));
      this.#setHead.run(seq, room);
      const event = { seq, id: draft.id, ts: draft.ts, kind: draft.kind, data: draft.data };
      return draft.turn === undefined ? event : { ...event, turn: draft.turn };
    });
  }

  /** Up to `limit` events after `after`, oldest first. */
  eventsAfter(room: string, after: number, limit: number): StoredEvent[] {
    return this.#after.all(room, after, limit).map(toEvent);
  }

  /** The `limit` events just before `before`, oldest first — one page of history. */
  eventsBefore(room: string, before: number, limit: number): StoredEvent[] {
    return this.#before.all(room, before, limit).map(toEvent).reverse();
  }

  /**
   * Cut the log back to `to` and move the room to a new generation. Returns the new
   * record. Used by undo; a reset is the same with `to = 0`.
   */
  rewind(room: string, to: number): RoomMeta {
    return this.#db.transaction(() => {
      const meta = this.room(room);
      const head = Math.max(0, Math.min(to, meta.head));
      this.#cut.run(room, head);
      this.#setEpoch.run(meta.epoch + 1, head, room);
      return { epoch: meta.epoch + 1, head };
    });
  }

  /** The highest turn number in the room's log; 0 when no turn has been logged. */
  lastTurn(room: string): number {
    return this.#lastTurn.get(room)?.turn ?? 0;
  }

  /** Each module's last checkpoint in this room, by module id. */
  moduleStates(room: string): Map<string, unknown> {
    return new Map(this.#moduleStates.all(room).map((row) => [row.module, JSON.parse(row.snapshot) as unknown]));
  }

  setModuleState(room: string, module: string, snapshot: unknown): void {
    this.#setModuleState.run(room, module, JSON.stringify(snapshot));
  }

  // --- documents -----------------------------------------------------------------

  docGet(room: string, type: string, id: string): DocumentRow | null {
    return this.#docGet.get(room, type, id);
  }

  /** A room's documents of one type, or of every type, in the order they were first written. */
  docList(room: string, type?: string): DocumentRow[] {
    return type === undefined ? this.#docList.all(room) : this.#docListType.all(room, type);
  }

  /** Write a document. A new one goes last in its type; a rewrite keeps its place. */
  docPut(room: string, type: string, id: string, version: number, data: string, meta: string): void {
    this.#db.transaction(() => {
      if (this.#docGet.get(room, type, id) === null) {
        const seq = this.#docNextSeq.get(room, type)?.next ?? 1;
        this.#docInsert.run(room, type, id, version, data, meta, seq);
      } else {
        this.#docUpdate.run(version, data, meta, room, type, id);
      }
    });
  }

  docDelete(room: string, type: string, id: string): void {
    this.#docDelete.run(room, type, id);
  }

  docDeleteType(room: string, type: string): void {
    this.#docDeleteType.run(room, type);
  }

  docDeleteRoom(room: string): void {
    this.#docDeleteRoom.run(room);
  }

  // --- room state ----------------------------------------------------------------

  /** A runtime value of the room, as stored text; null when unset. */
  stateGet(room: string, key: string): string | null {
    return this.#stateGet.get(room, key)?.value ?? null;
  }

  stateList(room: string): Map<string, string> {
    return new Map(this.#stateList.all(room).map((row) => [row.key, row.value]));
  }

  statePut(room: string, key: string, value: string): void {
    this.#statePut.run(room, key, value);
  }

  stateDelete(room: string, key: string): void {
    this.#stateDelete.run(room, key);
  }

  stateDeleteRoom(room: string): void {
    this.#stateDeleteRoom.run(room);
  }

  /** Run `body` in one transaction: every write lands, or none does. */
  transaction<T>(body: () => T): T {
    return this.#db.transaction(body);
  }

  close(): void {
    this.#db.close();
  }
}
