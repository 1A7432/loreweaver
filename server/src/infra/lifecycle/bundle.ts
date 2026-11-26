// A room as a plain value: what `exportRoom` produces and `importRoom` loads.
//
// A bundle is the room's CONTENT — documents, declared room state, module checkpoints, the
// visible event log, and the turn counter the log's turn numbers continue from. It is not
// the undo journal (an imported room starts a new life with nothing to undo into), not the
// room's generation or sequence numbers (those belong to the room it is loaded into), and
// not media or vectors (other storages; see `storages.ts`). It holds nothing the room does
// not already hold. Document payloads and module checkpoints travel as the stored text, so
// a round trip is exact — including a payload the document layer could not read.
//
// `parseBundle` validates the WHOLE value before the store touches anything: a bundle is
// either loaded entirely or refused with the first problem's path.

import { stateKeyNamed, type Lifecycle } from "./declarations.ts";
import { LifecycleError } from "./errors.ts";

export const ROOM_BUNDLE_FORMAT = "loreweaver-room";
export const ROOM_BUNDLE_VERSION = 1;

export interface BundleDocument {
  readonly type: string;
  readonly id: string;
  readonly version: number;
  /** The stored payload text. */
  readonly data: string;
  readonly meta: string;
}

export interface BundleState {
  readonly key: string;
  readonly value: string;
}

export interface BundleModule {
  readonly module: string;
  /** The stored checkpoint, JSON text. */
  readonly snapshot: string;
}

export interface BundleEvent {
  readonly id: string;
  readonly ts: number;
  readonly kind: string;
  readonly turn?: number;
  readonly data: unknown;
}

export interface RoomBundle {
  readonly format: typeof ROOM_BUNDLE_FORMAT;
  readonly version: typeof ROOM_BUNDLE_VERSION;
  /** The room's turn counter; every event's turn is at most this. */
  readonly turn: number;
  /** In the order they were first written. */
  readonly documents: readonly BundleDocument[];
  readonly state: readonly BundleState[];
  readonly modules: readonly BundleModule[];
  /** The visible log, oldest first. */
  readonly events: readonly BundleEvent[];
}

/**
 * What the store needs to know about document types, which it cannot import: the type
 * registry is `core/documents`. `core/documents/raw.ts` builds one from `DocumentTypes`.
 */
export interface DocumentCatalog {
  /** The type's declared lifecycle; undefined for a type this server does not know. */
  lifecycleOf(type: string): Lifecycle | undefined;
  /**
   * A deeper check of one imported document, by its type's own rules. Returns a problem
   * code, or null when the document is acceptable.
   */
  check?(type: string, version: number, data: string): string | null;
}

const MAX_JSON_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain JSON: what survives `JSON.stringify` → `JSON.parse` unchanged. */
function isJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => isJson(item, depth + 1));
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function fail(path: string): never {
  throw new LifecycleError("invalid_bundle", path);
}

function text(value: unknown, path: string, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value === "")) fail(path);
  return value;
}

function count(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(path);
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path);
  return value;
}

/** Validate `value` as a bundle, fully. Throws `invalid_bundle` (or `undeclared_*`) with a path. */
export function parseBundle(value: unknown, catalog: DocumentCatalog): RoomBundle {
  if (!isRecord(value)) fail("");
  if (value.format !== ROOM_BUNDLE_FORMAT) fail("format");
  if (value.version !== ROOM_BUNDLE_VERSION) fail("version");
  const turn = count(value.turn, "turn", 0);

  const documents: BundleDocument[] = [];
  const seenDocuments = new Set<string>();
  list(value.documents, "documents").forEach((entry, index) => {
    const path = `documents[${index}]`;
    if (!isRecord(entry)) fail(path);
    const type = text(entry.type, `${path}.type`);
    const id = text(entry.id, `${path}.id`);
    const version = count(entry.version, `${path}.version`, 1);
    const data = text(entry.data, `${path}.data`, false);
    const meta = text(entry.meta, `${path}.meta`, false);
    if (catalog.lifecycleOf(type) === undefined) throw new LifecycleError("undeclared_document_type", `${path}.type`);
    // JSON.stringify of the pair cannot collide the way "type/id" could.
    const identity = JSON.stringify([type, id]);
    if (seenDocuments.has(identity)) fail(`${path}.id`);
    seenDocuments.add(identity);
    const problem = catalog.check?.(type, version, data) ?? null;
    if (problem !== null) fail(`${path}.data`);
    documents.push({ type, id, version, data, meta });
  });

  const state: BundleState[] = [];
  const seenKeys = new Set<string>();
  list(value.state, "state").forEach((entry, index) => {
    const path = `state[${index}]`;
    if (!isRecord(entry)) fail(path);
    const key = text(entry.key, `${path}.key`);
    const stored = text(entry.value, `${path}.value`, false);
    if (stateKeyNamed(key) === undefined) throw new LifecycleError("undeclared_state_key", `${path}.key`);
    if (seenKeys.has(key)) fail(`${path}.key`);
    seenKeys.add(key);
    state.push({ key, value: stored });
  });

  const modules: BundleModule[] = [];
  const seenModules = new Set<string>();
  list(value.modules, "modules").forEach((entry, index) => {
    const path = `modules[${index}]`;
    if (!isRecord(entry)) fail(path);
    const module = text(entry.module, `${path}.module`);
    const snapshot = text(entry.snapshot, `${path}.snapshot`, false);
    if (!isJsonText(snapshot)) fail(`${path}.snapshot`);
    if (seenModules.has(module)) fail(`${path}.module`);
    seenModules.add(module);
    modules.push({ module, snapshot });
  });

  const events: BundleEvent[] = [];
  list(value.events, "events").forEach((entry, index) => {
    const path = `events[${index}]`;
    if (!isRecord(entry)) fail(path);
    const id = text(entry.id, `${path}.id`);
    const ts = count(entry.ts, `${path}.ts`, 0);
    const kind = text(entry.kind, `${path}.kind`);
    if (!("data" in entry) || !isJson(entry.data)) fail(`${path}.data`);
    const event = { id, ts, kind, data: entry.data };
    if (entry.turn === undefined) {
      events.push(event);
    } else {
      const eventTurn = count(entry.turn, `${path}.turn`, 0);
      if (eventTurn > turn) fail(`${path}.turn`);
      events.push({ ...event, turn: eventTurn });
    }
  });

  return { format: ROOM_BUNDLE_FORMAT, version: ROOM_BUNDLE_VERSION, turn, documents, state, modules, events };
}
