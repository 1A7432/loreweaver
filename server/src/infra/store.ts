// The store. Every method is synchronous (see `runtime/sqlite.ts`): between two awaits
// of a turn — a model call, a worker exchange, outbound network — everything that reads
// and writes here is one uninterruptible stretch.
//
// Tables: the room record (its generation `epoch`, the highest event number it has handed
// out `head`, its turn counter, the oldest turn undo may return to, the document position
// counter); the event log, stored as sent; module checkpoints; documents, which hold all
// room CONTENT (lore, characters, variables, notes…) in one table so that export, reset
// and deletion enumerate a room without a per-feature list; room state, the small runtime
// values (counters, pointers, switches) that are not content; and the undo journal. This
// file knows rows, not meanings: what a document is and who may see which part of it is
// `core/documents`.
//
// ## Writing: only through a writer
//
// Reads are open. Every WRITE to a room — documents, room state, module checkpoints,
// events — goes through a `RoomWriter`, bound to (room, generation, turn) when it is made
// (`writer`, `beginTurn`). The write methods themselves are `#private` to this class and
// the writer is a closure over them, so there is no other path to room data: no exported
// function, no public method, no subclass hook writes a row. A writer whose generation is
// no longer the room's refuses every write with `StaleGeneration`; undo, reset, import and
// delete each move the generation. That replaces cancelling a background lane and waiting
// for it: a lane that computed for a past generation cannot commit.
//
// ## Undo: a journal of what each turn wrote
//
// A writer's turn is the turn its writes belong to — for a background lane, the turn it
// was SCHEDULED on, however late it finishes. Every write inside the undo window records,
// in the order the writes happened, the key, the turn, what was there before and what was
// written (null for "absent"); consecutive writes of one turn to one key fold into one
// entry. `undoTo(M)` takes the stretch of the journal from the first write of any turn
// after M, puts every key it touched back as it was before that stretch (newest first),
// then re-applies, in their original order, the writes in that stretch that belong to
// turns ≤ M — a late lane of turn M that finished after turn M+1 began is part of M and
// survives undoing M+1. The result is exactly the room as if no turn after M had ever
// written. Cost follows the writes since that point, never the size of the room.
//
// Why re-apply rather than only restore before-images: with late lanes the writes of two
// turns interleave on one key (turn 5 writes x, the late lane of turn 4 writes x after
// it). Restoring turn 5's before-image would also erase turn 4's later write. Folding
// writes per (turn, key) is safe only while no other turn's write to that key sits
// between them, which is the fold rule; a document that comes into existence always opens
// a new entry, because where a document is created fixes its position.
//
// The window: `undoDepth` turns (default 4, the chronicle's no-future lag window, so an
// undo can never reach a turn the rolling summary has already absorbed). Beginning turn T
// moves the oldest reachable turn (`floor`) to T − depth and prunes the journal entries
// before the first write of any turn after it. Writes of turns at or below the floor are
// still journaled while the window is open (they are re-applied, never undone); with no
// open window they are not journaled at all. Reset, import and delete clear the journal
// and set the floor to the room's new turn: nothing undoes across them.
//
// ## The log on undo
//
// `undoTo(M)` keeps every event whose turn ≤ M, and every turn-less event that precedes
// the first event (by `seq`) of any turn after M; it drops the rest. The cut is by turn,
// not by position, so it leaves holes: a late event of turn M logged after turn M+1 began
// survives between removed ones. Event numbers (`seq`) are never reused in a room: `head`
// is a high-water mark that no undo, reset or import lowers (only the room's own number
// line, never a shared one). Within one generation the visible log only grows at its end,
// so a client resuming by `seq` in the same generation misses nothing; across a
// generation change the client's copy is void and it re-reads (the welcome carries the
// epoch). An import renumbers the bundle's events from `head + 1`.

import { parseBundle, ROOM_BUNDLE_FORMAT, ROOM_BUNDLE_VERSION, type DocumentCatalog, type RoomBundle } from "./lifecycle/bundle.ts";
import {
  assertDeclared,
  covers,
  isResetScope,
  MODULE_STATE_LIFECYCLE,
  stateKeyNamed,
  type ResetScope,
  type StateKey,
} from "./lifecycle/declarations.ts";
import { LifecycleError, StaleGeneration } from "./lifecycle/errors.ts";
import { RoomStorages, type StorageReport } from "./lifecycle/storages.ts";
import type { Database, SqlValue, Statement } from "./runtime/sqlite.ts";

/** How many turns back an undo may reach unless the operator sets otherwise. */
export const DEFAULT_UNDO_DEPTH = 4;

export interface RoomMeta {
  readonly epoch: number;
  /** The highest event number this room has handed out; 0 when it never logged anything. */
  readonly head: number;
  /** The newest turn begun; 0 before the first. */
  readonly turn: number;
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
  /** When given, must be the writer's own turn. */
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
  /** Position in the room: a document sorts by the order it (last) came into existence. */
  readonly seq: number;
}

/** Writes to one room, for one generation and one turn. */
export interface RoomWriter {
  readonly room: string;
  readonly epoch: number;
  readonly turn: number;
  /** False once the room has moved to another generation: every write would be refused. */
  current(): boolean;
  /** Append one event to the room's log and return it with its number. */
  appendEvent(draft: EventDraft): StoredEvent;
  /** Write a document. A new one goes last; a rewrite keeps its place. */
  docPut(type: string, id: string, version: number, data: string, meta: string): void;
  /** Whether there was a document to delete. */
  docDelete(type: string, id: string): boolean;
  /**
   * Delete every document of one type; returns how many went. Journaled as a delete of
   * each document it found, which is what it means: an undo that later brings back a
   * document of that type it never saw does not delete it again.
   */
  docDeleteType(type: string): number;
  statePut<T>(key: StateKey<T>, value: T): void;
  /** Whether there was a value to delete. */
  stateDelete<T>(key: StateKey<T>): boolean;
  setModuleState(module: string, snapshot: unknown): void;
}

export interface UndoResult {
  readonly epoch: number;
  readonly head: number;
  /** The room's turn after the undo: the turn undone to. */
  readonly turn: number;
  /** The turns whose effects were removed, oldest first. */
  readonly removedTurns: readonly number[];
  /** Modules whose checkpoint is now different: their worker must reload. */
  readonly modulesChanged: readonly string[];
}

export interface LifecycleResult {
  readonly epoch: number;
  readonly head: number;
  readonly turn: number;
  /** The external storages told about the operation (see `lifecycle/storages.ts`). */
  readonly storages: StorageReport;
}

export interface StoreOptions {
  /** How many turns back an undo may reach (default `DEFAULT_UNDO_DEPTH`). */
  readonly undoDepth?: number;
  /** Storages outside this store to tell about reset, delete and import. */
  readonly storages?: RoomStorages;
}

interface RoomRecord {
  epoch: number;
  head: number;
  turn: number;
  floor: number;
  doc_seq: number;
}

interface EventRow {
  seq: number;
  id: string;
  ts: number;
  kind: string;
  turn: number | null;
  data: string;
}

type KeyKind = "doc" | "state" | "module";

/** A journaled key: a document (type, id), a room-state key (name, ""), a module (id, ""). */
interface KeyRef {
  readonly kind: KeyKind;
  readonly k1: string;
  readonly k2: string;
}

interface JournalRow {
  jseq: number;
  turn: number;
  kind: KeyKind;
  k1: string;
  k2: string;
  before: string | null;
  after: string | null;
}

/** A document's whole stored row: what a before-image restores exactly. */
interface DocImage {
  version: number;
  data: string;
  meta: string;
  seq: number;
}

/** What a document write writes; its position follows from whether it already exists. */
interface DocWrite {
  version: number;
  data: string;
  meta: string;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_schema (
  version INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS rooms (
  room TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  head INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  doc_seq INTEGER NOT NULL
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
CREATE INDEX IF NOT EXISTS events_turn ON events (room, turn);
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
CREATE TABLE IF NOT EXISTS journal (
  room TEXT NOT NULL,
  jseq INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  kind TEXT NOT NULL,
  k1 TEXT NOT NULL,
  k2 TEXT NOT NULL,
  before TEXT,
  after TEXT,
  PRIMARY KEY (room, jseq)
) STRICT;
CREATE INDEX IF NOT EXISTS journal_key ON journal (room, kind, k1, k2, jseq);
CREATE INDEX IF NOT EXISTS journal_turn ON journal (room, turn, jseq);
`;

function toEvent(row: EventRow): StoredEvent {
  const event = { seq: row.seq, id: row.id, ts: row.ts, kind: row.kind, data: JSON.parse(row.data) as unknown };
  return row.turn === null ? event : { ...event, turn: row.turn };
}

/** The statements of this store, prepared once. */
function prepare(db: Database) {
  const q = <Row = unknown>(sql: string): Statement<Row> => db.prepare<Row>(sql);
  const docColumns = "type, id, version, data, meta, seq";
  return {
    meta: q<RoomRecord>("SELECT epoch, head, turn, floor, doc_seq FROM rooms WHERE room = ?"),
    createRoom: q("INSERT OR IGNORE INTO rooms (room, epoch, head, turn, floor, doc_seq) VALUES (?, 1, 0, 0, 0, 0)"),
    setRoom: q("UPDATE rooms SET epoch = ?, head = ?, turn = ?, floor = ?, doc_seq = ? WHERE room = ?"),
    eventInsert: q("INSERT INTO events (room, seq, id, ts, kind, turn, data) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    eventsAfter: q<EventRow>("SELECT seq, id, ts, kind, turn, data FROM events WHERE room = ? AND seq > ? ORDER BY seq ASC LIMIT ?"),
    eventsBefore: q<EventRow>("SELECT seq, id, ts, kind, turn, data FROM events WHERE room = ? AND seq < ? ORDER BY seq DESC LIMIT ?"),
    eventsAll: q<EventRow>("SELECT seq, id, ts, kind, turn, data FROM events WHERE room = ? ORDER BY seq ASC"),
    firstLaterEvent: q<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events WHERE room = ? AND turn > ?"),
    cutLaterTurns: q("DELETE FROM events WHERE room = ? AND turn > ?"),
    cutTurnlessAfter: q("DELETE FROM events WHERE room = ? AND turn IS NULL AND seq > ?"),
    eventsDeleteRoom: q("DELETE FROM events WHERE room = ?"),
    docGet: q<DocumentRow>(`SELECT ${docColumns} FROM documents WHERE room = ? AND type = ? AND id = ?`),
    docList: q<DocumentRow>(`SELECT ${docColumns} FROM documents WHERE room = ? ORDER BY type ASC, seq ASC`),
    docListType: q<DocumentRow>(`SELECT ${docColumns} FROM documents WHERE room = ? AND type = ? ORDER BY seq ASC`),
    docListOrdered: q<DocumentRow>(`SELECT ${docColumns} FROM documents WHERE room = ? ORDER BY seq ASC`),
    docIdsOfType: q<{ id: string }>("SELECT id FROM documents WHERE room = ? AND type = ? ORDER BY seq ASC"),
    docTypes: q<{ type: string }>("SELECT DISTINCT type FROM documents WHERE room = ?"),
    docInsert: q("INSERT INTO documents (room, type, id, version, data, meta, seq) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    docUpdate: q("UPDATE documents SET version = ?, data = ?, meta = ? WHERE room = ? AND type = ? AND id = ?"),
    docRestore: q(
      "INSERT INTO documents (room, type, id, version, data, meta, seq) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (room, type, id) DO UPDATE SET version = excluded.version, data = excluded.data, meta = excluded.meta, seq = excluded.seq",
    ),
    docDelete: q("DELETE FROM documents WHERE room = ? AND type = ? AND id = ?"),
    docDeleteType: q("DELETE FROM documents WHERE room = ? AND type = ?"),
    docDeleteRoom: q("DELETE FROM documents WHERE room = ?"),
    stateGet: q<{ value: string }>("SELECT value FROM room_state WHERE room = ? AND key = ?"),
    stateList: q<{ key: string; value: string }>("SELECT key, value FROM room_state WHERE room = ? ORDER BY key ASC"),
    statePut: q(
      "INSERT INTO room_state (room, key, value) VALUES (?, ?, ?) ON CONFLICT (room, key) DO UPDATE SET value = excluded.value",
    ),
    stateDelete: q("DELETE FROM room_state WHERE room = ? AND key = ?"),
    stateDeleteRoom: q("DELETE FROM room_state WHERE room = ?"),
    moduleGet: q<{ snapshot: string }>("SELECT snapshot FROM module_state WHERE room = ? AND module = ?"),
    moduleList: q<{ module: string; snapshot: string }>("SELECT module, snapshot FROM module_state WHERE room = ? ORDER BY module ASC"),
    modulePut: q(
      "INSERT INTO module_state (room, module, snapshot) VALUES (?, ?, ?) ON CONFLICT (room, module) DO UPDATE SET snapshot = excluded.snapshot",
    ),
    moduleDelete: q("DELETE FROM module_state WHERE room = ? AND module = ?"),
    moduleDeleteRoom: q("DELETE FROM module_state WHERE room = ?"),
    journalLatest: q<{ jseq: number; turn: number }>(
      "SELECT jseq, turn FROM journal WHERE room = ? AND kind = ? AND k1 = ? AND k2 = ? ORDER BY jseq DESC LIMIT 1",
    ),
    journalNext: q<{ next: number }>("SELECT COALESCE(MAX(jseq), 0) + 1 AS next FROM journal WHERE room = ?"),
    journalInsert: q("INSERT INTO journal (room, jseq, turn, kind, k1, k2, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    journalSetAfter: q("UPDATE journal SET after = ? WHERE room = ? AND jseq = ?"),
    journalSetBefore: q("UPDATE journal SET before = ? WHERE room = ? AND jseq = ?"),
    journalOpen: q<{ jseq: number | null }>("SELECT MIN(jseq) AS jseq FROM journal WHERE room = ? AND turn > ?"),
    journalFrom: q<JournalRow>("SELECT jseq, turn, kind, k1, k2, before, after FROM journal WHERE room = ? AND jseq >= ? ORDER BY jseq ASC"),
    journalPruneBefore: q("DELETE FROM journal WHERE room = ? AND jseq < ?"),
    journalDropTurnsAfter: q("DELETE FROM journal WHERE room = ? AND turn > ?"),
    journalDeleteRoom: q("DELETE FROM journal WHERE room = ?"),
  };
}

type Statements = ReturnType<typeof prepare>;

function openSchema(db: Database): void {
  const table = db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  // A database that holds rooms but no schema stamp was written by an earlier layout of
  // this store; reading it with this one would misread every row.
  if (table.get("rooms") !== null && table.get("store_schema") === null) throw new LifecycleError("store_schema_mismatch", "rooms");
  db.exec(SCHEMA);
  const stamp = db.prepare<{ version: number }>("SELECT version FROM store_schema").get();
  if (stamp === null) db.prepare("INSERT INTO store_schema (version) VALUES (?)").run(SCHEMA_VERSION);
  else if (stamp.version !== SCHEMA_VERSION) throw new LifecycleError("store_schema_mismatch", "store_schema");
}

export class Store {
  readonly #db: Database;
  readonly #q: Statements;
  readonly #depth: number;
  readonly #storages: RoomStorages;

  constructor(db: Database, options: StoreOptions = {}) {
    const depth = options.undoDepth ?? DEFAULT_UNDO_DEPTH;
    if (!Number.isSafeInteger(depth) || depth < 1) throw new LifecycleError("invalid_settings", "undoDepth");
    this.#db = db;
    openSchema(db);
    this.#q = prepare(db);
    this.#depth = depth;
    this.#storages = options.storages ?? new RoomStorages();
  }

  get undoDepth(): number {
    return this.#depth;
  }

  // --- reading -----------------------------------------------------------------------

  /** The room's record, created on first sight. */
  room(room: string): RoomMeta {
    const record = this.#record(room);
    return { epoch: record.epoch, head: record.head, turn: record.turn };
  }

  /** The oldest turn `undoTo` may return to now. */
  undoFloor(room: string): number {
    const record = this.#record(room);
    return Math.max(record.floor, record.turn - this.#depth);
  }

  /** Up to `limit` events after `after`, oldest first. */
  eventsAfter(room: string, after: number, limit: number): StoredEvent[] {
    return this.#q.eventsAfter.all(room, after, limit).map(toEvent);
  }

  /** The `limit` events just before `before`, oldest first — one page of history. */
  eventsBefore(room: string, before: number, limit: number): StoredEvent[] {
    return this.#q.eventsBefore.all(room, before, limit).map(toEvent).reverse();
  }

  /** Each module's last checkpoint in this room, by module id. */
  moduleStates(room: string): Map<string, unknown> {
    return new Map(this.#q.moduleList.all(room).map((row) => [row.module, JSON.parse(row.snapshot) as unknown]));
  }

  docGet(room: string, type: string, id: string): DocumentRow | null {
    return this.#q.docGet.get(room, type, id);
  }

  /** A room's documents of one type, or of every type, in the order they came into existence. */
  docList(room: string, type?: string): DocumentRow[] {
    return type === undefined ? this.#q.docList.all(room) : this.#q.docListType.all(room, type);
  }

  /** A runtime value of the room; null when unset or unreadable as the key's value. */
  stateGet<T>(room: string, key: StateKey<T>): T | null {
    const text = this.#q.stateGet.get(room, key.name)?.value;
    return text === undefined ? null : key.decode(text);
  }

  /** Every stored runtime value of the room, as stored text, by key name. */
  stateList(room: string): Map<string, string> {
    return new Map(this.#q.stateList.all(room).map((row) => [row.key, row.value]));
  }

  // --- writers -----------------------------------------------------------------------

  /**
   * A writer for `room` in its current generation, for `turn` — the turn its writes belong
   * to, which defaults to the room's newest. A background lane passes the turn it was
   * scheduled on (or keeps the writer it was handed then). Throws `turn_out_of_range` for a
   * turn the room has not begun.
   */
  writer(room: string, turn?: number): RoomWriter {
    const record = this.#record(room);
    const bound = turn ?? record.turn;
    if (!Number.isSafeInteger(bound) || bound < 0 || bound > record.turn) throw new LifecycleError("turn_out_of_range", String(bound));
    return this.#makeWriter(room, record.epoch, bound);
  }

  /** Begin the room's next turn and return its writer. Moves the undo window along. */
  beginTurn(room: string): RoomWriter {
    return this.#db.transaction(() => {
      const record = this.#record(room);
      const turn = record.turn + 1;
      const floor = Math.max(record.floor, turn - this.#depth);
      this.#saveRecord(room, { ...record, turn, floor });
      this.#prune(room, floor);
      return this.#makeWriter(room, record.epoch, turn);
    });
  }

  #makeWriter(room: string, epoch: number, turn: number): RoomWriter {
    const self: RoomWriter = {
      room,
      epoch,
      turn,
      current: () => this.#record(room).epoch === epoch,
      appendEvent: (draft) => this.#appendEvent(self, draft),
      docPut: (type, id, version, data, meta) => {
        const write: DocWrite = { version, data, meta };
        this.#write(self, { kind: "doc", k1: type, k2: id }, JSON.stringify(write));
      },
      docDelete: (type, id) => this.#write(self, { kind: "doc", k1: type, k2: id }, null),
      docDeleteType: (type) =>
        this.#db.transaction(() => {
          this.#check(self);
          let removed = 0;
          for (const row of this.#q.docIdsOfType.all(room, type)) {
            if (this.#write(self, { kind: "doc", k1: type, k2: row.id }, null)) removed += 1;
          }
          return removed;
        }),
      statePut: (key, value) => {
        assertDeclared(key as StateKey<unknown>);
        this.#write(self, { kind: "state", k1: key.name, k2: "" }, key.encode(value));
      },
      stateDelete: (key) => {
        assertDeclared(key as StateKey<unknown>);
        return this.#write(self, { kind: "state", k1: key.name, k2: "" }, null);
      },
      setModuleState: (module, snapshot) => {
        this.#write(self, { kind: "module", k1: module, k2: "" }, JSON.stringify(snapshot));
      },
    };
    return Object.freeze(self);
  }

  // --- undo --------------------------------------------------------------------------

  /**
   * Return the room to the end of turn `to`, in one transaction: every write of a later
   * turn removed, every write of turn ≤ `to` kept (however late it landed), the log cut
   * (see the file header), the generation moved on. Throws `undo_out_of_range` unless
   * `to` is before the room's turn, and `undo_beyond_depth` when the journal no longer
   * reaches that far.
   */
  undoTo(room: string, to: number): UndoResult {
    return this.#db.transaction(() => {
      const record = this.#record(room);
      if (!Number.isSafeInteger(to) || to < 0 || to >= record.turn) throw new LifecycleError("undo_out_of_range", String(to));
      if (to < Math.max(record.floor, record.turn - this.#depth)) throw new LifecycleError("undo_beyond_depth", String(to));

      const modulesChanged: string[] = [];
      const start = this.#q.journalOpen.get(room, to)?.jseq ?? null;
      if (start !== null) {
        const stretch = this.#q.journalFrom.all(room, start);
        const touchedModules = new Map<string, string | null>();
        for (const entry of stretch) {
          if (entry.kind === "module" && !touchedModules.has(entry.k1)) touchedModules.set(entry.k1, this.#image(room, entry));
        }
        // Back to the room as it stood before the stretch began: newest first, so each
        // key ends on the before-image of its earliest entry in the stretch.
        for (let index = stretch.length - 1; index >= 0; index--) {
          const entry = stretch[index] as JournalRow;
          this.#restore(room, entry, entry.before);
        }
        // Then the writes of the turns that stay, in the order they happened. Each one's
        // before-image is what it overwrites NOW, so the journal stays exact for later undos.
        for (const entry of stretch) {
          if (entry.turn > to) continue;
          this.#q.journalSetBefore.run(this.#image(room, entry), room, entry.jseq);
          this.#apply(room, entry, entry.after);
        }
        this.#q.journalDropTurnsAfter.run(room, to);
        for (const [module, previous] of touchedModules) {
          if (this.#q.moduleGet.get(room, module)?.snapshot !== (previous ?? undefined)) modulesChanged.push(module);
        }
      }

      const firstLater = this.#q.firstLaterEvent.get(room, to)?.seq ?? null;
      this.#q.cutLaterTurns.run(room, to);
      if (firstLater !== null) this.#q.cutTurnlessAfter.run(room, firstLater);

      const epoch = record.epoch + 1;
      // Re-read: re-applied creations moved the document position counter on.
      this.#saveRecord(room, { ...this.#record(room), epoch, turn: to });
      const removedTurns: number[] = [];
      for (let turn = to + 1; turn <= record.turn; turn++) removedTurns.push(turn);
      return { epoch, head: record.head, turn: to, removedTurns, modulesChanged: modulesChanged.sort() };
    });
  }

  // --- lifecycle ---------------------------------------------------------------------

  /**
   * A campaign reset. Removes, in one transaction, the documents whose type's lifecycle the
   * scope covers, the room-state values whose key's lifecycle it covers, the module
   * checkpoints when it covers theirs, the whole log (every scope is at least `story`), and
   * the journal; the turn counter restarts at 0 and the generation moves on. Then tells the
   * registered storages. Refuses (`undeclared_document_type`, `undeclared_state_key`)
   * before touching anything when the room holds data no declaration covers: nobody said
   * whether it survives, and guessing either way is the drift this replaces.
   */
  reset(room: string, scope: ResetScope, catalog: DocumentCatalog): LifecycleResult {
    if (!isResetScope(scope)) throw new LifecycleError("invalid_scope", String(scope));
    const result = this.#db.transaction(() => {
      const record = this.#record(room);
      const doomedTypes: string[] = [];
      for (const { type } of this.#q.docTypes.all(room)) {
        const lifecycle = catalog.lifecycleOf(type);
        if (lifecycle === undefined) throw new LifecycleError("undeclared_document_type", type);
        if (covers(scope, lifecycle)) doomedTypes.push(type);
      }
      const doomedKeys: string[] = [];
      for (const key of this.#q.stateList.all(room).map((row) => row.key)) {
        const declared = stateKeyNamed(key);
        if (declared === undefined) throw new LifecycleError("undeclared_state_key", key);
        if (covers(scope, declared.lifecycle)) doomedKeys.push(key);
      }
      for (const type of doomedTypes) this.#q.docDeleteType.run(room, type);
      for (const key of doomedKeys) this.#q.stateDelete.run(room, key);
      if (covers(scope, MODULE_STATE_LIFECYCLE)) this.#q.moduleDeleteRoom.run(room);
      this.#q.eventsDeleteRoom.run(room);
      this.#q.journalDeleteRoom.run(room);
      const epoch = record.epoch + 1;
      this.#saveRecord(room, { ...record, epoch, turn: 0, floor: 0 });
      return { epoch, head: record.head };
    });
    const storages = this.#storages.notify(room, { kind: "reset", scope, epoch: result.epoch });
    return { ...result, turn: 0, storages };
  }

  /**
   * Remove everything of the room — documents, state, checkpoints, log, journal — and tell
   * every registered storage. The room's record stays, generation moved on, so no writer
   * from before the delete can write into a room of the same name later and no event
   * number is ever handed out twice.
   */
  deleteRoom(room: string): LifecycleResult {
    const result = this.#db.transaction(() => {
      const record = this.#record(room);
      this.#clearContent(room);
      const epoch = record.epoch + 1;
      this.#saveRecord(room, { ...record, epoch, turn: 0, floor: 0 });
      return { epoch, head: record.head };
    });
    const storages = this.#storages.notify(room, { kind: "delete", epoch: result.epoch });
    return { ...result, turn: 0, storages };
  }

  /** The room's content as a plain, JSON-serialisable value (see `lifecycle/bundle.ts`). */
  exportRoom(room: string): RoomBundle {
    return this.#db.transaction(() => {
      const record = this.#record(room);
      return {
        format: ROOM_BUNDLE_FORMAT,
        version: ROOM_BUNDLE_VERSION,
        turn: record.turn,
        documents: this.#q.docListOrdered.all(room).map((row) => ({ type: row.type, id: row.id, version: row.version, data: row.data, meta: row.meta })),
        state: this.#q.stateList.all(room).map((row) => ({ key: row.key, value: row.value })),
        modules: this.#q.moduleList.all(room).map((row) => ({ module: row.module, snapshot: row.snapshot })),
        events: this.#q.eventsAll.all(room).map((row) => {
          const event = { id: row.id, ts: row.ts, kind: row.kind, data: JSON.parse(row.data) as unknown };
          return row.turn === null ? event : { ...event, turn: row.turn };
        }),
      };
    });
  }

  /**
   * Replace the room's content with a bundle. The bundle is validated in full first
   * (`parseBundle`); a refused bundle changes nothing. Then, in one transaction, the room's
   * documents, state, checkpoints, log and journal are replaced, the turn counter becomes
   * the bundle's, the generation moves on, and undo cannot reach behind the import. The
   * bundle's events are renumbered from the room's `head + 1`.
   */
  importRoom(room: string, bundle: unknown, catalog: DocumentCatalog): LifecycleResult {
    const parsed = parseBundle(bundle, catalog);
    const result = this.#db.transaction(() => {
      const record = this.#record(room);
      this.#clearContent(room);
      let docSeq = record.doc_seq;
      for (const document of parsed.documents) {
        docSeq += 1;
        this.#q.docInsert.run(room, document.type, document.id, document.version, document.data, document.meta, docSeq);
      }
      for (const entry of parsed.state) this.#q.statePut.run(room, entry.key, entry.value);
      for (const entry of parsed.modules) this.#q.modulePut.run(room, entry.module, entry.snapshot);
      let head = record.head;
      for (const event of parsed.events) {
        head += 1;
        this.#q.eventInsert.run(room, head, event.id, event.ts, event.kind, event.turn ?? null, JSON.stringify(event.data));
      }
      const epoch = record.epoch + 1;
      this.#saveRecord(room, { epoch, head, turn: parsed.turn, floor: parsed.turn, doc_seq: docSeq });
      return { epoch, head, turn: parsed.turn };
    });
    const storages = this.#storages.notify(room, { kind: "import", epoch: result.epoch });
    return { ...result, storages };
  }

  /** Run `body` in one transaction: every write lands, or none does. */
  transaction<T>(body: () => T): T {
    return this.#db.transaction(body);
  }

  close(): void {
    this.#db.close();
  }

  // --- private: the only code that writes rows ----------------------------------------

  #record(room: string): RoomRecord {
    this.#q.createRoom.run(room);
    return this.#q.meta.get(room) as RoomRecord;
  }

  #saveRecord(room: string, record: RoomRecord): void {
    this.#q.setRoom.run(record.epoch, record.head, record.turn, record.floor, record.doc_seq, room);
  }

  #check(writer: RoomWriter): RoomRecord {
    const record = this.#record(writer.room);
    if (record.epoch !== writer.epoch) throw new StaleGeneration(writer.room, writer.epoch, record.epoch);
    return record;
  }

  #appendEvent(writer: RoomWriter, draft: EventDraft): StoredEvent {
    return this.#db.transaction(() => {
      const record = this.#check(writer);
      if (draft.turn !== undefined && draft.turn !== writer.turn) throw new LifecycleError("event_turn_mismatch", String(draft.turn));
      const seq = record.head + 1;
      this.#q.eventInsert.run(writer.room, seq, draft.id, draft.ts, draft.kind, draft.turn ?? null, JSON.stringify(draft.data));
      this.#saveRecord(writer.room, { ...record, head: seq });
      const event = { seq, id: draft.id, ts: draft.ts, kind: draft.kind, data: draft.data };
      return draft.turn === undefined ? event : { ...event, turn: draft.turn };
    });
  }

  /**
   * Write one key (`after` null deletes it) for `writer`, journaling it. Returns whether
   * there was something at the key before.
   *
   * Deleting an absent key changes nothing now and is journaled all the same: a late lane
   * may delete a document that a LATER turn already deleted, and when an undo removes that
   * later turn and puts the document back, the late delete must be re-applied on top.
   */
  #write(writer: RoomWriter, ref: KeyRef, after: string | null): boolean {
    return this.#db.transaction(() => {
      const record = this.#check(writer);
      const room = writer.room;
      const before = this.#image(room, ref);
      if (before !== null || after !== null) this.#apply(room, ref, after);
      this.#journal(room, record, writer.turn, ref, before, after);
      return before !== null;
    });
  }

  #journal(room: string, record: RoomRecord, turn: number, ref: KeyRef, before: string | null, after: string | null): void {
    const floor = Math.max(record.floor, record.turn - this.#depth);
    // Outside an open window nothing can be undone past this write: skip it. A write of a
    // turn at or below the floor is journaled while the window is open, because an undo
    // re-applies it (see the file header).
    if (turn <= floor && this.#q.journalOpen.get(room, floor)?.jseq == null) return;
    const latest = this.#q.journalLatest.get(room, ref.kind, ref.k1, ref.k2);
    // A document coming into existence opens a new entry: its position is fixed where it
    // is created, and folding it into an earlier entry would move that point.
    const creates = ref.kind === "doc" && before === null && after !== null;
    if (latest !== null && latest.turn === turn && !creates) {
      this.#q.journalSetAfter.run(after, room, latest.jseq);
      return;
    }
    const jseq = this.#q.journalNext.get(room)?.next ?? 1;
    this.#q.journalInsert.run(room, jseq, turn, ref.kind, ref.k1, ref.k2, before, after);
  }

  /** Drop the journal before the first write of any turn after `floor`; all of it when there is none. */
  #prune(room: string, floor: number): void {
    const open = this.#q.journalOpen.get(room, floor)?.jseq ?? null;
    if (open === null) this.#q.journalDeleteRoom.run(room);
    else this.#q.journalPruneBefore.run(room, open);
  }

  /** What is stored at `ref` now, as a before-image: null when absent. */
  #image(room: string, ref: KeyRef): string | null {
    switch (ref.kind) {
      case "doc": {
        const row = this.#q.docGet.get(room, ref.k1, ref.k2);
        if (row === null) return null;
        const image: DocImage = { version: row.version, data: row.data, meta: row.meta, seq: row.seq };
        return JSON.stringify(image);
      }
      case "state":
        return this.#q.stateGet.get(room, ref.k1)?.value ?? null;
      case "module":
        return this.#q.moduleGet.get(room, ref.k1)?.snapshot ?? null;
    }
  }

  /** Perform a write: put `after` at `ref` (a new document goes last), or delete when null. */
  #apply(room: string, ref: KeyRef, after: string | null): void {
    switch (ref.kind) {
      case "doc": {
        if (after === null) {
          this.#q.docDelete.run(room, ref.k1, ref.k2);
          return;
        }
        const write = JSON.parse(after) as DocWrite;
        if (this.#q.docGet.get(room, ref.k1, ref.k2) !== null) {
          this.#q.docUpdate.run(write.version, write.data, write.meta, room, ref.k1, ref.k2);
          return;
        }
        const record = this.#record(room);
        const seq = record.doc_seq + 1;
        this.#saveRecord(room, { ...record, doc_seq: seq });
        this.#q.docInsert.run(room, ref.k1, ref.k2, write.version, write.data, write.meta, seq);
        return;
      }
      case "state":
        if (after === null) this.#q.stateDelete.run(room, ref.k1);
        else this.#q.statePut.run(room, ref.k1, after);
        return;
      case "module":
        if (after === null) this.#q.moduleDelete.run(room, ref.k1);
        else this.#q.modulePut.run(room, ref.k1, after);
        return;
    }
  }

  /** Put a before-image back exactly, position included. */
  #restore(room: string, ref: KeyRef, image: string | null): void {
    if (ref.kind !== "doc" || image === null) {
      this.#apply(room, ref, image);
      return;
    }
    const row = JSON.parse(image) as DocImage;
    const params: SqlValue[] = [room, ref.k1, ref.k2, row.version, row.data, row.meta, row.seq];
    this.#q.docRestore.run(...params);
  }

  #clearContent(room: string): void {
    this.#q.docDeleteRoom.run(room);
    this.#q.stateDeleteRoom.run(room);
    this.#q.moduleDeleteRoom.run(room);
    this.#q.eventsDeleteRoom.run(room);
    this.#q.journalDeleteRoom.run(room);
  }
}
