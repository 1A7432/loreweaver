import { afterEach, expect, test } from "bun:test";

import type { Json, Who } from "loreweaver/module";

import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { RoomWorker, type RoomWorkerOptions } from "../../src/infra/room_worker.ts";
import { spawnWorker, type WorkerHandle } from "../../src/infra/runtime/worker.ts";
import { bench, fixtureModule, isIdle, Wire, WORKER_ENTRY } from "../helpers.ts";

const ada: Who = { member: { id: "m-ada", name: "Ada", role: "player" }, character: { id: "hero", name: "Hero" } };
const mo: Who = { member: { id: "m-mo", name: "Mo", role: "admin" }, character: null };

const workers: RoomWorker[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A spawn that counts threads started and every op posted to them. */
function counting() {
  const stats = { spawns: 0, ops: [] as string[] };
  const spawn = (): WorkerHandle => {
    stats.spawns += 1;
    const inner = spawnWorker(WORKER_ENTRY);
    return {
      post: (message) => {
        stats.ops.push((message as { op: string }).op);
        inner.post(message);
      },
      onMessage: (listener) => {
        inner.onMessage(listener);
      },
      terminate: () => inner.terminate(),
    };
  };
  return { stats, spawn };
}

function worker(modules: string[], options: Partial<RoomWorkerOptions> & { spawn?: () => WorkerHandle } = {}): RoomWorker {
  const saved = new Map<string, Json>();
  const created = new RoomWorker(options.spawn ?? (() => spawnWorker(WORKER_ENTRY)), modules.map(fixtureModule), {
    timeoutMs: 2000,
    onCheckpoint: (module, snapshot) => {
      saved.set(module, snapshot);
    },
    ...options,
  });
  workers.push(created);
  return created;
}

const ROOM = { turn: 1, variables: {}, clock: null };

function turn(number: number, text: string) {
  return { turn: number, seed: `room:${number}:turnStart`, text, who: ada, variables: {}, clock: null };
}

function reply(number: number, text = "the end") {
  return { turn: number, seed: `room:${number}:replyPhase`, reply: text, rolls: [], clockAdvances: [], variableWrites: [], who: ada, variables: {}, clock: null };
}

function command(name: string, args: Record<string, Json> = {}, who: Who = ada) {
  return { module: "kitchen", command: name, args, who, seed: `room:1:command:${name}`, room: ROOM };
}

test("load describes every module; a fresh module's state is kept at once", async () => {
  const persisted: [string, Json][] = [];
  const w = worker(["kitchen", "counter"], { onCheckpoint: (module, snapshot) => persisted.push([module, snapshot]) });
  const described = await w.describe();
  expect(described.map((module) => module.id)).toEqual(["kitchen", "counter"]);
  expect(described[0]).toMatchObject({
    events: { turnStart: true, toolUse: true, replyPhase: true },
    clock: true,
    characters: true,
    views: [
      { name: "status", title: "Status", schema: { type: "object" } },
      { name: "scratch", title: null, schema: { type: "number" } },
    ],
  });
  expect(described[0]?.commands.map((entry) => [entry.name, entry.role, entry.available])).toEqual([
    ["hit", "player", false],
    ["reset", "admin", false],
    ["sit", "player", true],
    ["echo", "player", false],
  ]);
  expect(described[0]?.commands[0]).toMatchObject({ title: "Hit", description: "Lose some hp.", text: ["hit {amount}"] });
  expect(persisted).toEqual([
    ["kitchen", { hp: 10, said: [] }],
    ["counter", { turns: 0 }],
  ]);
});

test("turn start: effects in module order, and the claimed clock read inside the same exchange", async () => {
  const { stats, spawn } = counting();
  const w = worker(["kitchen", "counter"], { spawn });
  const value = await w.turnStart(turn(1, "hello"));
  expect(value.clock).toEqual({ module: "kitchen", reading: { time: "hp 10", round: 0 } });
  expect(value.effects).toEqual([
    { module: "kitchen", kind: "inject", text: "kitchen heard 1; clock hp 10" },
    { module: "kitchen", kind: "fact", text: "turn 1", to: "table", importance: "normal", narrateNow: false },
    { module: "kitchen", kind: "setVar", path: "kitchen.turn", value: 1 },
    { module: "counter", kind: "inject", text: 'counter: turn 1, Ada said "hello"' },
  ]);
  expect(value.checkpoints).toEqual({ kitchen: { hp: 10, said: ["hello"] }, counter: { turns: 1 } });
  expect(stats.ops).toEqual(["load", "turnStart"]);
});

test("a command that throws loses its effects and its state; the sibling module is unaffected", async () => {
  const w = worker(["kitchen", "counter"]);
  await w.turnStart(turn(1, "one"));
  const failed = await w.command(command("hit", { amount: 3, fail: true }));
  expect(failed.outcome).toEqual({ status: "failed", error: "Error: hit failed" });
  expect(failed.effects).toEqual([]);
  expect(failed.checkpoints).toEqual({});
  expect(failed.failures).toEqual([{ module: "kitchen", error: "Error: hit failed" }]);
  const ok = await w.command(command("hit", { amount: 2 }));
  expect(ok.outcome).toEqual({ status: "ok", result: { text: "hp 8", data: { hp: 8 } } });
  expect(ok.effects).toEqual([{ module: "kitchen", kind: "fact", text: "Ada is hit", to: "table", importance: "normal", narrateNow: false }]);
  expect(ok.checkpoints).toEqual({ kitchen: { hp: 8, said: ["one"] } });
  const next = await w.turnStart(turn(2, "two"));
  expect(next.checkpoints).toEqual({ kitchen: { hp: 8, said: ["one", "two"] }, counter: { turns: 2 } });
});

test("read-only exchanges leave no trace, even when their handlers mutate", async () => {
  const w = worker(["kitchen"]);
  await w.turnStart(turn(1, "one"));
  const veto = await w.toolUse({ ...ROOM, who: ada, calls: [{ id: "c1", name: "forbidden", args: {} }, { id: "c2", name: "look", args: {} }] });
  expect(veto.effects).toEqual([{ module: "kitchen", kind: "deny", callId: "c1", reason: "not here" }]);
  expect(veto.checkpoints).toEqual({});

  const rendered = await w.render([ada, mo], ROOM);
  // Each call starts from the checkpoint: hp 10, plus the view's own 1000, for each viewer.
  expect(rendered.viewers).toEqual([
    {
      views: [
        { module: "kitchen", view: "status", data: { hp: 1010, viewer: "Ada" } },
        { module: "kitchen", view: "scratch", data: 0 },
      ],
      available: [{ module: "kitchen", command: "sit", verdict: true }],
    },
    {
      views: [
        { module: "kitchen", view: "status", data: { hp: 1010, viewer: "Mo" } },
        { module: "kitchen", view: "scratch", data: 0 },
      ],
      available: [{ module: "kitchen", command: "sit", verdict: "find a seat first" }],
    },
  ]);
  expect(rendered.characters).toEqual([
    { module: "kitchen", characters: [{ id: "hero", name: "Hero", blurb: "the one", resources: [{ id: "hp", label: "HP", value: 10, max: 10 }] }] },
  ]);
  expect(rendered.clock).toEqual({ module: "kitchen", reading: { time: "hp 10", round: 1 } });

  // `available` mutates too (hp = 0) before the command runs; the run must not see it.
  const seated = await w.command(command("sit"));
  expect(seated.outcome).toEqual({ status: "ok", result: { text: "seated" } });
  expect(seated.checkpoints).toEqual({ kitchen: { hp: 10, said: ["one"] } });
  expect((await w.command(command("sit", {}, mo))).outcome).toEqual({ status: "refused", reason: "unavailable", text: "find a seat first" });
  expect((await w.command(command("reset", {}, ada))).outcome).toEqual({ status: "refused", reason: "role" });
});

test("an exchange no module handles is answered without a round trip, even with the worker stopped", async () => {
  const { stats, spawn } = counting();
  const w = worker(["counter"], { spawn });
  await w.turnStart(turn(1, "one"));
  expect((await w.toolUse({ ...ROOM, who: ada, calls: [{ id: "c", name: "x", args: {} }] })).effects).toEqual([]);
  expect((await w.replyPhase(reply(1))).effects).toEqual([]);
  expect((await w.command({ ...command("hit"), module: "counter" })).outcome).toEqual({ status: "refused", reason: "unknown" });
  expect((await w.render([ada], ROOM)).viewers).toEqual([{ views: [], available: [] }]);
  expect(stats.ops).toEqual(["load", "turnStart"]);

  await w.stop();
  await w.toolUse({ ...ROOM, who: ada, calls: [] });
  await w.render([ada], ROOM);
  expect(stats.spawns).toBe(1);
  // A handled exchange starts a new worker from the checkpoints.
  expect((await w.turnStart(turn(2, "two"))).checkpoints).toEqual({ counter: { turns: 2 } });
  expect(stats.spawns).toBe(2);
  expect(stats.ops).toEqual(["load", "turnStart", "load", "turnStart"]);
});

test("cold start: every mutating call ends the worker, which shows a save() that drops state", async () => {
  const warm = worker(["kitchen"]);
  await warm.command(command("hit"));
  expect((await warm.render([ada], ROOM)).viewers[0]?.views[1]).toEqual({ module: "kitchen", view: "scratch", data: 1 });

  const { stats, spawn } = counting();
  const cold = worker(["kitchen"], { coldStart: true, spawn });
  await cold.command(command("hit"));
  expect(cold.running).toBe(false);
  expect((await cold.render([ada], ROOM)).viewers[0]?.views[1]).toEqual({ module: "kitchen", view: "scratch", data: 0 });
  // A read-only exchange does not end the worker.
  expect(cold.running).toBe(true);
  expect(stats.spawns).toBe(2);
});

test("two modules claiming the clock is a load error naming both", async () => {
  const w = worker(["kitchen", "ticker"]);
  await expect(w.turnStart(turn(1, "x"))).rejects.toThrow('modules "kitchen" and "ticker" both claim the room\'s clock');
  // The next call tries again on a new worker (a dev room may have fixed the file).
  await expect(w.describe()).rejects.toThrow(/both claim/);
  expect(w.running).toBe(false);
});

test("commands under prototype names are described but never dispatched; argument keys are data", async () => {
  const w = worker(["bad_names", "kitchen"]);
  const described = await w.describe();
  expect(described[0]?.commands.map((entry) => entry.name)).toEqual(["constructor", "__proto__", "Shout", "ok"]);
  for (const name of ["constructor", "__proto__", "Shout", "toString"]) {
    expect((await w.command({ ...command(name), module: "bad_names" })).outcome).toEqual({ status: "refused", reason: "unknown" });
  }
  expect((await w.command({ ...command("ok"), module: "bad_names" })).outcome).toEqual({ status: "ok", result: { text: "ok" } });
  const args = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": 1}}') as Record<string, Json>;
  const echoed = await w.command(command("echo", args));
  expect(echoed.outcome).toEqual({ status: "ok", result: { data: { keys: ["__proto__", "constructor"], args } } });
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("module dice are engine dice, replayed exactly from the call's seed", async () => {
  const first = worker(["kitchen"]);
  const second = worker(["kitchen"]);
  const a = await first.replyPhase(reply(3));
  const b = await second.replyPhase(reply(3));
  const roll = a.effects.find((effect) => effect.kind === "roll");
  expect(roll).toMatchObject({ module: "kitchen", kind: "roll", notation: "1d20", label: "luck" });
  expect(roll?.kind === "roll" ? roll.text : "").toMatch(/^1d20 \(\d+\) = \d+$/);
  expect(b.effects).toEqual(a.effects);
  const other = await first.replyPhase(reply(4));
  expect(other.effects.find((effect) => effect.kind === "roll")).toBeDefined();
});

test("idle time is counted from the last call; stopIfIdle never cuts one short", async () => {
  let now = 1000;
  const w = worker(["counter"], { now: () => now });
  expect(w.idleMs()).toBe(0);
  const pending = w.turnStart(turn(1, "x"));
  now += 50;
  expect(w.idleMs()).toBe(0);
  await pending;
  await Promise.resolve();
  now += 100;
  expect(w.idleMs()).toBe(100);
  expect(await w.stopIfIdle(500)).toBe(false);
  expect(w.running).toBe(true);
  expect(await w.stopIfIdle(99)).toBe(true);
  expect(w.running).toBe(false);
  expect(await w.stopIfIdle(0)).toBe(false);
});

test("the hub stops idle workers; the next turn starts a new one from the checkpoints", async () => {
  const b = bench({ llm: new ScriptedLLM(["one", "two"]), modules: [fixtureModule("counter")] });
  cleanups.push(() => b.hub.close());
  const wire = new Wire(b.deps);
  wire.hello("player-key");
  wire.receive({ type: "input", rid: "1", text: "first" });
  await wire.until(isIdle);
  expect(await b.hub.evictIdle(60_000)).toEqual([]);
  expect(await b.hub.evictIdle(0)).toEqual(["table"]);
  expect(await b.hub.evictIdle(0)).toEqual([]);
  wire.receive({ type: "input", rid: "2", text: "second" });
  await wire.until((frame) => frame.type === "event" && frame.seq === 4);
  expect(b.store.moduleStates("table")).toEqual(new Map([["counter", { turns: 2 }]]));
});
