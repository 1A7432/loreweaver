import { expect, test } from "bun:test";

import { defineModule, type Json, type ModuleDefinition, type Who } from "./module.ts";
import { isValidName, mayUse, ModuleRunner } from "./runner.ts";

const ada: Who = { member: { id: "m1", name: "Ada", role: "player" }, character: { id: "ada", name: "Ada" } };
const eve: Who = { member: { id: "m3", name: "Eve", role: "observer" }, character: null };
const mo: Who = { member: { id: "m2", name: "Mo", role: "admin" }, character: null };

function dice(notation: string, seed: string) {
  // Deterministic stand-in for the engine's dice: the seed alone decides the total.
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { total: (hash % 20) + 1, text: `${notation} [${seed}]` };
}

function counterModule(id: string) {
  let count = 0;
  let scratch: string[] = [];
  return defineModule({
    id,
    create() {
      count = 0;
      scratch = [];
    },
    load(snapshot) {
      count = (snapshot as { count: number }).count;
      scratch = [];
    },
    save() {
      return { count };
    },
    on: {
      turnStart(event, fx) {
        count += 1;
        fx.inject(`${id} ${count} ${event.text}`);
        if (event.text === "throw") throw new Error("refused");
      },
      toolUse(event, fx) {
        count += 100;
        for (const call of event.calls) if (call.name === "forbidden") fx.deny(call.id, "no");
      },
    },
    commands: {
      bump: {
        title: "Bump",
        run(args, _who, fx) {
          count += typeof args.by === "number" ? args.by : 1;
          fx.fact({ text: `bumped to ${count}` });
          if (args.fail === true) throw new Error("bump failed");
          return { text: String(count) };
        },
      },
    },
    views: {
      count: {
        schema: { type: "number" },
        for() {
          count += 1000;
          scratch.push("viewed");
          return count;
        },
      },
    },
  });
}

function runner(...definitions: ModuleDefinition[]): ModuleRunner {
  const created = new ModuleRunner({ dice });
  created.load(
    definitions.map((definition) => ({ path: definition.id, definition })),
    {},
  );
  return created;
}

function room(turn: number, variables: Record<string, Json> = {}) {
  return { turn, variables, clock: null };
}

function turn(text: string, number = 1) {
  return { turn: number, seed: `s${number}`, text, who: ada, variables: {}, clock: null };
}

test("names: the pattern, and nothing every object already has", () => {
  expect(isValidName("attack")).toBe(true);
  expect(isValidName("a_1")).toBe(true);
  expect(isValidName("constructor")).toBe(false);
  expect(isValidName("__proto__")).toBe(false);
  expect(isValidName("Attack")).toBe(false);
  expect(isValidName("x".repeat(65))).toBe(false);
});

test("roles: observers and nobody use nothing; admins use everything", () => {
  expect(mayUse("player", ada)).toBe(true);
  expect(mayUse("admin", ada)).toBe(false);
  expect(mayUse("admin", mo)).toBe(true);
  expect(mayUse("player", eve)).toBe(false);
  expect(mayUse(undefined, { member: null, character: null })).toBe(false);
});

test("a throwing call loses its effects and its state; the sibling keeps both", async () => {
  const r = runner(counterModule("a"), counterModule("b"));
  await r.turnStart(turn("one"));
  const value = await r.turnStart(turn("throw", 2));
  // Both threw here because both see "throw": use commands for the sibling case below.
  expect(value.failures.map((failure) => failure.module)).toEqual(["a", "b"]);
  expect(value.effects).toEqual([]);
  expect(r.checkpointOf("a")).toEqual({ count: 1 });

  const failed = await r.command({ module: "a", command: "bump", args: { fail: true }, who: ada, seed: "c", room: room(2) });
  expect(failed.outcome).toEqual({ status: "failed", error: "Error: bump failed" });
  expect(failed.effects).toEqual([]);
  expect(failed.checkpoints).toEqual({});
  const ok = await r.command({ module: "b", command: "bump", args: { by: 5 }, who: ada, seed: "c", room: room(2) });
  expect(ok.outcome).toEqual({ status: "ok", result: { text: "6" } });
  expect(ok.checkpoints).toEqual({ b: { count: 6 } });
  const next = await r.turnStart(turn("two", 3));
  expect(next.effects.map((effect) => (effect.kind === "inject" ? effect.text : ""))).toEqual(["a 2 two", "b 7 two"]);
});

test("read-only calls leave no trace, even when the handler mutates", async () => {
  const r = runner(counterModule("a"));
  await r.turnStart(turn("one"));
  const rendered = await r.render({ viewers: [ada, mo], room: room(1) });
  // Each view call starts from the checkpoint: the second viewer does not see the first's change.
  expect(rendered.viewers.map((viewer) => viewer.views)).toEqual([
    [{ module: "a", view: "count", data: 1001 }],
    [{ module: "a", view: "count", data: 1001 }],
  ]);
  const veto = await r.toolUse({ ...room(1), who: ada, calls: [{ id: "c1", name: "forbidden", args: {} }] });
  expect(veto.effects).toEqual([{ module: "a", kind: "deny", callId: "c1", reason: "no" }]);
  expect(veto.checkpoints).toEqual({});
  const after = await r.turnStart(turn("two", 2));
  expect(after.checkpoints).toEqual({ a: { count: 2 } });
});

test("an effect used where it does not belong is dropped and reported, not thrown", async () => {
  let stashed: { log(text: string): void } | null = null;
  const r = runner(
    defineModule({
      id: "misplaced",
      on: {
        toolUse(_event, fx) {
          (fx as unknown as { inject(text: string): void }).inject("nope");
          (fx as unknown as { fact(fact: { text: string }): void }).fact({ text: "nope" });
        },
        replyPhase(_event, fx) {
          (fx as unknown as { inject(text: string): void }).inject("nope");
          fx.setVar("x", 1n as unknown as Json);
          fx.log(5 as unknown as string);
          stashed = fx;
        },
      },
    }),
  );
  const veto = await r.toolUse({ ...room(1), who: ada, calls: [] });
  expect(veto.failures).toEqual([]);
  expect(veto.refused).toEqual([
    { module: "misplaced", kind: "inject", reason: "wrong_place" },
    { module: "misplaced", kind: "fact", reason: "wrong_place" },
  ]);
  const reply = await r.replyPhase({ ...room(1), seed: "s", reply: "r", rolls: [], clockAdvances: [], variableWrites: [], who: ada });
  expect(reply.refused).toEqual([
    { module: "misplaced", kind: "inject", reason: "wrong_place" },
    { module: "misplaced", kind: "setVar", reason: "not_json" },
    { module: "misplaced", kind: "log", reason: "bad_argument" },
  ]);
  // Used after its call ended: it reaches nothing.
  expect(stashed).not.toBeNull();
  const value = await r.turnStart(turn("x"));
  expect(value.effects).toEqual([]);
});

test("dice derive from the call's seed, the module and an ordinal", async () => {
  const seen: number[][] = [];
  const definition = defineModule({
    id: "roller",
    on: {
      turnStart(_event, fx) {
        seen.push([fx.roll("1d20").total, fx.roll("1d20", "second").total]);
      },
    },
  });
  const r = runner(definition);
  const first = await r.turnStart(turn("x"));
  await r.turnStart(turn("x"));
  expect(seen[0]).toEqual(seen[1]);
  expect(first.effects).toEqual([
    { module: "roller", kind: "roll", notation: "1d20", total: seen[0]?.[0] ?? 0, text: "1d20 [s1:roller:0]" },
    { module: "roller", kind: "roll", notation: "1d20", label: "second", total: seen[0]?.[1] ?? 0, text: "1d20 [s1:roller:1]" },
  ]);
});

test("load: two clock claims name both; a bad id or a malformed table fails the load", () => {
  const clock = (id: string) => defineModule({ id, clock: () => ({ time: "noon" }) });
  expect(() => runner(clock("sun"), clock("moon"))).toThrow('modules "sun" and "moon" both claim the room\'s clock');
  expect(() => runner(defineModule({ id: "constructor" }))).toThrow(/not a usable name/);
  expect(() => runner({ id: "x", commands: { go: { title: "Go" } } } as unknown as ModuleDefinition)).toThrow(/has no run/);
});

test("command names are looked up as own, valid names only", async () => {
  const r = runner(counterModule("a"));
  for (const command of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const value = await r.command({ module: "a", command, args: {}, who: ada, seed: "s", room: room(1) });
    expect(value.outcome).toEqual({ status: "refused", reason: "unknown" });
  }
});

test("a restore that fails marks the module broken until the next load", async () => {
  let loads = 0;
  const r = runner(
    defineModule({
      id: "fragile",
      load() {
        loads += 1;
        throw new Error("cannot load");
      },
      save: () => 1,
      views: { v: { schema: {}, for: () => 1 } },
      on: { turnStart() {} },
    }),
  );
  const rendered = await r.render({ viewers: [ada], room: room(1) });
  expect(rendered.broken).toEqual(["fragile"]);
  const value = await r.turnStart(turn("x"));
  expect(value.failures).toEqual([{ module: "fragile", error: "module is broken" }]);
  expect(loads).toBe(1);
});

test("each module gets its own copy of the room: a write by one never reaches the next", async () => {
  const seen: Json[] = [];
  const scribbler = (id: string) =>
    defineModule({
      id,
      on: {
        turnStart(event) {
          seen.push(structuredClone(event.variables));
          (event.variables as Record<string, Json>).hp = 0;
          (event as { clock: unknown }).clock = { time: "scribbled" };
        },
        toolUse(event) {
          seen.push(structuredClone(event.variables));
          (event.variables as Record<string, Json>).hp = 0;
        },
      },
      commands: {
        peek: {
          title: "Peek",
          available(_who, room) {
            (room.variables as Record<string, Json>).hp = -1;
            return true;
          },
          run: (_args, _who, _fx, room) => ({ data: room.variables }),
        },
      },
      views: {
        hp: {
          schema: {},
          for(_who, room) {
            const hp = room.variables.hp ?? null;
            (room.variables as Record<string, Json>).hp = 0;
            return hp;
          },
        },
      },
    });
  const r = runner(scribbler("first"), scribbler("second"));
  const variables = { hp: 7 };
  await r.turnStart({ ...turn("x"), variables });
  await r.toolUse({ ...room(1, variables), who: ada, calls: [] });
  expect(seen).toEqual([{ hp: 7 }, { hp: 7 }, { hp: 7 }, { hp: 7 }]);
  expect(variables).toEqual({ hp: 7 });

  const peek = await r.command({ module: "second", command: "peek", args: {}, who: ada, seed: "s", room: room(1, variables) });
  expect(peek.outcome).toEqual({ status: "ok", result: { data: { hp: 7 } } });
  const rendered = await r.render({ viewers: [ada, mo], room: room(1, variables) });
  expect(rendered.viewers.map((viewer) => viewer.views.map((view) => ("data" in view ? view.data : null)))).toEqual([
    [7, 7],
    [7, 7],
  ]);
});
