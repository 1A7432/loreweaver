// Module commands through the registry's seam, a real worker and a sample module; module
// views; and a checkpoint made by work of a dead generation never reaching the store.
import { afterEach, expect, test } from "bun:test";

import { events, KEYS, resultFor, RoomBench, ROOM, type BenchOptions, views } from "./room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

function setup(options: BenchOptions = {}): RoomBench {
  const bench = new RoomBench({ modules: ["kitchen"], ...options });
  benches.push(bench);
  return bench;
}

test("a module command by text and by command.run: effects applied, events published, the answer to the caller, the checkpoint stored", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  const bao = b.join(KEYS.bao);
  ada.receive({ type: "input", rid: "t", text: '.kitchen/hit {"amount":3}' });
  ada.receive({ type: "call", rid: "c", method: "command.run", params: { id: "kitchen/echo", args: { a: 1 } } });
  ada.receive({ type: "call", rid: "r", method: "command.run", params: { id: "kitchen/reset", args: {} } });
  ada.receive({ type: "call", rid: "x", method: "command.run", params: { id: "kitchen/nope", args: {} } });
  await b.settled();
  expect(resultFor(ada.sent, "t")).toEqual({ type: "result", rid: "t", ok: true, text: "hp 7", data: { hp: 7 } });
  expect(resultFor(ada.sent, "c")).toMatchObject({ ok: true, data: { keys: ["a"], args: { a: 1 } } });
  expect(resultFor(ada.sent, "r")).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(resultFor(ada.sent, "x")).toMatchObject({ ok: false, error: { code: "unknown_command" } });
  expect(resultFor(bao.sent, "t")).toBeUndefined();
  // The module's table fact is an event for everyone, written by the module.
  expect(events(bao.sent).map((event) => event.data)).toEqual([{ speaker: "system", name: "kitchen", text: "Ada is hit", format: "plain" }]);
  expect(b.store.moduleStates(ROOM).get("kitchen")).toEqual({ hp: 7, said: [] });
  expect(b.actions).toEqual([{ actor: "Ada", action: "kitchen/hit", text: "Ada is hit" }]);
});

test("the commands view lists module commands; a module view is rendered for its subscriber", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  ada.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["kitchen/status", "commands"] } });
  await b.settled();
  expect(resultFor(ada.sent, "s")).toMatchObject({ ok: true, data: { problems: [] } });
  expect(views(ada.sent, "kitchen/status").at(-1)?.data).toMatchObject({ viewer: "Ada" });
  const commands = (views(ada.sent, "commands").at(-1)?.data as { commands: { id: string }[] }).commands.map((entry) => entry.id);
  expect(commands).toContain("kitchen/hit");
  // Admin-only module commands are not listed to a player.
  expect(commands).not.toContain("kitchen/reset");
});

test("a checkpoint from an exchange of a dead generation is not stored; the worker starts over from the store", async () => {
  let armed = false;
  let undo: (() => void) | null = null;
  const b = setup({
    onPost: (op) => {
      if (op !== "command" || !armed) return;
      armed = false;
      // The admin's undo lands while the command's exchange is in flight.
      undo?.();
    },
  });
  const ada = b.join(KEYS.ada);
  const root = b.join(KEYS.root);
  undo = () => {
    root.receive({ type: "input", rid: "u", text: ".undo" });
  };
  ada.receive({ type: "input", rid: "1", text: "hello" });
  await b.settled();
  const before = b.store.moduleStates(ROOM).get("kitchen");
  armed = true;
  ada.receive({ type: "input", rid: "hit", text: '.kitchen/hit {"amount":3}' });
  await b.settled();
  expect(resultFor(root.sent, "u")?.ok).toBe(true);
  expect(resultFor(ada.sent, "hit")).toMatchObject({ ok: false, error: { code: "stale_generation" } });
  expect(b.store.moduleStates(ROOM).get("kitchen")).toEqual(before);
  // The module's in-memory state was thrown away with it.
  ada.receive({ type: "input", rid: "again", text: '.kitchen/hit {"amount":1}' });
  await b.settled();
  expect(resultFor(ada.sent, "again")).toMatchObject({ ok: true, text: "hp 9" });
  expect(b.store.moduleStates(ROOM).get("kitchen")).toEqual({ hp: 9, said: [] });
});
