import { expect, test } from "bun:test";

import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { Store } from "../../src/infra/store.ts";

function store(): Store {
  return new Store(openDatabase(":memory:"));
}

function line(text: string, n: number) {
  return { id: `e${n}`, ts: n, kind: "narrative", data: { text } };
}

test("events are numbered per room from 1 and come back as they were stored", () => {
  const s = store();
  expect(s.room("a")).toEqual({ epoch: 1, head: 0 });
  expect(s.appendEvent("a", line("one", 1)).seq).toBe(1);
  expect(s.appendEvent("a", { ...line("two", 2), turn: 7 })).toEqual({ seq: 2, id: "e2", ts: 2, kind: "narrative", turn: 7, data: { text: "two" } });
  expect(s.appendEvent("b", line("other room", 3)).seq).toBe(1);
  expect(s.room("a")).toEqual({ epoch: 1, head: 2 });
  expect(s.eventsAfter("a", 0, 10).map((event) => event.seq)).toEqual([1, 2]);
  expect(s.eventsAfter("a", 1, 10)).toEqual([{ seq: 2, id: "e2", ts: 2, kind: "narrative", turn: 7, data: { text: "two" } }]);
});

test("a page of history is the entries just before a position, oldest first", () => {
  const s = store();
  for (let n = 1; n <= 5; n++) s.appendEvent("a", line(`#${n}`, n));
  expect(s.eventsBefore("a", 5, 2).map((event) => event.seq)).toEqual([3, 4]);
  expect(s.eventsBefore("a", 2, 10).map((event) => event.seq)).toEqual([1]);
});

test("a rewind cuts the log, moves the generation, and numbering continues from the cut", () => {
  const s = store();
  for (let n = 1; n <= 4; n++) s.appendEvent("a", line(`#${n}`, n));
  expect(s.lastTurn("a")).toBe(0);
  expect(s.rewind("a", 2)).toEqual({ epoch: 2, head: 2 });
  expect(s.eventsAfter("a", 0, 10).map((event) => event.seq)).toEqual([1, 2]);
  expect(s.appendEvent("a", line("after", 9)).seq).toBe(3);
});

test("module state is kept per room and module, and a module id is never read off a prototype", () => {
  const s = store();
  s.setModuleState("a", "counter", { turns: 1 });
  s.setModuleState("a", "counter", { turns: 2 });
  s.setModuleState("a", "constructor", ["x"]);
  expect(s.moduleStates("a")).toEqual(new Map<string, unknown>([["constructor", ["x"]], ["counter", { turns: 2 }]]));
  expect(s.moduleStates("b").size).toBe(0);
});
