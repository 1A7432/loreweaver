import { expect, test } from "bun:test";

import { defineModule, type Json, type ModuleDefinition, type ModuleInit, type Who } from "./module.ts";
import { isValidName, keeperMayRun, mayRun, mayUse, ModuleRunner, type ViewerRequest } from "./runner.ts";

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
  return { turn, variables, clock: null, members: [] };
}

function turn(text: string, number = 1) {
  return { turn: number, seed: `s${number}`, text, who: ada, variables: {}, clock: null, members: [] };
}

/** A viewer asking for these views of `module`. */
function asking(who: Who, module: string, ...views: string[]): ViewerRequest {
  return { who, views: views.map((view) => ({ module, view })) };
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

test("roles: among members a keeper command is an admin's alone; the Keeper runs player and keeper commands, never admin ones", () => {
  const nobody: Who = { member: null, character: null };
  expect(mayUse("keeper", ada)).toBe(false);
  expect(mayUse("keeper", eve)).toBe(false);
  expect(mayUse("keeper", nobody)).toBe(false);
  // An admin may: it is how a person repairs what the Keeper got wrong.
  expect(mayUse("keeper", mo)).toBe(true);
  for (const speaker of [ada, mo, eve, nobody]) {
    expect(mayRun(undefined, "keeper", speaker)).toBe(true);
    expect(mayRun("player", "keeper", speaker)).toBe(true);
    expect(mayRun("keeper", "keeper", speaker)).toBe(true);
    expect(mayRun("admin", "keeper", speaker)).toBe(false);
  }
  expect(mayRun("admin", "member", mo)).toBe(true);
  expect(mayRun("keeper", "member", mo)).toBe(true);
  expect(mayRun("keeper", "member", ada)).toBe(false);
  expect(mayRun("player", "nobody" as never, ada)).toBe(false);
});

test("a command is told who runs it; a keeper command is refused to players and observers, run for the Keeper and for an admin", async () => {
  const seen: Json[] = [];
  const r = runner(
    defineModule({
      id: "clockwork",
      commands: {
        advance: {
          title: "Advance",
          role: "keeper",
          run(_args, who, fx, _room, call) {
            seen.push([call.by, who.member?.name ?? null]);
            fx.fact({ text: "time passes" });
            return { text: call.by === "keeper" ? "advanced; the omen is due" : "advanced" };
          },
        },
        look: { title: "Look", run: (_args, _who, _fx, _room, call) => ({ text: call.by }) },
        wipe: { title: "Wipe", role: "admin", run: () => ({ text: "wiped" }) },
      },
    }),
  );
  const call = (command: string, by: "keeper" | "member", who: Who) => r.command({ module: "clockwork", command, args: {}, who, by, seed: "s", room: room(1) });
  for (const member of [ada, eve]) {
    const refused = await call("advance", "member", member);
    expect(refused.outcome).toEqual({ status: "refused", reason: "role" });
    expect(refused.effects).toEqual([]);
  }
  expect(seen).toEqual([]);
  const kept = await call("advance", "keeper", ada);
  expect(kept.outcome).toEqual({ status: "ok", result: { text: "advanced; the omen is due" } });
  expect(kept.effects.map((effect) => effect.kind)).toEqual(["fact"]);
  expect(seen).toEqual([["keeper", "Ada"]]);
  // An admin runs it too, and the module is told it was a member's call.
  const repaired = await call("advance", "member", mo);
  expect(repaired.outcome).toEqual({ status: "ok", result: { text: "advanced" } });
  expect(seen.at(-1)).toEqual(["member", "Mo"]);
  expect((await call("look", "keeper", eve)).outcome).toEqual({ status: "ok", result: { text: "keeper" } });
  expect((await call("look", "member", ada)).outcome).toEqual({ status: "ok", result: { text: "member" } });
  expect((await call("wipe", "keeper", mo)).outcome).toEqual({ status: "refused", reason: "role" });
  expect((await call("wipe", "member", mo)).outcome).toEqual({ status: "ok", result: { text: "wiped" } });
});

test("a throwing call loses its effects and its state; the sibling keeps both", async () => {
  const r = runner(counterModule("a"), counterModule("b"));
  await r.turnStart(turn("one"));
  const value = await r.turnStart(turn("throw", 2));
  // Both threw here because both see "throw": use commands for the sibling case below.
  expect(value.failures.map((failure) => failure.module)).toEqual(["a", "b"]);
  expect(value.effects).toEqual([]);
  expect(r.checkpointOf("a")).toEqual({ count: 1 });

  const failed = await r.command({ module: "a", command: "bump", args: { fail: true }, who: ada, by: "member", seed: "c", room: room(2) });
  expect(failed.outcome).toEqual({ status: "failed", error: "Error: bump failed" });
  expect(failed.effects).toEqual([]);
  expect(failed.checkpoints).toEqual({});
  const ok = await r.command({ module: "b", command: "bump", args: { by: 5 }, who: ada, by: "member", seed: "c", room: room(2) });
  expect(ok.outcome).toEqual({ status: "ok", result: { text: "6" } });
  expect(ok.checkpoints).toEqual({ b: { count: 6 } });
  const next = await r.turnStart(turn("two", 3));
  expect(next.effects.map((effect) => (effect.kind === "inject" ? effect.text : ""))).toEqual(["a 2 two", "b 7 two"]);
});

test("read-only calls leave no trace, even when the handler mutates", async () => {
  const r = runner(counterModule("a"));
  await r.turnStart(turn("one"));
  const rendered = await r.render({ viewers: [asking(ada, "a", "count"), asking(mo, "a", "count")], room: room(1) });
  // Each viewer starts from the checkpoint: the second viewer does not see the first's change.
  expect(rendered.notices).toEqual([{ module: "a", code: "read_changed_state" }]);
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
    const value = await r.command({ module: "a", command, args: {}, who: ada, by: "member", seed: "s", room: room(1) });
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
  const rendered = await r.render({ viewers: [asking(ada, "fragile", "v")], room: room(1) });
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

  const peek = await r.command({ module: "second", command: "peek", args: {}, who: ada, by: "member", seed: "s", room: room(1, variables) });
  expect(peek.outcome).toEqual({ status: "ok", result: { data: { hp: 7 } } });
  const rendered = await r.render({ viewers: [{ who: ada, views: [{ module: "first", view: "hp" }, { module: "second", view: "hp" }] }, { who: mo, views: [{ module: "first", view: "hp" }, { module: "second", view: "hp" }] }], room: room(1, variables) });
  expect(rendered.viewers.map((viewer) => viewer.views.map((view) => ("data" in view ? view.data : null)))).toEqual([
    [7, 7],
    [7, 7],
  ]);
});

/** A module that counts its loads and lets the test see what each view read found. */
function ledger(id: string) {
  const counts = { loads: 0, availables: 0, reads: [] as string[] };
  let marks = 0;
  const definition = defineModule({
    id,
    create() {
      marks = 0;
    },
    load(snapshot) {
      counts.loads += 1;
      marks = (snapshot as { marks: number }).marks;
    },
    save: () => ({ marks }),
    commands: {
      gated: {
        title: "Gated",
        available(who) {
          counts.availables += 1;
          return who.member?.role === "admin" ? true : "Admins only today.";
        },
        run: () => ({ text: "ran" }),
      },
    },
    views: {
      first: {
        schema: {},
        for(who) {
          // A read that changes state: what the viewer's NEXT view finds.
          marks += 1;
          counts.reads.push(`first:${who.member?.name}:${marks}`);
          return marks;
        },
      },
      second: {
        schema: {},
        for(who) {
          counts.reads.push(`second:${who.member?.name}:${marks}`);
          return marks;
        },
      },
      unwatched: {
        schema: {},
        for() {
          counts.reads.push("unwatched");
          return 0;
        },
      },
    },
  });
  return { definition, counts };
}

test("a render reads only the views each viewer asked for and restores once per viewer", async () => {
  const { definition, counts } = ledger("ledger");
  const idle = ledger("idle");
  const r = runner(definition, idle.definition);
  const before = counts.loads;
  const rendered = await r.render({ viewers: [asking(ada, "ledger", "first", "second"), asking(mo, "ledger", "second")], room: room(1) });
  expect(rendered.viewers.map((viewer) => viewer.views.map((view) => view.view))).toEqual([["first", "second"], ["second"]]);
  // Ada's second view sees what her first did; Mo starts from the checkpoint again.
  expect(counts.reads).toEqual(["first:Ada:1", "second:Ada:1", "second:Mo:0"]);
  // One restore per viewer, none per read; a module nobody asked a view of is not touched.
  expect(counts.loads - before).toBe(2);
  expect(idle.counts.reads).toEqual([]);
  expect(idle.counts.loads).toBe(0);
});

test("a read that changes state is reported once per runner, and never reaches another viewer or the next render", async () => {
  const { definition, counts } = ledger("ledger");
  const r = runner(definition);
  const once = await r.render({ viewers: [asking(ada, "ledger", "first"), asking(mo, "ledger", "first")], room: room(1) });
  expect(once.viewers.map((viewer) => viewer.views)).toEqual([[{ module: "ledger", view: "first", data: 1 }], [{ module: "ledger", view: "first", data: 1 }]]);
  expect(once.notices).toEqual([{ module: "ledger", code: "read_changed_state" }]);
  const twice = await r.render({ viewers: [asking(ada, "ledger", "first")], room: room(1) });
  expect(twice.viewers[0]?.views).toEqual([{ module: "ledger", view: "first", data: 1 }]);
  expect(twice.notices).toEqual([]);
  expect(r.checkpointOf("ledger")).toEqual({ marks: 0 });
  // A read that changes nothing is never reported.
  const quiet = runner(ledger("quiet").definition);
  expect((await quiet.render({ viewers: [asking(ada, "quiet", "second")], room: room(1) })).notices).toEqual([]);
  expect(counts.reads.length).toBe(3);
});

test("a render never asks a command's available; the moment of use still does", async () => {
  const { definition, counts } = ledger("ledger");
  const r = runner(definition);
  await r.render({ viewers: [asking(ada, "ledger", "second"), asking(mo, "ledger", "second")], room: room(1) });
  expect(counts.availables).toBe(0);
  const refused = await r.command({ module: "ledger", command: "gated", args: {}, who: ada, by: "member", seed: "s", room: room(1) });
  expect(refused.outcome).toEqual({ status: "refused", reason: "unavailable", text: "Admins only today." });
  const ran = await r.command({ module: "ledger", command: "gated", args: {}, who: mo, by: "member", seed: "s", room: room(1) });
  expect(ran.outcome).toEqual({ status: "ok", result: { text: "ran" } });
  expect(counts.availables).toBe(2);
});

test("create and load get the manifest's options and a seed of the room and the module; run gets the call's seed", async () => {
  const inits: [string, ModuleInit][] = [];
  const seeds: string[] = [];
  const definition = defineModule({
    id: "seeded",
    create(init) {
      inits.push(["create", init]);
    },
    load(_snapshot, init) {
      inits.push(["load", init]);
    },
    save: () => 1,
    commands: { go: { title: "Go", run: (_args, _who, _fx, _room, call) => void seeds.push(call.seed) } },
  });
  const r = new ModuleRunner({ dice });
  r.load([{ path: "seeded", definition, options: { depth: 3 } }], {}, "room-a:1");
  r.load([{ path: "seeded", definition, options: { depth: 3 } }], { seeded: 1 }, "room-a:1");
  r.load([{ path: "seeded", definition }], {}, "room-a:2");
  expect(inits).toEqual([
    ["create", { options: { depth: 3 }, seed: "room-a:1:seeded" }],
    ["load", { options: { depth: 3 }, seed: "room-a:1:seeded" }],
    ["create", { options: {}, seed: "room-a:2:seeded" }],
  ]);
  await r.command({ module: "seeded", command: "go", args: {}, who: ada, by: "member", seed: "room-a:2:7:command", room: room(7) });
  await r.command({ module: "seeded", command: "go", args: {}, who: ada, by: "keeper", seed: "room-a:7:command:1", room: room(7) });
  expect(seeds).toEqual(["room-a:2:7:command", "room-a:7:command:1"]);
});

test("keeper: false is a member's own verb: the Keeper may not run it, a member may", async () => {
  expect(keeperMayRun("player", false)).toBe(false);
  expect(keeperMayRun(undefined, undefined)).toBe(true);
  expect(keeperMayRun("admin", true)).toBe(false);
  const r = runner(defineModule({ id: "verbs", commands: { wave: { title: "Wave", keeper: false, run: () => ({ text: "waved" }) } } }));
  const by = async (who: Who, origin: "keeper" | "member") => (await r.command({ module: "verbs", command: "wave", args: {}, who, by: origin, seed: "s", room: room(1) })).outcome;
  expect(await by(ada, "keeper")).toEqual({ status: "refused", reason: "role" });
  expect(await by(ada, "member")).toEqual({ status: "ok", result: { text: "waved" } });
});
