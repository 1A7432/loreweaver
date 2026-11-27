// The two additions to the contract as the runner and the test host see them: `fx.seat`
// (resolved against `characters()` after the call; a module sees its own characters by its
// own ids) and a command that runs in steps (`more: true`, `call.step`).
import { expect, test } from "bun:test";

import { defineModule, type Who } from "./module.ts";
import { commandAnswer, localWho, MAX_COMMAND_STEPS, MAX_COMMAND_TOTAL_MS, ModuleRunner, runSteps, stepSeed } from "./runner.ts";
import { createTestHost, who } from "./testing.ts";

function camp() {
  let settlers = ["ana"];
  let year = 0;
  return defineModule({
    id: "camp",
    create() {
      settlers = ["ana"];
      year = 0;
    },
    load(snapshot) {
      const state = snapshot as { settlers: string[]; year: number };
      settlers = [...state.settlers];
      year = state.year;
    },
    save: () => ({ settlers, year }),
    characters: () => settlers.map((id) => ({ id, name: id.toUpperCase() })),
    on: {
      turnStart(event, fx) {
        fx.seat(event.who.member?.id ?? "", "ana");
      },
      toolUse(_event, fx) {
        (fx as unknown as { seat(member: string, character: string | null): void }).seat("m1", "ana");
      },
    },
    commands: {
      // A settler arrives in this very call: the seat resolves against the list the call leaves.
      arrive: {
        title: "Arrive",
        run(args, who, fx) {
          settlers.push(String(args.id));
          fx.seat(who.member?.id ?? "", String(args.id));
          fx.seat(who.member?.id ?? "", "ghost");
          fx.seat(who.member?.id ?? "", null);
          (fx as unknown as { seat(member: unknown, character: unknown): void }).seat(3, "ana");
        },
      },
      mine: { title: "Mine", run: (_args, who) => ({ data: who.character }) },
      gated: {
        title: "Gated",
        available: () => (year === 0 ? true : "only in the first year"),
        run(_args, _who, fx, _room, call) {
          year += 1;
          fx.log(`step ${call.step} seed ${call.seed}`);
          return call.step < 2 ? { text: `year ${year}`, more: true } : { text: `year ${year}`, data: { year } };
        },
      },
      endless: {
        title: "Endless",
        run(_args, _who, _fx, _room, call) {
          return { text: `step ${call.step}`, more: true };
        },
      },
      breaks: {
        title: "Breaks on its second step",
        run(_args, _who, _fx, _room, call) {
          if (call.step === 1) throw new Error("broke");
          year += 1;
          return { text: "fine", data: { year }, more: true };
        },
      },
    },
  });
}

const ada: Who = { member: { id: "m1", name: "Ada", role: "player" }, character: { id: "camp:ana", name: "ANA" } };

test("fx.seat: resolved after the call against the characters it leaves; an unknown id keeps no name; misplaced and malformed seats are refused", async () => {
  const host = createTestHost(camp());
  const arrived = await host.command("arrive", { id: "bo" }, ada);
  expect(arrived.seats).toEqual([
    { module: "camp", kind: "seat", member: "m1", character: "bo", name: "BO" },
    { module: "camp", kind: "seat", member: "m1", character: "ghost", name: null },
    { module: "camp", kind: "seat", member: "m1", character: null, name: null },
  ]);
  expect(arrived.refused).toEqual([{ module: "camp", kind: "seat", reason: "bad_argument" }]);
  // Resolving read `characters()` and restored the module from the checkpoint the call made.
  expect(host.checkpoint).toEqual({ settlers: ["ana", "bo"], year: 0 });
  expect((await host.turnStart({ text: "hi", who: ada })).seats).toHaveLength(1);
  expect((await host.toolUse([{ name: "x" }])).refused).toEqual([{ module: "camp", kind: "seat", reason: "wrong_place" }]);
});

test("a module sees its own character by its own id, and any other by the id the engine knows it by", async () => {
  expect(localWho(ada, "camp")).toEqual({ member: ada.member, character: { id: "ana", name: "ANA" } });
  expect(localWho(ada, "rival")).toBe(ada);
  const runner = new ModuleRunner({ dice: () => ({ total: 1, text: "1" }) });
  runner.load([{ path: "camp", definition: camp() }], {});
  const value = await runner.command({ module: "camp", command: "mine", args: {}, who: ada, by: "member", seed: "s", step: 0, room: { turn: 1, variables: {}, clock: null, members: [] } });
  expect(value.outcome).toEqual({ status: "ok", result: { data: { id: "ana", name: "ANA" } } });
});

test("the step loop: the limits, each step's seed, the answer wrapped only for a command that asked for more", async () => {
  expect([MAX_COMMAND_STEPS, MAX_COMMAND_TOTAL_MS]).toEqual([8, 20_000]);
  expect([stepSeed("s", 0), stepSeed("s", 2)]).toEqual(["s", "s:step:2"]);
  expect(commandAnswer({ text: "t", data: { a: 1 } }, 1, null)).toEqual({ text: "t", data: { a: 1 } });
  expect(commandAnswer({ text: null, data: null }, 3, "time")).toEqual({ text: null, data: { steps: 3, data: null, stopped: "time" } });
  const seeds: string[] = [];
  const ran = await runSteps("s", () => 0, async (step, seed) => {
    seeds.push(seed);
    return step < 2 ? { ok: true, value: step, more: true } : { ok: true, value: step, more: false };
  });
  expect(ran).toEqual({ kind: "ended", last: 2, steps: 3, stopped: null });
  expect(seeds).toEqual(["s", "s:step:1", "s:step:2"]);
  expect(await runSteps("s", () => 0, async () => ({ ok: false, value: "no" }))).toEqual({ kind: "first", value: "no" });
});

test("the test host runs a stepped command as the engine does: every step's effects, one answer, available asked once", async () => {
  const host = createTestHost(camp(), { seed: "t" });
  const ran = await host.command("gated", {}, ada);
  expect(ran.steps).toBe(3);
  expect(ran.stopped).toBeNull();
  expect(ran.outcome).toEqual({ status: "ok", result: { text: "year 3", data: { steps: 3, data: { year: 3 } } } });
  expect(ran.logs).toEqual(["step 0 seed t:1:command:gated", "step 1 seed t:1:command:gated:step:1", "step 2 seed t:1:command:gated:step:2"]);
  expect(host.checkpoint).toEqual({ settlers: ["ana"], year: 3 });
  // At the moment of use only: now the first step is refused.
  expect((await host.command("gated", {}, ada)).outcome).toEqual({ status: "refused", reason: "unavailable", text: "only in the first year" });

  const endless = await host.command("endless", {}, ada);
  expect([endless.steps, endless.stopped, endless.outcome]).toEqual([8, "steps", { status: "ok", result: { text: "step 7", data: { steps: 8, data: null, stopped: "steps" } } }]);

  let clock = 0;
  const timed = createTestHost(camp(), { now: () => (clock += 15_000) });
  const cut = await timed.command("endless", {}, ada);
  // 15 s a reading: the second step starts at 15 s, the third would start at 30 s.
  expect([cut.steps, cut.stopped]).toEqual([2, "time"]);

  const broken = createTestHost(camp());
  const failed = await broken.command("breaks", {}, ada);
  expect([failed.steps, failed.stopped, failed.error]).toEqual([1, "failed", "Error: broke"]);
  expect(failed.outcome).toEqual({ status: "ok", result: { text: "fine", data: { steps: 1, data: { year: 1 }, stopped: "failed" } } });
  expect(broken.checkpoint).toEqual({ settlers: ["ana"], year: 1 });
});

test("who() builds a seat by the module's own id", () => {
  expect(who("Ada", { character: { id: "ana", name: "Ana" } }).character).toEqual({ id: "ana", name: "Ana" });
});
