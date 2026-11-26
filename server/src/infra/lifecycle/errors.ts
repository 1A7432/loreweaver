// The errors of room writes and the room lifecycle. Callers branch on `code`; nothing in
// a message is part of the contract, and no message carries room content — only names
// and numbers — so every one of them is safe to log.

/**
 * A write from a past generation of the room. Every write goes through a writer bound to
 * the room's generation (`epoch`) when the writer was made; undo, reset, import and delete
 * move the generation on, after which that writer refuses everything. This is how a
 * background lane that was still computing for the old room is kept out of the new one:
 * it is not cancelled and waited for, it simply cannot commit.
 */
export class StaleGeneration extends Error {
  readonly code = "stale_generation";
  readonly room: string;
  /** The generation the writer was bound to. */
  readonly expected: number;
  /** The room's generation now. */
  readonly current: number;

  constructor(room: string, expected: number, current: number) {
    super(`stale_generation room=${room} expected=${expected} current=${current}`);
    this.name = "StaleGeneration";
    this.room = room;
    this.expected = expected;
    this.current = current;
  }
}

export type LifecycleErrorCode =
  /** `undoTo` named a turn that is not before the room's current one (or not a turn at all). */
  | "undo_out_of_range"
  /** `undoTo` reaches further back than the journal keeps (the undo depth, or a reset/import). */
  | "undo_beyond_depth"
  /** A writer asked for a turn the room has not begun, or a turn that is not a whole number. */
  | "turn_out_of_range"
  /** An event drafted for one turn handed to the writer of another. */
  | "event_turn_mismatch"
  /** A room-state key that was not made by `defineStateKey` (or a stored key no code declares). */
  | "undeclared_state_key"
  /** Two declarations of one room-state key name. */
  | "state_key_conflict"
  /** A stored or imported document whose type has no declared lifecycle. */
  | "undeclared_document_type"
  /** A reset scope that is not one of `story`, `chars`, `all`. */
  | "invalid_scope"
  /** A lifecycle declaration that is malformed (`never` without a reason, an unknown scope). */
  | "invalid_lifecycle"
  /** An import bundle that is not one this store can load; `path` says where. */
  | "invalid_bundle"
  /** Two room storages registered under one name. */
  | "storage_conflict"
  /** The database holds tables of another store schema. */
  | "store_schema_mismatch"
  /** A store setting that is out of range (the undo depth). */
  | "invalid_settings";

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  /** Where the problem is: a bundle path (`documents[3].type`), a key name, a type name. */
  readonly path: string;

  constructor(code: LifecycleErrorCode, path = "") {
    super(path === "" ? code : `${code} at ${path}`);
    this.name = "LifecycleError";
    this.code = code;
    this.path = path;
  }
}
