// The store. Every method is synchronous (see `runtime/sqlite.ts`): between two awaits
// of a turn — a model call, a worker exchange, outbound network — everything that reads
// and writes here is one uninterruptible stretch.
//
// What exists so far is the room record and the event log: each room has a generation
// (`epoch`, moved by undo, reset and import) and a log of numbered events, stored as
// they were sent.
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

  close(): void {
    this.#db.close();
  }
}
