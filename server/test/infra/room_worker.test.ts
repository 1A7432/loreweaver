import { afterEach, expect, test } from "bun:test";

import { RoomWorker, WorkerTimeout } from "../../src/infra/room_worker.ts";
import { spawnWorker } from "../../src/infra/runtime/worker.ts";
import { fixtureModule, WORKER_ENTRY } from "../helpers.ts";

const workers: RoomWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

function worker(modules: string[], options: { timeoutMs?: number; checkpoints?: Map<string, never> } = {}): RoomWorker {
  const created = new RoomWorker(() => spawnWorker(WORKER_ENTRY), modules.map(fixtureModule), {
    timeoutMs: options.timeoutMs ?? 2000,
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
  });
  workers.push(created);
  return created;
}

function event(turn: number, text: string) {
  return { turn, seed: `s${turn}`, text, speaker: "Ada" };
}

test("a module loaded from a TypeScript file keeps its state from one call to the next", async () => {
  const w = worker(["counter"]);
  const first = await w.turnStart(event(1, "hello"));
  expect(first.effects).toEqual([{ module: "counter", kind: "inject", text: 'counter: turn 1, Ada said "hello"' }]);
  expect(first.checkpoints).toEqual({ counter: { turns: 1 } });
  const second = await w.turnStart(event(2, "again"));
  expect(second.checkpoints).toEqual({ counter: { turns: 2 } });
  expect(w.loaded).toEqual(["counter"]);
});

test("a call that throws loses its effects and its state change; other modules are unaffected", async () => {
  const w = worker(["moody", "counter"]);
  await w.turnStart(event(1, "fine"));
  const failed = await w.turnStart(event(2, "throw"));
  expect(failed.failures).toEqual([{ module: "moody", error: "Error: moody refuses" }]);
  expect(failed.effects.map((effect) => effect.module)).toEqual(["counter"]);
  expect(failed.checkpoints).toEqual({ counter: { turns: 2 } });
  // "throw" was pushed before the handler failed; the rollback must have removed it.
  const after = await w.turnStart(event(3, "later"));
  expect(after.effects[0]).toEqual({ module: "moody", kind: "inject", text: "moody has seen: fine, later" });
});

test("a call that never returns ends the worker; the next call runs on a new one, from the last checkpoints", async () => {
  const w = worker(["moody", "counter"], { timeoutMs: 300 });
  await w.turnStart(event(1, "fine"));
  const started = performance.now();
  await expect(w.turnStart(event(2, "spin"))).rejects.toBeInstanceOf(WorkerTimeout);
  expect(performance.now() - started).toBeLessThan(1500);
  const after = await w.turnStart(event(3, "back"));
  expect(after.effects).toEqual([
    { module: "moody", kind: "inject", text: "moody has seen: fine, back" },
    { module: "counter", kind: "inject", text: 'counter: turn 2, Ada said "back"' },
  ]);
});

test("calls queued behind one that hangs are not lost: each runs after the rebuild", async () => {
  const w = worker(["moody"], { timeoutMs: 300 });
  const hung = w.turnStart(event(1, "spin"));
  const queued = w.turnStart(event(2, "queued"));
  await expect(hung).rejects.toBeInstanceOf(WorkerTimeout);
  expect((await queued).effects).toEqual([{ module: "moody", kind: "inject", text: "moody has seen: queued" }]);
});

test("a worker started with stored checkpoints restores them", async () => {
  const w = worker(["counter"], { checkpoints: new Map([["counter", { turns: 41 } as never]]) });
  expect((await w.turnStart(event(1, "x"))).checkpoints).toEqual({ counter: { turns: 42 } });
});

test("a module file that does not export a definition fails the load, by name", async () => {
  const w = new RoomWorker(() => spawnWorker(WORKER_ENTRY), [new URL("../helpers.ts", import.meta.url).pathname], { timeoutMs: 2000 });
  workers.push(w);
  await expect(w.turnStart(event(1, "x"))).rejects.toThrow(/not a module definition/);
});
