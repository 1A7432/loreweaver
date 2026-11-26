// Documents as stored: reading whole payloads and writing them back. Only the code that
// DEFINES a document type's meaning (`core/`) and the Keeper's tools (`agent/`) import
// this file; everything that sends content outward goes through `views.ts` instead, so
// a whole payload cannot reach a connection by oversight. The import-rule test holds
// that line.
import type { DocumentRow, Store } from "../../infra/store.ts";
import type { Document, DocumentTypes, JsonObject, WriteViolation } from "./model.ts";

export class DocumentRefused extends Error {
  readonly type: string;
  readonly violations: readonly WriteViolation[];

  constructor(type: string, violations: readonly WriteViolation[]) {
    super(`document type ${type} refused the write: ${violations.map((entry) => `${entry.code} at ${entry.path}`).join("; ")}`);
    this.name = "DocumentRefused";
    this.type = type;
    this.violations = violations;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export class RawDocuments {
  readonly #store: Store;
  readonly #types: DocumentTypes;

  constructor(store: Store, types: DocumentTypes) {
    this.#store = store;
    this.#types = types;
  }

  get(room: string, type: string, id: string): Document | null {
    const row = this.#store.docGet(room, type, id);
    return row === null ? null : this.#read(row);
  }

  /** A room's documents of one type, in the order they were first written. */
  list(room: string, type: string): Document[] {
    return this.#store.docList(room, type).map((row) => this.#read(row));
  }

  /** Every document of the room, for export and snapshots. */
  all(room: string): Document[] {
    return this.#store.docList(room).map((row) => this.#read(row));
  }

  /**
   * Store a payload at the type's current version. Throws `DocumentRefused` when the
   * type's own validation rejects it — nothing is written then.
   */
  put(room: string, type: string, id: string, data: JsonObject, meta: JsonObject = {}): Document {
    const definition = this.#types.get(type);
    const violations = definition.validate?.(data) ?? [];
    if (violations.length > 0) throw new DocumentRefused(type, violations);
    this.#store.docPut(room, type, id, definition.version, JSON.stringify(data), JSON.stringify(meta));
    return { type, id, version: definition.version, data, meta, corrupt: false };
  }

  delete(room: string, type: string, id: string): void {
    this.#store.docDelete(room, type, id);
  }

  deleteType(room: string, type: string): void {
    this.#store.docDeleteType(room, type);
  }

  deleteRoom(room: string): void {
    this.#store.docDeleteRoom(room);
  }

  #read(row: DocumentRow): Document {
    const data = parseObject(row.data);
    const meta = parseObject(row.meta) ?? {};
    if (data === null) return { type: row.type, id: row.id, version: row.version, data: {}, meta, corrupt: true };
    const definition = this.#types.get(row.type);
    if (row.version < definition.version && definition.migrate) {
      return { type: row.type, id: row.id, version: definition.version, data: definition.migrate(data, row.version), meta, corrupt: false };
    }
    return { type: row.type, id: row.id, version: row.version, data, meta, corrupt: false };
  }
}
