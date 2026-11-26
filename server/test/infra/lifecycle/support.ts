// Shared pieces of the store and lifecycle tests: declared keys of every lifecycle, a
// document catalog, a seeded random source, and a whole-room dump to compare rooms by.
import type { DocumentCatalog } from "../../../src/infra/lifecycle/bundle.ts";
import { stateKeyNamed, textStateKey, type Lifecycle, type StateKey } from "../../../src/infra/lifecycle/declarations.ts";
import { openDatabase, type Database } from "../../../src/infra/runtime/sqlite.ts";
import { Store, type StoreOptions } from "../../../src/infra/store.ts";

// Declared once per process even if this module were evaluated twice: a second
// declaration of a name is (rightly) an error.
function key(name: string, lifecycle: Lifecycle): StateKey<string> {
  return (stateKeyNamed(name) as StateKey<string> | undefined) ?? textStateKey(name, lifecycle);
}

export const STORY_KEY = key("lc_test.story", { reset: "story" });
export const CHARS_KEY = key("lc_test.chars", { reset: "chars" });
export const ALL_KEY = key("lc_test.all", { reset: "all" });
export const NEVER_KEY = key("lc_test.never", { reset: "never", because: "describes the table, not the campaign" });
export const KEYS = [STORY_KEY, CHARS_KEY, ALL_KEY, NEVER_KEY] as const;

export const TYPE_LIFECYCLES = new Map<string, Lifecycle>([
  ["note", { reset: "story" }],
  ["sheet", { reset: "chars" }],
  ["lore", { reset: "all" }],
  ["habit", { reset: "never", because: "how this table plays" }],
]);

export const CATALOG: DocumentCatalog = { lifecycleOf: (type) => TYPE_LIFECYCLES.get(type) };

export function memoryStore(options: StoreOptions = {}): { store: Store; db: Database } {
  const db = openDatabase(":memory:");
  return { store: new Store(db, options), db };
}

/** A seeded random source (mulberry32), so a failing sequence can be replayed. */
export function random(seed: number): { next: () => number; int: (n: number) => number; pick: <T>(items: readonly T[]) => T } {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return { next, int, pick: (items) => items[int(items.length)] as (typeof items)[number] };
}

/**
 * The whole visible room: documents in their order (positions compared as order, not as
 * numbers — a removed document leaves a hole), state, module checkpoints, and the log
 * without its sequence numbers (an undo leaves holes there too).
 */
export function dump(store: Store, room: string) {
  return {
    documents: store.docList(room).map((row) => [row.type, row.id, row.version, row.data, row.meta]),
    state: [...store.stateList(room)].sort(),
    modules: [...store.moduleStates(room)].map(([module, snapshot]) => [module, JSON.stringify(snapshot)]).sort(),
    events: store.eventsAfter(room, 0, 1_000_000).map((event) => [event.id, event.kind, event.turn ?? null, JSON.stringify(event.data)]),
  };
}

export function journalRows(db: Database, room: string): number {
  return db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE room = ?").get(room)?.n ?? 0;
}
