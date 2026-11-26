import { describe, expect, test } from "bun:test";

import { LifecycleError } from "../../src/infra/lifecycle/errors.ts";
import { Store, type RoomWriter } from "../../src/infra/store.ts";
import { dump, journalRows, KEYS, memoryStore, random, STORY_KEY } from "./lifecycle/support.ts";

const ROOM = "r";

function code(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof LifecycleError || (error instanceof Error && "code" in error)) return String((error as { code: unknown }).code);
    throw error;
  }
  return "no error";
}

function event(id: string, turn?: number) {
  const draft = { id, ts: 1, kind: "narrative", data: { id } };
  return turn === undefined ? draft : { ...draft, turn };
}

function visible(s: Store): [string, number | null][] {
  return s.eventsAfter(ROOM, 0, 1000).map((entry) => [entry.id, entry.turn ?? null]);
}

// --- the property: undoTo(M) is the room as if no turn after M had written -------------

type Op =
  | { readonly op: "docPut"; readonly type: string; readonly id: string; readonly version: number; readonly data: string }
  | { readonly op: "docDelete"; readonly type: string; readonly id: string }
  | { readonly op: "docDeleteType"; readonly type: string; readonly found: readonly string[] }
  | { readonly op: "statePut"; readonly key: number; readonly value: string }
  | { readonly op: "stateDelete"; readonly key: number }
  | { readonly op: "module"; readonly module: string; readonly value: number }
  | { readonly op: "event"; readonly id: string };

interface Done {
  readonly turn: number;
  readonly op: Op;
}

function perform(writer: RoomWriter, op: Op, replay = false): void {
  switch (op.op) {
    case "docPut":
      writer.docPut(op.type, op.id, op.version, op.data, JSON.stringify({ by: writer.turn }));
      return;
    case "docDelete":
      writer.docDelete(op.type, op.id);
      return;
    case "docDeleteType":
      // Live, the whole type; replayed, exactly the documents it found (see `docDeleteType`).
      if (replay) for (const id of op.found) writer.docDelete(op.type, id);
      else expect(writer.docDeleteType(op.type)).toBe(op.found.length);
      return;
    case "statePut":
      writer.statePut(KEYS[op.key] ?? STORY_KEY, op.value);
      return;
    case "stateDelete":
      writer.stateDelete(KEYS[op.key] ?? STORY_KEY);
      return;
    case "module":
      writer.setModuleState(op.module, { value: op.value });
      return;
    case "event":
      writer.appendEvent(event(op.id, writer.turn));
      return;
  }
}

/** The room built from scratch by the surviving writes alone, in the order they happened. */
function reference(history: readonly Done[]): ReturnType<typeof dump> {
  const { store } = memoryStore();
  const top = history.reduce((max, done) => Math.max(max, done.turn), 0);
  for (let turn = 1; turn <= top; turn++) store.beginTurn(ROOM);
  for (const done of history) perform(store.writer(ROOM, done.turn), done.op, true);
  return dump(store, ROOM);
}

function randomOp(rand: ReturnType<typeof random>, step: number, live: Store): Op {
  const type = rand.pick(["note", "sheet"]);
  const id = rand.pick(["a", "b", "c", "d"]);
  const roll = rand.next();
  if (roll < 0.3) return { op: "docPut", type, id, version: 1 + rand.int(2), data: JSON.stringify({ step }) };
  if (roll < 0.4) return { op: "docDelete", type, id };
  if (roll < 0.43) return { op: "docDeleteType", type, found: live.docList(ROOM, type).map((row) => row.id) };
  if (roll < 0.63) return { op: "statePut", key: rand.int(KEYS.length), value: `v${step}` };
  if (roll < 0.7) return { op: "stateDelete", key: rand.int(KEYS.length) };
  if (roll < 0.85) return { op: "module", module: rand.pick(["m1", "m2"]), value: step };
  return { op: "event", id: `ev${step}` };
}

function runSequence(seed: number): { undos: number; refusals: number; stale: number } {
  const rand = random(seed);
  const depth = 1 + rand.int(5);
  const { store } = memoryStore({ undoDepth: depth });
  let history: Done[] = [];
  // Writers the current generation handed out, by turn: the live turn and late lanes.
  let live = new Map<number, RoomWriter>([[0, store.writer(ROOM)]]);
  const stale: RoomWriter[] = [];
  const counts = { undos: 0, refusals: 0, stale: 0 };

  for (let step = 0; step < 220; step++) {
    const roll = rand.next();
    const turn = store.room(ROOM).turn;
    if (roll < 0.14) {
      const writer = store.beginTurn(ROOM);
      live.set(writer.turn, writer);
    } else if (roll < 0.8) {
      // Mostly the live turn; sometimes a late lane of an earlier turn of this generation.
      const lane = rand.next() < 0.7 ? turn : rand.int(turn + 1);
      const writer = live.get(lane) ?? store.writer(ROOM, lane);
      live.set(lane, writer);
      const op = randomOp(rand, step, store);
      perform(writer, op);
      history.push({ turn: lane, op });
    } else if (roll < 0.86 && stale.length > 0) {
      const before = dump(store, ROOM);
      const writer = rand.pick(stale);
      expect(code(() => perform(writer, randomOp(rand, step, store)))).toBe("stale_generation");
      expect(dump(store, ROOM)).toEqual(before);
      counts.stale += 1;
    } else if (turn > 0) {
      const floor = store.undoFloor(ROOM);
      const to = rand.next() < 0.15 || floor >= turn ? floor - 1 - rand.int(2) : floor + rand.int(turn - floor);
      if (to < floor) {
        const before = dump(store, ROOM);
        expect(code(() => store.undoTo(ROOM, to))).toBe(to < 0 ? "undo_out_of_range" : "undo_beyond_depth");
        expect(dump(store, ROOM)).toEqual(before);
        counts.refusals += 1;
        continue;
      }
      history = history.filter((done) => done.turn <= to);
      const result = store.undoTo(ROOM, to);
      expect(result.turn).toBe(to);
      expect(result.removedTurns).toEqual(Array.from({ length: turn - to }, (_, index) => to + 1 + index));
      expect(dump(store, ROOM)).toEqual(reference(history));
      stale.push(...live.values());
      live = new Map();
      counts.undos += 1;
    }
  }
  expect(dump(store, ROOM)).toEqual(reference(history));
  return counts;
}

describe("undo, as a property", () => {
  test("random writes across turns, late lanes and stale writers: every undo yields the room as of the end of that turn", () => {
    const totals = { undos: 0, refusals: 0, stale: 0 };
    for (let seed = 1; seed <= 80; seed++) {
      const counts = runSequence(seed);
      totals.undos += counts.undos;
      totals.refusals += counts.refusals;
      totals.stale += counts.stale;
    }
    // The run exercised what it claims to.
    expect(totals.undos).toBeGreaterThan(150);
    expect(totals.refusals).toBeGreaterThan(10);
    expect(totals.stale).toBeGreaterThan(50);
  });
});

// --- the cases the reference server paid for ------------------------------------------

describe("undo: the recorded failure cases", () => {
  test("a late lane of turn M that lands after turn M+1 began belongs to M: undoing M+1 keeps it, undoing M removes it", () => {
    const { store } = memoryStore();
    store.beginTurn(ROOM);
    const lane = store.beginTurn(ROOM); // turn 2's background pass, scheduled now
    lane.statePut(STORY_KEY, "turn 2 main");
    const next = store.beginTurn(ROOM);
    next.statePut(STORY_KEY, "turn 3");
    lane.statePut(STORY_KEY, "turn 2 late pass"); // finishes after turn 3 wrote the same key
    lane.docPut("note", "whisper", 1, '{"t":2}', "{}");
    lane.appendEvent(event("late", 2));

    store.undoTo(ROOM, 2);
    expect(store.stateGet(ROOM, STORY_KEY)).toBe("turn 2 late pass");
    expect(store.docGet(ROOM, "note", "whisper")?.data).toBe('{"t":2}');
    expect(visible(store)).toEqual([["late", 2]]);

    store.undoTo(ROOM, 1);
    expect(store.stateGet(ROOM, STORY_KEY)).toBeNull();
    expect(store.docGet(ROOM, "note", "whisper")).toBeNull();
  });

  test("a late pass cannot write into the room an undo restored", () => {
    const { store } = memoryStore();
    store.beginTurn(ROOM);
    const pass = store.beginTurn(ROOM);
    store.undoTo(ROOM, 1);
    expect(code(() => pass.docPut("note", "late", 1, "{}", "{}"))).toBe("stale_generation");
    expect(store.docList(ROOM)).toEqual([]);
  });

  test("a failed turn's writes stay its own: undoing it removes them, and the previous turn is untouched", () => {
    const { store } = memoryStore();
    const one = store.beginTurn(ROOM);
    one.statePut(STORY_KEY, "one");
    one.docPut("note", "n", 1, '{"one":1}', "{}");
    // Turn 2 writes, then the provider dies: no event, no reply — the writes still belong
    // to turn 2, never to turn 1's boundary.
    const failed = store.beginTurn(ROOM);
    failed.statePut(STORY_KEY, "hook wrote this");
    failed.docPut("note", "n", 1, '{"half":2}', "{}");
    failed.docPut("note", "tool", 1, "{}", "{}");
    store.undoTo(ROOM, 1);
    expect(store.stateGet(ROOM, STORY_KEY)).toBe("one");
    expect(store.docList(ROOM).map((row) => [row.id, row.data])).toEqual([["n", '{"one":1}']]);
    // A further undo still reaches the state before turn 1.
    store.undoTo(ROOM, 0);
    expect(dump(store, ROOM)).toEqual(dump(memoryStore().store, ROOM));
  });

  test("a document deleted and restored keeps its place; one created by an undone turn leaves no trace", () => {
    const { store } = memoryStore();
    const setup = store.writer(ROOM);
    for (const id of ["a", "b", "c"]) setup.docPut("note", id, 1, `"${id}"`, "{}");
    const one = store.beginTurn(ROOM);
    one.docDelete("note", "b");
    one.docPut("note", "d", 1, '"d"', "{}");
    one.docPut("note", "b", 1, '"b again"', "{}"); // re-created: now last
    expect(store.docList(ROOM, "note").map((row) => row.id)).toEqual(["a", "c", "d", "b"]);
    store.undoTo(ROOM, 0);
    expect(store.docList(ROOM, "note").map((row) => [row.id, row.data])).toEqual([["a", '"a"'], ["b", '"b"'], ["c", '"c"']]);
    // A new document still goes last.
    store.writer(ROOM).docPut("note", "e", 1, '"e"', "{}");
    expect(store.docList(ROOM, "note").map((row) => row.id)).toEqual(["a", "b", "c", "e"]);
  });

  test("undo reports the module checkpoints that changed, so the caller reloads the worker", () => {
    const { store } = memoryStore();
    store.writer(ROOM).setModuleState("clock", { t: 0 });
    const one = store.beginTurn(ROOM);
    one.setModuleState("clock", { t: 1 });
    one.setModuleState("dice", { n: 1 });
    one.setModuleState("echo", { same: true });
    one.setModuleState("echo", { same: true });
    const two = store.beginTurn(ROOM);
    two.setModuleState("clock", { t: 1 }); // rewritten to the same value
    expect(store.undoTo(ROOM, 1).modulesChanged).toEqual([]);
    expect(store.undoTo(ROOM, 0).modulesChanged).toEqual(["clock", "dice", "echo"]);
    expect(store.moduleStates(ROOM)).toEqual(new Map([["clock", { t: 0 }]]));
  });
});

describe("undo: depth and the journal", () => {
  test("undo reaches back exactly `depth` turns; further is refused with a code and changes nothing", () => {
    const { store } = memoryStore({ undoDepth: 2 });
    for (let turn = 1; turn <= 5; turn++) store.beginTurn(ROOM).statePut(STORY_KEY, `t${turn}`);
    expect(store.undoFloor(ROOM)).toBe(3);
    const before = dump(store, ROOM);
    expect(code(() => store.undoTo(ROOM, 2))).toBe("undo_beyond_depth");
    expect(code(() => store.undoTo(ROOM, 5))).toBe("undo_out_of_range");
    expect(code(() => store.undoTo(ROOM, -1))).toBe("undo_out_of_range");
    expect(code(() => store.undoTo(ROOM, 3.5))).toBe("undo_out_of_range");
    expect(dump(store, ROOM)).toEqual(before);
    expect(store.room(ROOM).epoch).toBe(1);
    store.undoTo(ROOM, 3);
    expect(store.stateGet(ROOM, STORY_KEY)).toBe("t3");
    // Undoing does not reopen turns the window already closed.
    expect(code(() => store.undoTo(ROOM, 2))).toBe("undo_beyond_depth");
  });

  test("the default depth is four turns", () => {
    const { store } = memoryStore();
    expect(store.undoDepth).toBe(4);
    for (let turn = 1; turn <= 9; turn++) store.beginTurn(ROOM);
    expect(store.undoFloor(ROOM)).toBe(5);
  });

  test("the journal is pruned as turns begin and follows what changed, never the size of the room", () => {
    const { store, db } = memoryStore({ undoDepth: 3 });
    const setup = store.writer(ROOM);
    for (let n = 0; n < 500; n++) setup.docPut("lore", `entry-${n}`, 1, `{"n":${n}}`, "{}");
    expect(journalRows(db, ROOM)).toBe(0);
    for (let turn = 1; turn <= 40; turn++) {
      const writer = store.beginTurn(ROOM);
      writer.statePut(STORY_KEY, `t${turn}`);
      writer.statePut(STORY_KEY, `t${turn} again`); // folds into the same entry
      writer.docPut("lore", `entry-${turn}`, 1, `{"turn":${turn}}`, "{}");
    }
    // Three turns' worth: two keys each.
    expect(journalRows(db, ROOM)).toBe(6);
    store.undoTo(ROOM, 37);
    expect(store.stateGet(ROOM, STORY_KEY)).toBe("t37 again");
    expect(store.docGet(ROOM, "lore", "entry-38")?.data).toBe('{"n":38}');
    expect(store.docList(ROOM, "lore")).toHaveLength(500);
  });

  test("a late write of a turn behind the window is kept by every undo", () => {
    const { store } = memoryStore({ undoDepth: 1 });
    const one = store.beginTurn(ROOM);
    store.beginTurn(ROOM);
    const three = store.beginTurn(ROOM);
    three.statePut(STORY_KEY, "three");
    one.statePut(STORY_KEY, "one, very late"); // turn 1 is behind the window (floor 2)
    store.undoTo(ROOM, 2);
    expect(store.stateGet(ROOM, STORY_KEY)).toBe("one, very late");
  });
});

describe("undo: cutting the log", () => {
  test("events of later turns go, and turn-less ones after the first event of a later turn", () => {
    const { store } = memoryStore();
    const room = store.writer(ROOM);
    room.appendEvent(event("intro"));
    const one = store.beginTurn(ROOM);
    one.appendEvent(event("t1", 1));
    store.writer(ROOM).appendEvent(event("between 1 and 2"));
    const two = store.beginTurn(ROOM);
    two.appendEvent(event("t2", 2));
    store.writer(ROOM).appendEvent(event("during 2"));
    one.appendEvent(event("t1 late", 1));
    two.appendEvent(event("t2 more", 2));
    expect(store.room(ROOM).head).toBe(7);

    store.undoTo(ROOM, 1);
    expect(visible(store)).toEqual([["intro", null], ["t1", 1], ["between 1 and 2", null], ["t1 late", 1]]);
    // Holes stay holes: numbers are never handed out twice.
    expect(store.eventsAfter(ROOM, 0, 10).map((entry) => entry.seq)).toEqual([1, 2, 3, 6]);
    expect(store.room(ROOM).head).toBe(7);
    expect(store.writer(ROOM).appendEvent(event("after")).seq).toBe(8);
  });

  test("a turn with no events: the cut starts at the first event of any later turn", () => {
    const { store } = memoryStore();
    store.beginTurn(ROOM).appendEvent(event("t1", 1));
    store.beginTurn(ROOM); // turn 2 logs nothing
    store.writer(ROOM).appendEvent(event("quiet"));
    const three = store.beginTurn(ROOM);
    store.writer(ROOM).appendEvent(event("player line for 4"));
    three.appendEvent(event("t3", 3));
    store.writer(ROOM).appendEvent(event("after t3"));
    store.undoTo(ROOM, 2);
    expect(visible(store)).toEqual([["t1", 1], ["quiet", null], ["player line for 4", null]]);
  });

  test("no event of a later turn at all: the log is left as it is", () => {
    const { store } = memoryStore();
    store.beginTurn(ROOM).appendEvent(event("t1", 1));
    store.beginTurn(ROOM);
    store.writer(ROOM).appendEvent(event("notice"));
    store.undoTo(ROOM, 1);
    expect(visible(store)).toEqual([["t1", 1], ["notice", null]]);
  });

  test("clients resuming in the same generation miss nothing; a new generation is visible in the record", () => {
    const { store } = memoryStore();
    const one = store.beginTurn(ROOM);
    one.appendEvent(event("a", 1));
    const before = store.room(ROOM);
    const two = store.beginTurn(ROOM);
    two.appendEvent(event("b", 2));
    const undone = store.undoTo(ROOM, 1);
    expect(undone.epoch).toBe(before.epoch + 1);
    store.beginTurn(ROOM).appendEvent(event("c", 2));
    // Within the new generation the log only grows at its end.
    const seen = store.eventsAfter(ROOM, 0, 10);
    store.writer(ROOM).appendEvent(event("d"));
    const last = seen[seen.length - 1]?.seq ?? 0;
    expect(store.eventsAfter(ROOM, last, 10).map((entry) => entry.id)).toEqual(["d"]);
    expect(seen.map((entry) => entry.seq)).toEqual([1, 3]);
  });
});
