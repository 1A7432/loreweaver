// What a reset does to each kind of room data, declared by the data's owner.
//
// The old server kept a private cleanup list in each of reset, restore and import, and the
// lists drifted apart three times in one month (docs/defensive-patterns.md entry 5). Here
// the knowledge sits with the data: a document type declares its lifecycle
// (`core/documents/model.ts`), a room-state key IS its declaration (the store's state
// methods take the key object, never a bare string, so a value nobody declared cannot be
// written), module checkpoints have the one lifecycle below, and an external storage
// declares one when it registers (`storages.ts`). The lifecycle operations ask the
// declarations and keep no list of their own.

import { LifecycleError } from "./errors.ts";

export type ResetScope = "story" | "chars" | "all";

/** The scopes, lightest first. They nest: `story` ⊂ `chars` ⊂ `all`. */
export const RESET_SCOPES: readonly ResetScope[] = ["story", "chars", "all"];

/**
 * What a campaign reset does to a kind of room data — the same shape as
 * `core/documents/model.ts`'s `Lifecycle`, which this layer cannot import. `never` data
 * survives every reset and has to say why, so surviving is a decision, not an omission.
 */
export type Lifecycle =
  | { readonly reset: ResetScope }
  | { readonly reset: "never"; readonly because: string };

export function isResetScope(value: unknown): value is ResetScope {
  return value === "story" || value === "chars" || value === "all";
}

/** Throws `invalid_lifecycle` unless `lifecycle` is well formed. */
export function checkLifecycle(lifecycle: Lifecycle, path: string): void {
  const value: unknown = lifecycle;
  if (typeof value !== "object" || value === null) throw new LifecycleError("invalid_lifecycle", path);
  const reset = (value as { reset?: unknown }).reset;
  if (isResetScope(reset)) return;
  const because = (value as { because?: unknown }).because;
  if (reset === "never" && typeof because === "string" && because.trim() !== "") return;
  throw new LifecycleError("invalid_lifecycle", path);
}

/** Whether a reset of `scope` removes data declared with `lifecycle`. */
export function covers(scope: ResetScope, lifecycle: Lifecycle): boolean {
  if (lifecycle.reset === "never") return false;
  return RESET_SCOPES.indexOf(lifecycle.reset) <= RESET_SCOPES.indexOf(scope);
}

/**
 * Module checkpoints die with the installed world (`all`). A module's saved state is its
 * own machinery, in the same sense as the variable space and the hook store beside it in
 * the reference server (`agent/hook_runtime.py`'s `hook_state` facet: "it dies at exactly
 * the scope that kills the module variables"). A lighter reset keeps the world installed,
 * and a module must then not find its own state reset out of step with that world; a
 * module that wants a fresh session sees the reset (the log restarts at turn 0) and
 * clears what it considers session state itself.
 */
export const MODULE_STATE_LIFECYCLE: Lifecycle = { reset: "all" };

/**
 * One declared room-state key: its name, its lifecycle, and how its value is stored.
 * Made only by `defineStateKey` (or the helpers below); the store refuses any other object
 * at run time, and the type refuses a bare string at compile time.
 */
export interface StateKey<T> {
  readonly name: string;
  readonly lifecycle: Lifecycle;
  /**
   * Present when an undo leaves this key as it is, with the reason: its writes are not
   * journaled, so `undoTo` neither puts back what was there nor removes what was written
   * (see `infra/store.ts`). For values that describe the table's present rather than the
   * story's past — what is playing, the files the room was given — which a rewind of the
   * story must not take back. Absent: an undo rewinds it like any other write.
   */
  readonly keptOnUndo?: string;
  /**
   * Present when the key names something a bundle does not carry, with the reason: a file in
   * the room's media (`lifecycle/bundle.ts`: media is another storage, and an import clears
   * it). `exportRoom` leaves such a key out, and `importRoom` drops it from a bundle that has
   * it — a loaded room must not name a file that is not there, nor one that a later change
   * would remove although it now belongs to something else. Absent: the key travels.
   */
  readonly outsideBundle?: string;
  encode(value: T): string;
  /** The stored text read back; null when it cannot be read as this key's value. */
  decode(text: string): T | null;
}

// Keys made by `defineStateKey`, by identity: an object with the right fields that was not
// made here is still undeclared. A WeakSet, so a key carries no visible brand to forge.
const declared = new WeakSet<object>();
// Every declared key by name, so data read back from storage (a reset walking the stored
// rows, an import naming keys as text) can find its declaration.
const byName = new Map<string, StateKey<unknown>>();

export interface StateKeySpec<T> {
  readonly name: string;
  readonly lifecycle: Lifecycle;
  /** See `StateKey.keptOnUndo`: the reason an undo leaves this key alone. */
  readonly keptOnUndo?: string;
  /** See `StateKey.outsideBundle`: the reason a bundle does not carry this key. */
  readonly outsideBundle?: string;
  readonly encode: (value: T) => string;
  readonly decode: (text: string) => T | null;
}

/**
 * Declare a room-state key. Call once, at module level, in the module that writes it, and
 * export the result. A second declaration of the same name throws `state_key_conflict`:
 * two owners of one key is exactly the drift this replaces.
 */
export function defineStateKey<T>(spec: StateKeySpec<T>): StateKey<T> {
  if (typeof spec.name !== "string" || spec.name === "") throw new LifecycleError("undeclared_state_key", "");
  checkLifecycle(spec.lifecycle, spec.name);
  if (spec.keptOnUndo !== undefined && (typeof spec.keptOnUndo !== "string" || spec.keptOnUndo.trim() === "")) throw new LifecycleError("invalid_lifecycle", spec.name);
  if (spec.outsideBundle !== undefined && (typeof spec.outsideBundle !== "string" || spec.outsideBundle.trim() === "")) throw new LifecycleError("invalid_lifecycle", spec.name);
  if (byName.has(spec.name)) throw new LifecycleError("state_key_conflict", spec.name);
  const key: StateKey<T> = Object.freeze({
    name: spec.name,
    lifecycle: Object.freeze({ ...spec.lifecycle }),
    ...(spec.keptOnUndo === undefined ? {} : { keptOnUndo: spec.keptOnUndo }),
    ...(spec.outsideBundle === undefined ? {} : { outsideBundle: spec.outsideBundle }),
    encode: spec.encode,
    decode: spec.decode,
  });
  declared.add(key);
  byName.set(spec.name, key as StateKey<unknown>);
  return key;
}

/** What a key may say besides its name and lifecycle: see `StateKey`. */
export interface StateKeyOptions {
  readonly keptOnUndo?: string;
  readonly outsideBundle?: string;
}

function optionsOf(options: StateKeyOptions): StateKeyOptions {
  return {
    ...(options.keptOnUndo === undefined ? {} : { keptOnUndo: options.keptOnUndo }),
    ...(options.outsideBundle === undefined ? {} : { outsideBundle: options.outsideBundle }),
  };
}

/** A key whose value is plain text. `options`: see `StateKey`. */
export function textStateKey(name: string, lifecycle: Lifecycle, options: StateKeyOptions = {}): StateKey<string> {
  return defineStateKey({ name, lifecycle, ...optionsOf(options), encode: (value) => value, decode: (text) => text });
}

/** A key whose value is JSON, checked by `guard` when read back. `options`: see `StateKey`. */
export function jsonStateKey<T>(name: string, lifecycle: Lifecycle, guard: (value: unknown) => value is T, options: StateKeyOptions = {}): StateKey<T> {
  return defineStateKey({
    name,
    lifecycle,
    ...optionsOf(options),
    encode: (value) => JSON.stringify(value),
    decode: (text) => {
      try {
        const value: unknown = JSON.parse(text);
        return guard(value) ? value : null;
      } catch {
        return null;
      }
    },
  });
}

/** Throws `undeclared_state_key` unless `key` was made by `defineStateKey`. */
export function assertDeclared(key: StateKey<unknown>): void {
  const value: unknown = key;
  if (typeof value !== "object" || value === null || !declared.has(value)) {
    const name = typeof value === "object" && value !== null ? String((value as { name?: unknown }).name ?? "") : "";
    throw new LifecycleError("undeclared_state_key", name);
  }
}

/** The declaration of a stored key name, if any code declared it. */
export function stateKeyNamed(name: string): StateKey<unknown> | undefined {
  return byName.get(name);
}
