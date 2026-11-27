// A command that runs in steps (`more: true`), through `runModuleCommand` and a real worker:
// the time limit on a clock the test moves, a step that times out, the per-step seeds a
// replay gives again, and seat requests as the engine validates them.
import { afterEach, expect, test } from "bun:test";

import type { Json, Who } from "loreweaver/module";
import { MAX_COMMAND_STEPS, MAX_COMMAND_TOTAL_MS, stepSeed } from "loreweaver/runner";

import { type CommandOutcome, DEFAULT_CAPS, runModuleCommand, validateCommand } from "../../src/agent/modules.ts";
import { RoomWorker } from "../../src/infra/room_worker.ts";
import { spawnWorker } from "../../src/infra/runtime/worker.ts";
import { fixtureModule, WORKER_ENTRY } from "../helpers.ts";

const ada: Who = { member: { id: "m-ada", name: "Ada", role: "player" }, character: null };
const ROOM = { turn: 1, variables: {}, clock: null, members: [] };

const workers: RoomWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

function worker(timeoutMs = 2000): RoomWorker {
  const created = new RoomWorker(() => spawnWorker(WORKER_ENTRY), [fixtureModule("colony")], { timeoutMs });
  workers.push(created);
  return created;
}

type Ok = Extract<CommandOutcome, { status: "ok" }>;

/** Run `command` to its end, keeping every applied step; `now` is the loop's clock. */
async function stepped(w: RoomWorker, command: string, args: Record<string, Json>, now: () => number = () => 0) {
  const applied: Ok[] = [];
  const outcome = await runModuleCommand(w, { module: "colony", command, args, who: ada, by: "member", seed: "table:1:1:act:command" }, {
    now,
    room: () => ROOM,
    apply: (step) => {
      applied.push(step);
      return true;
    },
  });
  return { outcome, applied };
}

test("the limits are the SDK's: 8 steps, 20 seconds", () => {
  expect([MAX_COMMAND_STEPS, MAX_COMMAND_TOTAL_MS]).toEqual([8, 20_000]);
});

test("the time limit: no further step once 20 seconds have passed since the first began (the test's clock)", async () => {
  let clock = 0;
  // Every reading moves the clock 7 seconds: the loop reads it once at the start and once after each step.
  const { outcome, applied } = await stepped(worker(), "forever", {}, () => (clock += 7_000));
  expect(outcome).toMatchObject({ status: "ok", steps: 3, stopped: "time", result: { text: "tick 2", data: { steps: 3, data: null, stopped: "time" } } });
  expect(applied.map((step) => step.facts[0]?.text)).toEqual(["tick 0", "tick 1", "tick 2"]);
});

test("a step that outlives the call limit loses only itself: the steps before it stand", async () => {
  const saved = new Map<string, Json>();
  const w = new RoomWorker(() => spawnWorker(WORKER_ENTRY), [fixtureModule("colony")], {
    timeoutMs: 300,
    onCheckpoint: (module, snapshot) => {
      saved.set(module, snapshot);
    },
  });
  workers.push(w);
  const { outcome, applied } = await stepped(w, "advance", { years: 4, hang_at: 2 });
  expect(applied.map((step) => step.result.text)).toEqual(["year 1", "year 2"]);
  expect(outcome).toMatchObject({ status: "ok", steps: 2, stopped: "failed", result: { text: "year 2" } });
  expect(outcome.problems.some((problem) => problem.includes("did not answer within 300 ms"))).toBe(true);
  // Each completed step kept its checkpoint; the next call starts from the second's.
  expect(saved.get("colony")).toMatchObject({ years: 2 });
  expect((await stepped(w, "advance", { years: 1 })).outcome).toMatchObject({ status: "ok", result: { text: "year 3" } });
});

test("each step has its own seed, derived from the first call's and the step: a replay over the same state gets the same ones", async () => {
  const seeds = async (): Promise<unknown[]> => (await stepped(worker(), "advance", { years: 3 })).applied.map((step) => step.facts[0]?.data);
  const first = await seeds();
  expect(first).toEqual([
    { step: 0, seed: "table:1:1:act:command", harvest: expect.any(Number) },
    { step: 1, seed: stepSeed("table:1:1:act:command", 1), harvest: expect.any(Number) },
    { step: 2, seed: stepSeed("table:1:1:act:command", 2), harvest: expect.any(Number) },
  ]);
  // The dice derive from each step's seed: the same faces again on a fresh worker.
  expect(await seeds()).toEqual(first);
});

test("a stale room stops the loop at once: nothing further runs", async () => {
  const w = worker();
  let calls = 0;
  const outcome = await runModuleCommand(w, { module: "colony", command: "advance", args: { years: 5 }, who: ada, by: "member", seed: "s" }, {
    now: () => 0,
    room: () => ROOM,
    apply: () => {
      calls += 1;
      return false;
    },
  });
  expect(outcome.status).toBe("stale");
  expect(calls).toBe(1);
});

test("seat requests: only where a module may write, capped per call, each shape checked", () => {
  const seat = (extra: Record<string, unknown>) => ({ module: "colony", kind: "seat", member: "m-ada", character: "ana", name: "Ana", ...extra });
  const answer = (effects: unknown[]) => ({ effects, checkpoints: {}, failures: [], refused: [], broken: [], outcome: { status: "ok", result: { text: "ok" } } });
  const many = Array.from({ length: DEFAULT_CAPS.seats + 2 }, () => seat({}));
  const capped = validateCommand(answer(many));
  expect(capped.status === "ok" ? capped.seats : []).toHaveLength(DEFAULT_CAPS.seats);
  expect(capped.problems.filter((problem) => problem.includes(`seat dropped, over ${DEFAULT_CAPS.seats} per call`))).toHaveLength(2);
  const shapes = validateCommand(answer([seat({ member: 3 }), seat({ character: 4 }), seat({ name: 5 }), seat({ character: null, name: "x" })]));
  expect(shapes.status === "ok" ? shapes.seats : []).toEqual([{ module: "colony", member: "m-ada", character: null, name: null }]);
  expect(shapes.problems).toHaveLength(3);
  // `more` is strictly `true`.
  const more = validateCommand({ ...answer([]), outcome: { status: "ok", result: { text: "ok", more: "yes" } } });
  expect(more.status === "ok" && more.more).toBe(false);
});
