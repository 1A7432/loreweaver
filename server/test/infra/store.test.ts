import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineStateKey, textStateKey, type StateKey } from "../../src/infra/lifecycle/declarations.ts";
import { LifecycleError, StaleGeneration } from "../../src/infra/lifecycle/errors.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { Store, type RoomWriter } from "../../src/infra/store.ts";
import { CATALOG, dump, memoryStore, STORY_KEY } from "./lifecycle/support.ts";

function store(): Store {
  return memoryStore().store;
}

function line(text: string, n: number) {
  return { id: `e${n}`, ts: n, kind: "narrative", data: { text } };
}

function code(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof LifecycleError || error instanceof StaleGeneration) return error.code;
    throw error;
  }
  return "no error";
}

function seqs(s: Store, room: string): number[] {
  return s.eventsAfter(room, 0, 100).map((event) => event.seq);
}

test("events are numbered per room from 1 and come back as they were stored", () => {
  const s = store();
  expect(s.room("a")).toEqual({ epoch: 1, head: 0, turn: 0 });
  const w = s.writer("a");
  expect(w.appendEvent(line("one", 1)).seq).toBe(1);
  const t = s.beginTurn("a");
  expect(t.appendEvent({ ...line("two", 2), turn: 1 })).toEqual({ seq: 2, id: "e2", ts: 2, kind: "narrative", turn: 1, data: { text: "two" } });
  expect(s.writer("b").appendEvent(line("other room", 3)).seq).toBe(1);
  expect(s.room("a")).toEqual({ epoch: 1, head: 2, turn: 1 });
  expect(seqs(s, "a")).toEqual([1, 2]);
  expect(s.eventsAfter("a", 1, 10)).toEqual([{ seq: 2, id: "e2", ts: 2, kind: "narrative", turn: 1, data: { text: "two" } }]);
});

test("a page of history is the entries just before a position, oldest first", () => {
  const s = store();
  const w = s.writer("a");
  for (let n = 1; n <= 5; n++) w.appendEvent(line(`#${n}`, n));
  expect(s.eventsBefore("a", 5, 2).map((event) => event.seq)).toEqual([3, 4]);
  expect(s.eventsBefore("a", 2, 10).map((event) => event.seq)).toEqual([1]);
});

test("module state is kept per room and module, and a module id is never read off a prototype", () => {
  const s = store();
  const w = s.writer("a");
  w.setModuleState("counter", { turns: 1 });
  w.setModuleState("counter", { turns: 2 });
  w.setModuleState("constructor", ["x"]);
  expect(s.moduleStates("a")).toEqual(new Map<string, unknown>([["constructor", ["x"]], ["counter", { turns: 2 }]]));
  expect(s.moduleStates("b").size).toBe(0);
});

test("a writer refuses a turn the room has not begun, and an event of another turn", () => {
  const s = store();
  expect(code(() => s.writer("a", 1))).toBe("turn_out_of_range");
  expect(code(() => s.writer("a", -1))).toBe("turn_out_of_range");
  expect(code(() => s.writer("a", 0.5))).toBe("turn_out_of_range");
  s.beginTurn("a");
  const w = s.beginTurn("a");
  expect(w.turn).toBe(2);
  expect(code(() => w.appendEvent({ ...line("x", 1), turn: 1 }))).toBe("event_turn_mismatch");
  expect(s.writer("a", 1).appendEvent({ ...line("late", 1), turn: 1 }).turn).toBe(1);
});

test("a writer of a past generation refuses every kind of write, and nothing lands", () => {
  const s = store();
  s.beginTurn("a");
  const old = s.beginTurn("a");
  old.docPut("note", "n", 1, "{}", "{}");
  s.undoTo("a", 1);
  const before = dump(s, "a");
  expect(old.current()).toBe(false);
  const writes: ((w: RoomWriter) => unknown)[] = [
    (w) => w.appendEvent(line("late", 1)),
    (w) => w.docPut("note", "late", 1, "{}", "{}"),
    (w) => w.docDelete("note", "n"),
    (w) => w.docDeleteType("note"),
    (w) => w.statePut(STORY_KEY, "late"),
    (w) => w.stateDelete(STORY_KEY),
    (w) => w.setModuleState("m", 1),
  ];
  for (const write of writes) {
    let caught: unknown = null;
    try {
      write(old);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StaleGeneration);
    expect(caught).toMatchObject({ code: "stale_generation", room: "a", expected: 1, current: 2 });
  }
  expect(dump(s, "a")).toEqual(before);
  expect(s.room("a").head).toBe(0);
});

test("a stale writer is refused after each generation move: undo, reset, import, delete", () => {
  const s = store();
  const exported = s.exportRoom("other");
  const operations: (() => unknown)[] = [
    () => s.undoTo("a", s.room("a").turn - 1),
    () => s.reset("a", "story", CATALOG),
    () => s.importRoom("a", exported, CATALOG),
    () => s.deleteRoom("a"),
  ];
  for (const operation of operations) {
    s.beginTurn("a");
    const w = s.beginTurn("a");
    expect(w.current()).toBe(true);
    operation();
    expect(w.current()).toBe(false);
    expect(code(() => w.statePut(STORY_KEY, "x"))).toBe("stale_generation");
    expect(s.stateGet("a", STORY_KEY)).toBeNull();
  }
});

test("a mid-turn generation move refuses the rest of the turn's writes, keeping what landed before", () => {
  const s = store();
  const w = s.beginTurn("a");
  w.statePut(STORY_KEY, "before");
  const fresh = s.importRoom("a", { ...s.exportRoom("a"), turn: 1 }, CATALOG);
  expect(code(() => w.statePut(STORY_KEY, "after"))).toBe("stale_generation");
  expect(s.stateGet("a", STORY_KEY)).toBe("before");
  expect(fresh.epoch).toBe(2);
});

test("room state takes only declared keys: a bare string does not compile, a forged key is refused", () => {
  const s = store();
  const w = s.writer("a");
  // Compile-time half: never called, only type-checked by `tsc` in `bun run check`.
  const typeLevel = (): void => {
    // @ts-expect-error — the state methods take a declared key object, never a name.
    w.statePut("lc_test.story", "x");
    // @ts-expect-error — the same for deletes and reads.
    w.stateDelete("lc_test.story");
    // @ts-expect-error — reads too.
    s.stateGet("a", "lc_test.story");
    // @ts-expect-error — and a value of the wrong type for the key.
    w.statePut(STORY_KEY, 3);
  };
  expect(typeof typeLevel).toBe("function");
  const forged: StateKey<string> = { name: "forged", lifecycle: { reset: "story" }, encode: (value) => value, decode: (text) => text };
  expect(code(() => w.statePut(forged, "x"))).toBe("undeclared_state_key");
  expect(code(() => w.stateDelete(forged))).toBe("undeclared_state_key");
  // A copy of a declared key is not the declaration either.
  expect(code(() => w.statePut({ ...STORY_KEY }, "x"))).toBe("undeclared_state_key");
  expect(s.stateList("a").size).toBe(0);
  w.statePut(STORY_KEY, "ok");
  expect(s.stateGet("a", STORY_KEY)).toBe("ok");
});

test("a key is declared once, with a well-formed lifecycle", () => {
  textStateKey("store_test.once", { reset: "story" });
  expect(code(() => textStateKey("store_test.once", { reset: "all" }))).toBe("state_key_conflict");
  expect(code(() => textStateKey("store_test.no_reason", { reset: "never", because: " " }))).toBe("invalid_lifecycle");
  expect(code(() => textStateKey("store_test.bad_scope", { reset: "session" } as never))).toBe("invalid_lifecycle");
  const counter = defineStateKey<number>({
    name: "store_test.counter",
    lifecycle: { reset: "story" },
    encode: (value) => String(value),
    decode: (text) => (/^\d+$/.test(text) ? Number(text) : null),
  });
  const s = store();
  s.writer("a").statePut(counter, 41);
  expect(s.stateGet("a", counter)).toBe(41);
});

test("the store refuses an undo depth below one, and a database of an older layout", () => {
  expect(code(() => new Store(openDatabase(":memory:"), { undoDepth: 0 }))).toBe("invalid_settings");
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE rooms (room TEXT PRIMARY KEY, epoch INTEGER NOT NULL, head INTEGER NOT NULL) STRICT");
  expect(code(() => new Store(db))).toBe("store_schema_mismatch");
});

test("an on-disk store reopens with its rooms, turns and undo journal intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-store-"));
  try {
    const path = join(dir, "store.db");
    const first = new Store(openDatabase(path));
    first.writer("a").docPut("lore", "world", 1, '{"v":0}', "{}");
    const t1 = first.beginTurn("a");
    t1.statePut(STORY_KEY, "one");
    t1.appendEvent({ ...line("one", 1), turn: 1 });
    const t2 = first.beginTurn("a");
    t2.statePut(STORY_KEY, "two");
    t2.docPut("lore", "world", 1, '{"v":2}', "{}");
    t2.appendEvent({ ...line("two", 2), turn: 2 });
    first.close();

    const second = new Store(openDatabase(path));
    expect(second.room("a")).toEqual({ epoch: 1, head: 2, turn: 2 });
    const undone = second.undoTo("a", 1);
    expect(undone).toMatchObject({ epoch: 2, head: 2, turn: 1, removedTurns: [2] });
    expect(second.stateGet("a", STORY_KEY)).toBe("one");
    expect(second.docGet("a", "lore", "world")?.data).toBe('{"v":0}');
    expect(seqs(second, "a")).toEqual([1]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
