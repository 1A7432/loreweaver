// Per-room nearest-neighbour search by cosine similarity. Rooms hold thousands of vectors,
// not millions, so the search is brute force over typed arrays: every vector of the room is
// scored against the query. A room's vectors are read from the database on first use and
// kept in memory; every write goes to the database first and to memory only once that
// succeeded, so the two never disagree (as long as this is the only index over its database).
import type { Database, Statement } from "../runtime/sqlite.ts";
import { RecallError, requirePositiveInteger } from "./errors.ts";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface VectorPoint {
  readonly id: string;
  /** Any numeric sequence of the index's length; copied, so later changes to it are not seen. */
  readonly vector: ArrayLike<number>;
  readonly payload: JsonObject;
}

export interface SearchOptions {
  /** At most this many hits; a non-negative integer. */
  readonly limit: number;
  /** Keep only points whose payload has each of these fields, equal (deeply, for arrays and objects). */
  readonly filter?: JsonObject;
}

export interface SearchHit {
  readonly id: string;
  /** Cosine similarity, -1 to 1; 0 when either vector is the zero vector. */
  readonly score: number;
  readonly payload: JsonObject;
}

interface VectorRow {
  id: string;
  seq: number;
  vector: Uint8Array;
  payload: string;
}

// `seq` is the order a point first arrived in its room: it breaks score ties, so the order
// of equal hits is a stored fact rather than whatever order the database returned rows in.
// The vector is a BLOB of little-endian float64, `dimensions` of them.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
  room TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  vector BLOB NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (room, id)
) STRICT;
`;

const FLOAT_BYTES = 8;

interface Entry {
  readonly seq: number;
  /** The stored vector scaled to length 1 (the zero vector stays zero): a score is then one dot product. */
  readonly unit: Float64Array;
  /** Parsed from `payloadText`, only ever read by the filter. */
  readonly payload: JsonObject;
  /** What hits hand out a fresh parse of, so a caller can never change the cached payload. */
  readonly payloadText: string;
}

interface RoomVectors {
  readonly points: Map<string, Entry>;
  nextSeq: number;
}

interface Prepared {
  readonly id: string;
  readonly raw: Float64Array;
  readonly unit: Float64Array;
  readonly payloadText: string;
}

export class VectorIndex {
  readonly dimensions: number;
  readonly #db: Database;
  readonly #rooms = new Map<string, RoomVectors>();
  readonly #load: Statement<VectorRow>;
  readonly #upsert: Statement<unknown>;
  readonly #delete: Statement<unknown>;
  readonly #deleteRoom: Statement<unknown>;
  readonly #count: Statement<{ n: number }>;

  constructor(dimensions: number, db: Database) {
    this.dimensions = requirePositiveInteger("dimensions", dimensions);
    this.#db = db;
    db.exec(SCHEMA);
    this.#load = db.prepare("SELECT id, seq, vector, payload FROM vectors WHERE room = ? ORDER BY seq ASC");
    // A re-upserted point keeps its `seq`: the order of equal hits does not change when a
    // chunk is embedded again.
    this.#upsert = db.prepare(
      "INSERT INTO vectors (room, id, seq, vector, payload) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (room, id) DO UPDATE SET vector = excluded.vector, payload = excluded.payload",
    );
    this.#delete = db.prepare("DELETE FROM vectors WHERE room = ? AND id = ?");
    this.#deleteRoom = db.prepare("DELETE FROM vectors WHERE room = ?");
    this.#count = db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE room = ?");
  }

  /**
   * Insert points, or replace those whose id the room already has. All or nothing: a point
   * with a vector of the wrong length, a non-finite number, or a payload that is not a JSON
   * object refuses the whole call and stores none of them.
   */
  upsert(room: string, points: readonly VectorPoint[]): void {
    if (points.length === 0) return;
    const prepared = points.map((point) => this.#prepare(point));
    const loaded = this.#room(room);
    let next = loaded.nextSeq;
    const seqs = new Map<string, number>();
    const planned = prepared.map((point) => {
      let seq = seqs.get(point.id) ?? loaded.points.get(point.id)?.seq;
      if (seq === undefined) seq = next++;
      seqs.set(point.id, seq);
      return { point, seq };
    });
    this.#db.transaction(() => {
      for (const { point, seq } of planned) {
        this.#upsert.run(room, point.id, seq, encodeVector(point.raw), point.payloadText);
      }
    });
    for (const { point, seq } of planned) {
      loaded.points.set(point.id, {
        seq,
        unit: point.unit,
        // Read back from the text, so memory holds exactly what a reload would give.
        payload: JSON.parse(point.payloadText) as JsonObject,
        payloadText: point.payloadText,
      });
    }
    loaded.nextSeq = next;
  }

  /**
   * The nearest points of one room, best first. Equal scores come in the order the points
   * first arrived. Scores are plain left-to-right sums, so the same data gives the same
   * order on every machine.
   */
  search(room: string, vector: ArrayLike<number>, options: SearchOptions): SearchHit[] {
    const { limit } = options;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RecallError("invalid_limit", { detail: { limit } });
    const query = unitOf(this.#checked(vector));
    const filter = options.filter === undefined ? [] : Object.entries(options.filter);
    const scored: { id: string; entry: Entry; score: number }[] = [];
    for (const [id, entry] of this.#room(room).points) {
      if (matches(entry.payload, filter)) scored.push({ id, entry, score: similarity(query, entry.unit) });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.seq - b.entry.seq);
    return scored
      .slice(0, limit)
      .map(({ id, entry, score }) => ({ id, score, payload: JSON.parse(entry.payloadText) as JsonObject }));
  }

  delete(room: string, ids: readonly string[]): void {
    this.#db.transaction(() => {
      for (const id of ids) this.#delete.run(room, id);
    });
    const loaded = this.#rooms.get(room);
    if (loaded) for (const id of ids) loaded.points.delete(id);
  }

  /** Remove every point of the room, from the database and from memory. */
  deleteRoom(room: string): void {
    this.#deleteRoom.run(room);
    this.#rooms.delete(room);
  }

  /** Drop the room's vectors from memory; the next use reads them from the database again. */
  forget(room: string): void {
    this.#rooms.delete(room);
  }

  count(room: string): number {
    const loaded = this.#rooms.get(room);
    if (loaded) return loaded.points.size;
    return this.#count.get(room)?.n ?? 0;
  }

  #prepare(point: VectorPoint): Prepared {
    const raw = this.#checked(point.vector);
    return { id: point.id, raw, unit: unitOf(raw), payloadText: payloadText(point.payload) };
  }

  /** A copy of the vector as float64, once it is known to fit this index. */
  #checked(vector: ArrayLike<number>): Float64Array {
    if (vector.length !== this.dimensions) {
      throw new RecallError("dimension_mismatch", { detail: { expected: this.dimensions, actual: vector.length } });
    }
    const copy = new Float64Array(this.dimensions);
    for (let i = 0; i < copy.length; i++) {
      const component = vector[i];
      if (typeof component !== "number" || !Number.isFinite(component)) throw new RecallError("non_finite", { detail: { component: i } });
      copy[i] = component;
    }
    return copy;
  }

  #room(room: string): RoomVectors {
    const cached = this.#rooms.get(room);
    if (cached) return cached;
    const points = new Map<string, Entry>();
    let nextSeq = 1;
    for (const row of this.#load.all(room)) {
      points.set(row.id, this.#decode(row));
      nextSeq = Math.max(nextSeq, row.seq + 1);
    }
    // Cached only once every row has loaded: a room that fails to load is not half there.
    const loaded = { points, nextSeq };
    this.#rooms.set(room, loaded);
    return loaded;
  }

  #decode(row: VectorRow): Entry {
    if (row.vector.byteLength !== this.dimensions * FLOAT_BYTES) {
      throw new RecallError("store_mismatch", { detail: { expected: this.dimensions * FLOAT_BYTES, actual: row.vector.byteLength } });
    }
    try {
      const raw = decodeVector(row.vector, this.dimensions);
      const payload = JSON.parse(row.payload) as JsonObject;
      return { seq: row.seq, unit: unitOf(raw), payload, payloadText: row.payload };
    } catch (error) {
      throw new RecallError("store_mismatch", { cause: error });
    }
  }
}

function payloadText(payload: JsonObject): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new RecallError("invalid_payload");
  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new RecallError("invalid_payload", { cause: error });
  }
}

// Byte order is fixed (little-endian) whatever the machine, so a database file moves between hosts.
function encodeVector(vector: Float64Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * FLOAT_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) view.setFloat64(i * FLOAT_BYTES, vector[i] ?? 0, true);
  return bytes;
}

function decodeVector(bytes: Uint8Array, dimensions: number): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float64Array(dimensions);
  for (let i = 0; i < dimensions; i++) vector[i] = view.getFloat64(i * FLOAT_BYTES, true);
  return vector;
}

/**
 * The vector scaled to length 1. The zero vector (or one so small its squares vanish) stays
 * zero and so scores 0 against everything instead of dividing by zero. A vector whose length
 * overflows has no usable direction and is refused.
 */
function unitOf(vector: Float64Array): Float64Array {
  let squares = 0;
  for (const component of vector) squares += component * component;
  if (!Number.isFinite(squares)) throw new RecallError("non_finite");
  if (squares === 0) return new Float64Array(vector.length);
  const norm = Math.sqrt(squares);
  const unit = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i++) unit[i] = (vector[i] ?? 0) / norm;
  return unit;
}

function similarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Rounding can push a unit-vector dot product a hair past 1.
  return Math.max(-1, Math.min(1, dot));
}

function matches(payload: JsonObject, filter: readonly (readonly [string, JsonValue])[]): boolean {
  // Field names come from callers and content, so only the payload's own fields count: a
  // `constructor` or `toString` filter must not find the prototype's.
  return filter.every(([key, wanted]) => Object.hasOwn(payload, key) && jsonEqual(payload[key], wanted));
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item: JsonValue, i: number) => jsonEqual(item, b[i] as JsonValue | undefined));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && jsonEqual((a as JsonObject)[key], (b as JsonObject)[key]));
}
