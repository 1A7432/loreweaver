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

test("the scene view shows the clock a module keeps, before any turn has run", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  ada.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["scene"] } });
  await b.settled();
  // `kitchen` keeps the room's clock (its reading is "hp <n>", its round the lines it heard).
  expect(views(ada.sent, "scene").at(-1)?.data).toMatchObject({ clockModule: "kitchen", time: "hp 10", round: 0 });
});

test("a keeper command is no player's: refused like a role they lack, nothing applied, absent from their commands view; an admin may run it", async () => {
  const b = setup({ modules: ["omens"] });
  const ada = b.join(KEYS.ada);
  const root = b.join(KEYS.root);
  const before = b.store.moduleStates(ROOM).get("omens");
  ada.receive({ type: "call", rid: "run", method: "command.run", params: { id: "omens/advance", args: {} } });
  ada.receive({ type: "input", rid: "typed", text: ".omens/advance" });
  ada.receive({ type: "call", rid: "look", method: "command.run", params: { id: "omens/look", args: {} } });
  await b.settled();
  for (const [sent, rid] of [
    [ada.sent, "run"],
    [ada.sent, "typed"],
  ] as const) {
    const refused = resultFor(sent, rid);
    // The same refusal an admin command gives a player: it names no command and carries nothing of the module's.
    expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(JSON.stringify(refused)).not.toContain("OMEN_DUE");
    expect(JSON.stringify(refused)).not.toContain("advance");
  }
  // A player command answers a member as one.
  expect(resultFor(ada.sent, "look")).toMatchObject({ ok: true, text: "member: you see the well" });
  expect(events(ada.sent)).toEqual([]);
  expect(events(root.sent)).toEqual([]);
  expect(b.store.moduleStates(ROOM).get("omens")).toEqual(before ?? { hours: 0 });
  // No action recorded for the Keeper's next prompt (`look` emits no fact; the refusals did nothing).
  expect(b.actions).toEqual([]);

  ada.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["commands"] } });
  root.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["commands"] } });
  await b.settled();
  const listed = (sent: typeof ada.sent) => (views(sent, "commands").at(-1)?.data as { commands: { id: string }[] }).commands.map((entry) => entry.id).filter((id) => id.startsWith("omens/"));
  expect(listed(ada.sent)).toEqual(["omens/look"]);
  // The admin's table lists it, as an admin command: it is theirs to repair the table with.
  const rootTable = (views(root.sent, "commands").at(-1)?.data as { commands: { id: string; role: string }[] }).commands;
  expect(listed(root.sent).toSorted()).toEqual(["omens/advance", "omens/look", "omens/wipe"]);
  expect(rootTable.find((entry) => entry.id === "omens/advance")?.role).toBe("admin");
  // A module marks its own destructive command: the view carries it, so a client asks first.
  const flags = (views(root.sent, "commands").at(-1)?.data as { commands: { id: string; danger?: boolean }[] }).commands;
  expect([flags.find((entry) => entry.id === "omens/wipe")?.danger, flags.find((entry) => entry.id === "omens/look")?.danger]).toEqual([true, undefined]);

  // And runs it: the module is told a member called, the state moves, the table hears the fact.
  root.receive({ type: "call", rid: "admin", method: "command.run", params: { id: "omens/advance", args: {} } });
  await b.settled();
  expect(resultFor(root.sent, "admin")).toMatchObject({ ok: true, text: expect.stringContaining("member for Root") });
  expect(b.store.moduleStates(ROOM).get("omens")).toEqual({ hours: 1 });
});
