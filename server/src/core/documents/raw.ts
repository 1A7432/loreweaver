// Documents as stored: reading whole payloads and writing them back. Only the code that
// DEFINES a document type's meaning (`core/`) and the Keeper's tools (`agent/`) import
// this file; everything that sends content outward goes through `views.ts` instead, so
// a whole payload cannot reach a connection by oversight. The import-rule test holds
// that line.
//
// Writes take a `RoomWriter` (`infra/store.ts`), never a bare room id: the writer carries
// the room, its generation and the turn the write belongs to, so a document write from a
// lane whose room has since been undone, reset or replaced is refused (`StaleGeneration`),
// and every write lands in the undo journal under its own turn.
import type { DocumentCatalog } from "../../infra/lifecycle/bundle.ts";
import type { DocumentRow, RoomWriter, Store } from "../../infra/store.ts";
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
  put(writer: RoomWriter, type: string, id: string, data: JsonObject, meta: JsonObject = {}): Document {
    const definition = this.#types.get(type);
    const violations = definition.validate?.(data) ?? [];
    if (violations.length > 0) throw new DocumentRefused(type, violations);
    writer.docPut(type, id, definition.version, JSON.stringify(data), JSON.stringify(meta));
    return { type, id, version: definition.version, data, meta, corrupt: false };
  }

  /** Whether there was a document to delete. */
  delete(writer: RoomWriter, type: string, id: string): boolean {
    return writer.docDelete(type, id);
  }

  /** Delete every document of one type; returns how many went. */
  deleteType(writer: RoomWriter, type: string): number {
    return writer.docDeleteType(type);
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

/**
 * What the store's reset and import need to know about document types: each type's
 * declared lifecycle, and on import the type's own payload check. A stored type the
 * registry does not know has no lifecycle, and the store refuses to guess one. A payload
 * that cannot be read at all is carried as it is: the room it came from held it that way
 * (`Document.corrupt`), and an export → import round trip must not turn damage into a
 * refusal to load the rest of the room. A readable payload the type rejects, or one
 * written by a newer version of the type, is refused.
 */
export function documentCatalog(types: DocumentTypes): DocumentCatalog {
  const known = (type: string): boolean => types.names().includes(type);
  return {
    lifecycleOf: (type) => (known(type) ? types.get(type).lifecycle : undefined),
    check: (type, version, data) => {
      const definition = types.get(type);
      if (version > definition.version) return "version_ahead";
      const payload = parseObject(data);
      if (payload === null) return null;
      const current = version < definition.version && definition.migrate ? definition.migrate(payload, version) : payload;
      const violations = definition.validate?.(current) ?? [];
      return violations.length > 0 ? (violations[0] as WriteViolation).code : null;
    },
  };
}
