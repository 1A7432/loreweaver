import { afterEach, expect, test } from "bun:test";

import type { Json, Who } from "loreweaver/module";
import { NOBODY } from "loreweaver/runner";

import {
  DEFAULT_CAPS,
  dispatchCommand,
  dispatchRender,
  dispatchReplyPhase,
  dispatchToolUse,
  dispatchTurnStart,
  describeModules,
  type ModuleInfo,
  validateCommand,
  validateLoad,
  validateRender,
  validateReplyPhase,
  validateToolUse,
  validateTurnStart,
} from "../../src/agent/modules.ts";
import { RoomWorker } from "../../src/infra/room_worker.ts";
import { spawnWorker, type WorkerHandle } from "../../src/infra/runtime/worker.ts";
import { fixtureModule, WORKER_ENTRY } from "../helpers.ts";

const ada: Who = { member: { id: "m-ada", name: "Ada", role: "player" }, character: { id: "hero", name: "Hero" } };
const mo: Who = { member: { id: "m-mo", name: "Mo", role: "admin" }, character: null };
const eve: Who = { member: { id: "m-eve", name: "Eve", role: "observer" }, character: null };

const ROOM = { turn: 1, variables: {}, clock: null };

const workers: RoomWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

function worker(modules: string[], options: { timeoutMs?: number; posts?: string[] } = {}): RoomWorker {
  const spawn = (): WorkerHandle => {
    const inner = spawnWorker(WORKER_ENTRY);
    return {
      post: (message) => {
        options.posts?.push((message as { op: string }).op);
        inner.post(message);
      },
      onMessage: (listener) => {
        inner.onMessage(listener);
      },
      terminate: () => inner.terminate(),
    };
  };
  const created = new RoomWorker(spawn, modules.map(fixtureModule), { timeoutMs: options.timeoutMs ?? 2000 });
  workers.push(created);
  return created;
}

function call(effects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { effects, checkpoints: {}, failures: [], refused: [], broken: [], ...extra };
}

const x = (n: number): string => "x".repeat(n);
/** A JSON value whose text is at least `bytes` bytes. */
const blob = (bytes: number): Json => ({ s: x(bytes) });

function command(name: string, extra: Record<string, unknown> = {}) {
  return { name, title: "T", description: null, params: { type: "object" }, text: [], role: "player", available: false, ...extra };
}

function described(extra: Record<string, unknown> = {}) {
  return { id: "m", path: "/m.ts", events: { turnStart: true }, commands: [], views: [], clock: false, characters: false, ...extra };
}

// ---------------------------------------------------------------- load

test("load: unusable names are left out and reported; prototype names never pass", () => {
  const { modules, problems } = validateLoad({
    modules: [
      described({
        commands: [command("constructor"), command("__proto__"), command("Shout"), command("ok"), command("ok")],
        views: [
          { name: "constructor", title: null, schema: {} },
          { name: "status", title: "Status", schema: { type: "object" } },
        ],
      }),
      described({ id: "__proto__" }),
      described({ id: "constructor" }),
      described({ id: "m" }),
    ],
  });
  expect(modules.map((module) => module.id)).toEqual(["m"]);
  expect(modules[0]?.commands.map((entry) => entry.name)).toEqual(["ok"]);
  expect(modules[0]?.views).toEqual([{ name: "status", title: "Status", schema: { type: "object" } }]);
  expect(problems).toHaveLength(8);
  expect(problems.join("\n")).toContain('command "constructor" left out, not a usable name');
  expect(problems.join("\n")).toContain('command "ok" left out, declared twice');
});

test("load: command and view tables are capped; malformed entries are left out", () => {
  const many = Array.from({ length: 70 }, (_, i) => command(`c${i}`));
  const views = Array.from({ length: 40 }, (_, i) => ({ name: `v${i}`, title: null, schema: {} }));
  const { modules, problems } = validateLoad({ modules: [described({ commands: many, views })] });
  expect(modules[0]?.commands).toHaveLength(DEFAULT_CAPS.commands);
  expect(modules[0]?.views).toHaveLength(DEFAULT_CAPS.views);
  expect(problems).toHaveLength(6 + 8);

  const bad = validateLoad({
    modules: [
      described({
        commands: [
          command("no_title", { title: null }),
          command("long_title", { title: x(201) }),
          command("bad_params", { params: { type: "string" } }),
          command("bad_text", { text: ["", "ok"] }),
          command("bad_role", { role: "observer" }),
          command("long_description", { description: x(2001) }),
          command("good", { text: ["go {where}"], role: "admin", available: true }),
          command("keepers", { role: "keeper" }),
        ],
      }),
    ],
  });
  expect(bad.modules[0]?.commands).toEqual([
    { name: "good", title: "T", description: "", params: { type: "object" }, text: ["go {where}"], role: "admin", checksAvailability: true },
    { name: "keepers", title: "T", description: "", params: { type: "object" }, text: [], role: "keeper", checksAvailability: false },
  ]);
  expect(bad.problems).toHaveLength(6);
});

test("load: a second clock claim is dropped and both modules are named", () => {
  const { modules, problems } = validateLoad({ modules: [described({ id: "sun", clock: true }), described({ id: "moon", clock: true })] });
  expect(modules.map((module) => module.clock)).toEqual([true, false]);
  expect(problems).toEqual(["modules sun and moon both claim the room's clock; moon's claim was dropped"]);
});

// ---------------------------------------------------------------- effects and caps

test("turn start: 8 injections per turn, 4,000 characters each, counted in code points", () => {
  const effects = [
    { module: "a", kind: "inject", text: "😀".repeat(4000) },
    { module: "a", kind: "inject", text: x(4001) },
    ...Array.from({ length: 9 }, (_, i) => ({ module: i < 5 ? "a" : "b", kind: "inject", text: `s${i}` })),
    { module: "b", kind: "inject", text: "   " },
  ];
  const outcome = validateTurnStart(call(effects));
  expect(outcome.injections).toEqual(["😀".repeat(4000), "s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  expect(outcome.problems).toEqual([
    "module a: inject dropped, longer than 4000 characters",
    "module b: inject dropped, the turn already has 8 injections",
    "module b: inject dropped, the turn already has 8 injections",
    "module b: inject dropped, the turn already has 8 injections",
  ]);
});

test("facts: 32 per call per module; text 2,000 characters; data 16 KB; options checked", () => {
  const fact = (module: string, extra: Record<string, unknown>) => ({ module, kind: "fact", to: "table", importance: "normal", narrateNow: false, ...extra });
  const effects = [
    ...Array.from({ length: 33 }, (_, i) => fact("a", { text: `a${i}` })),
    fact("b", { text: x(2000) }),
    fact("b", { text: x(2001) }),
    fact("b", { data: blob(16 * 1024) }),
    fact("b", { data: { ok: true } }),
    fact("b", {}),
    fact("b", { text: "t", to: "member" }),
    fact("b", { text: "t", narrateNow: "yes" }),
  ];
  const outcome = validateReplyPhase(call(effects));
  expect(outcome.facts.filter((entry) => entry.module === "a")).toHaveLength(32);
  expect(outcome.facts.filter((entry) => entry.module === "b").map((entry) => [entry.text?.length ?? null, entry.data])).toEqual([
    [2000, null],
    [null, { ok: true }],
  ]);
  expect(outcome.problems).toHaveLength(6);
});

test("variable writes: 32 per call; path 200 characters; value 16 KB", () => {
  const write = (path: unknown, value: unknown) => ({ module: "a", kind: "setVar", path, value });
  const effects = [
    write(x(200), 1),
    write(x(201), 1),
    write("", 1),
    write("big", blob(16 * 1024)),
    write("nan", Number.NaN),
    ...Array.from({ length: 30 }, (_, i) => write(`v${i}`, i)),
  ];
  const outcome = validateReplyPhase(call(effects));
  // 5 counted before the cap is reached, then 27 more of the 30.
  expect(outcome.writes.map((entry) => entry.path)).toEqual([x(200), ...Array.from({ length: 27 }, (_, i) => `v${i}`)]);
  expect(outcome.problems).toHaveLength(4 + 3);
});

test("blocks: 8 emissions per call, 64 KB each; rolls: 16 per call", () => {
  const effects = [
    { module: "a", kind: "blocks", blocks: [blob(64 * 1024)] },
    { module: "a", kind: "blocks", blocks: "not a list" },
    ...Array.from({ length: 8 }, (_, i) => ({ module: "a", kind: "blocks", blocks: [{ i }], id: `b${i}` })),
    ...Array.from({ length: 17 }, (_, i) => ({ module: "a", kind: "roll", notation: "1d6", total: i, text: `1d6 (${i}) = ${i}` })),
    { module: "b", kind: "roll", notation: "1d6", total: Number.POSITIVE_INFINITY, text: "t" },
  ];
  const outcome = validateReplyPhase(call(effects));
  expect(outcome.blocks.map((entry) => entry.id)).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
  expect(outcome.rolls).toHaveLength(16);
  expect(outcome.problems).toHaveLength(2 + 2 + 1 + 1);
});

test("an effect is accepted only where it belongs; logs are capped too", () => {
  const outcome = validateReplyPhase(
    call([
      { module: "a", kind: "inject", text: "late" },
      { module: "a", kind: "deny", callId: "c", reason: "r" },
      { module: "a", kind: "log", text: x(2001) },
      { module: "a", kind: "log", text: "fine" },
      { module: "a", kind: "teleport" },
    ]),
  );
  expect(outcome.logs).toEqual([{ module: "a", text: "fine" }]);
  expect(outcome.problems).toEqual([
    "module a: inject dropped, not accepted in this exchange",
    "module a: deny dropped, not accepted in this exchange",
    "module a: log dropped, not a string of up to 2000 characters",
    "module a: teleport dropped, not accepted in this exchange",
  ]);
});

test("hostile shapes: inherited properties, class instances, non-JSON numbers and bad module ids are refused", () => {
  const inherited = Object.create({ module: "a", kind: "inject", text: "from the prototype" }) as object;
  class Box {
    readonly value = 1;
  }
  const outcome = validateTurnStart(
    call([
      inherited,
      { module: "a", kind: "setVar", path: "p", value: new Box() },
      { module: "a", kind: "setVar", path: "p", value: [1, , 3] },
      { module: "constructor", kind: "inject", text: "x" },
      { module: "a", kind: "setVar", path: "p", value: JSON.parse('{"__proto__": {"polluted": 1}}') as Json },
      null,
      "inject",
    ]),
  );
  expect(outcome.injections).toEqual([]);
  expect(outcome.writes).toHaveLength(1);
  expect(outcome.writes[0]?.value).toEqual(JSON.parse('{"__proto__": {"polluted": 1}}') as Json);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(outcome.problems).toHaveLength(6);
  for (const raw of [null, 42, "x", [], { effects: "nope" }, Object.create({ effects: [{ module: "a", kind: "inject", text: "x" }] }) as object]) {
    expect(validateTurnStart(raw).injections).toEqual([]);
    expect(validateCommand(raw).status).toBe("failed");
  }
});

test("failures, refusals and broken modules become problems", () => {
  const outcome = validateReplyPhase(
    call([], {
      failures: [{ module: "a", error: "Error: boom" }],
      refused: [{ module: "a", kind: "inject", reason: "wrong_place" }],
      broken: ["a"],
    }),
  );
  expect(outcome.problems).toEqual([
    "module a: Error: boom",
    "module a: fx.inject dropped in the worker (wrong_place)",
    "module a: its restore failed; the worker is restarted from the checkpoints",
  ]);
});

test("command results: text 4,000 characters, data 256 KB, dropped field by field", () => {
  const ok = (result: unknown) => validateCommand(call([], { outcome: { status: "ok", result } }));
  expect(ok({ text: x(4000), data: { a: 1 } })).toMatchObject({ status: "ok", result: { text: x(4000), data: { a: 1 } }, problems: [] });
  const over = ok({ text: x(4001), data: blob(256 * 1024) });
  expect(over).toMatchObject({ status: "ok", result: { text: null, data: null } });
  expect(over.problems).toHaveLength(2);
  expect(validateCommand(call([], { outcome: { status: "refused", reason: "unavailable", text: "sit first" } }))).toEqual({
    status: "refused",
    reason: "unavailable",
    text: "sit first",
    problems: [],
  });
  expect(validateCommand(call([{ module: "a", kind: "fact", text: "x" }], { outcome: { status: "failed", error: "e" } })).status).toBe("failed");
});

test("tool veto: one verdict per call in call order; denials of unknown calls are dropped", () => {
  const outcome = validateToolUse(
    call([
      { module: "a", kind: "deny", callId: "c2", reason: "no" },
      { module: "b", kind: "deny", callId: "c2", reason: "never" },
      { module: "b", kind: "deny", callId: "ghost", reason: "?" },
      { module: "b", kind: "deny", callId: "c1", reason: x(501) },
    ]),
    [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
  );
  expect(outcome.verdicts).toEqual([
    { allowed: true },
    { allowed: false, denials: [{ module: "a", reason: "no" }, { module: "b", reason: "never" }] },
    { allowed: true },
  ]);
  expect(outcome.problems).toHaveLength(2);
});

// ---------------------------------------------------------------- render

const info: ModuleInfo[] = [
  {
    id: "m",
    events: { turnStart: false, toolUse: false, replyPhase: false },
    commands: [
      { name: "open", title: "Open", description: "", params: { type: "object" }, text: [], role: "player", checksAvailability: false },
      { name: "sit", title: "Sit", description: "", params: { type: "object" }, text: [], role: "player", checksAvailability: true },
      { name: "boss", title: "Boss", description: "", params: { type: "object" }, text: [], role: "admin", checksAvailability: false },
    ],
    views: [
      { name: "status", title: null, schema: {} },
      { name: "huge", title: null, schema: {} },
    ],
    clock: true,
    characters: true,
  },
];

test("render: the role rule, availability failing closed, views capped at 512 KB", () => {
  const raw = {
    viewers: [
      {
        views: [
          { module: "m", view: "status", data: { hp: 1 } },
          { module: "m", view: "huge", data: blob(512 * 1024) },
          { module: "m", view: "undeclared", data: 1 },
        ],
        available: [{ module: "m", command: "sit", verdict: true }],
      },
      { views: [{ module: "m", view: "status", error: "Error: no" }], available: [{ module: "m", command: "sit", verdict: "sit down" }] },
      { views: [], available: [] },
    ],
    characters: [],
    clock: null,
    failures: [],
    broken: [],
  };
  const outcome = validateRender(raw, [ada, mo, eve], info);
  expect(outcome.viewers[0]).toEqual({
    views: [{ module: "m", view: "status", data: { hp: 1 } }],
    commands: [
      { module: "m", command: "open", availability: { available: true } },
      { module: "m", command: "sit", availability: { available: true } },
      { module: "m", command: "boss", availability: { available: false, reason: "role", text: null } },
    ],
  });
  expect(outcome.viewers[1]?.commands.map((entry) => entry.availability)).toEqual([
    { available: true },
    { available: false, reason: "module", text: "sit down" },
    { available: true },
  ]);
  // An observer uses nothing; a missing verdict is "not available", never "available".
  expect(outcome.viewers[2]?.commands.map((entry) => entry.availability.available)).toEqual([false, false, false]);
  expect(outcome.problems).toHaveLength(2);
});

test("render: characters and the clock are validated; a clock from a non-claimer is dropped", () => {
  const character = (extra: Record<string, unknown>) => ({ id: "c", name: "C", ...extra });
  const outcome = validateRender(
    {
      viewers: [],
      characters: [
        {
          module: "m",
          characters: [
            character({ resources: [{ id: "hp", label: "HP", value: 3, max: 5 }, { id: "x", label: "X", value: "3" }] }),
            character({}),
            character({ id: "" }),
            character({ id: "d", blurb: x(2001) }),
            ...Array.from({ length: 70 }, (_, i) => character({ id: `n${i}` })),
          ],
        },
      ],
      clock: { module: "m", reading: { time: "dusk", round: 2 } },
    },
    [],
    info,
  );
  expect(outcome.characters[0]).toEqual({ module: "m", id: "c", name: "C", blurb: null, resources: [{ id: "hp", label: "HP", value: 3, max: 5 }] });
  expect(outcome.characters).toHaveLength(DEFAULT_CAPS.characters);
  expect(outcome.clock).toEqual({ module: "m", time: "dusk", round: 2 });
  expect(validateRender({ viewers: [], characters: [], clock: { module: "other", reading: { time: "noon" } } }, [], info).clock).toBeNull();
});

// ---------------------------------------------------------------- end to end

test("dispatch: greedy modules are capped end to end; problems name the module", async () => {
  const outcome = await dispatchTurnStart(worker(["greedy"]), { turn: 1, seed: "s", text: "go", who: ada, variables: {}, clock: null });
  expect(outcome.injections).toHaveLength(8);
  expect(outcome.facts).toHaveLength(32);
  expect(outcome.rolls).toHaveLength(16);
  expect(outcome.problems.every((problem) => problem.startsWith("module greedy:"))).toBe(true);
  expect(outcome.problems).toHaveLength(3 + 1 + 1);
});

test("dispatch: a command left out at load is refused without a round trip, and so are bad arguments", async () => {
  const posts: string[] = [];
  const w = worker(["bad_names"], { posts });
  const first = await describeModules(w);
  expect(first.modules[0]?.commands.map((entry) => entry.name)).toEqual(["ok"]);
  expect(first.problems).toHaveLength(5);
  expect((await describeModules(w)).problems).toEqual([]);
  const base = { module: "bad_names", who: ada, by: "member" as const, seed: "s", room: ROOM };
  expect(await dispatchCommand(w, { ...base, command: "constructor", args: {} })).toMatchObject({ status: "refused", reason: "unknown" });
  expect(await dispatchCommand(w, { ...base, command: "ok", args: [] })).toMatchObject({ status: "refused", reason: "invalid" });
  expect(await dispatchCommand(w, { ...base, command: "ok", args: { big: x(70_000) } })).toMatchObject({ status: "refused", reason: "invalid" });
  expect(await dispatchCommand(w, { ...base, command: "ok", args: {}, who: eve })).toMatchObject({ status: "refused", reason: "role" });
  expect(posts).toEqual(["load"]);
  expect(await dispatchCommand(w, { ...base, command: "ok", args: {} })).toMatchObject({ status: "ok", result: { text: "ok", data: null } });
  expect(posts).toEqual(["load", "command"]);
});

test("render: a keeper command is part of an admin's commands and of no other viewer's", () => {
  const modules: ModuleInfo[] = [
    {
      id: "k",
      events: { turnStart: false, toolUse: false, replyPhase: false },
      commands: [
        { name: "open", title: "Open", description: "", params: { type: "object" }, text: [], role: "player", checksAvailability: false },
        { name: "advance", title: "Advance", description: "", params: { type: "object" }, text: [], role: "keeper", checksAvailability: true },
      ],
      views: [],
      clock: false,
      characters: false,
    },
  ];
  const verdict = [{ module: "k", command: "advance", verdict: true }];
  const raw = { viewers: [{ views: [], available: verdict }, { views: [], available: verdict }], characters: [], clock: null, failures: [], broken: [] };
  const outcome = validateRender(raw, [ada, mo], modules);
  // Ada plays; Mo is the admin. A verdict the worker sent for a player is not what lists it.
  expect(outcome.viewers.map((viewer) => viewer.commands.map((entry) => entry.command))).toEqual([["open"], ["open", "advance"]]);
  expect(outcome.problems).toEqual([]);
});

test("dispatch: who runs a command — a keeper command is refused to players and observers without a round trip; the Keeper never runs an admin one", async () => {
  const posts: string[] = [];
  const w = worker(["omens"], { posts });
  const base = { module: "omens", args: {}, seed: "s", room: ROOM };
  for (const who of [ada, eve]) {
    expect(await dispatchCommand(w, { ...base, command: "advance", who, by: "member" })).toMatchObject({ status: "refused", reason: "role", text: null });
  }
  for (const who of [ada, mo]) {
    expect(await dispatchCommand(w, { ...base, command: "wipe", who, by: "keeper" })).toMatchObject({ status: "refused", reason: "role", text: null });
  }
  expect(posts).toEqual(["load"]);
  expect(await dispatchCommand(w, { ...base, command: "advance", who: eve, by: "keeper" })).toMatchObject({
    status: "ok",
    result: { text: "keeper for Eve: hour 1, OMEN_DUE_AT_SIX" },
    facts: [{ module: "omens", text: "An hour passes (1)." }],
  });
  expect(await dispatchCommand(w, { ...base, command: "advance", who: NOBODY, by: "keeper" })).toMatchObject({ status: "ok", result: { text: "keeper for nobody: hour 2, OMEN_DUE_AT_SIX" } });
  expect(await dispatchCommand(w, { ...base, command: "look", who: ada, by: "keeper" })).toMatchObject({ status: "ok", result: { text: "keeper: the letter is in the well" } });
  expect(await dispatchCommand(w, { ...base, command: "look", who: ada, by: "member" })).toMatchObject({ status: "ok", result: { text: "member: you see the well" } });
  expect(await dispatchCommand(w, { ...base, command: "wipe", who: mo, by: "member" })).toMatchObject({ status: "ok", result: { text: "wiped" } });
  // An admin may run a keeper command — as a member, and the module is told so.
  expect(await dispatchCommand(w, { ...base, command: "advance", who: mo, by: "member" })).toMatchObject({ status: "ok", result: { text: expect.stringContaining("member for Mo") } });
});

test("dispatch: render and tool veto through a real worker; a hung veto allows every call", async () => {
  const w = worker(["kitchen"]);
  const rendered = await dispatchRender(w, [ada, eve], ROOM);
  expect(rendered.viewers[0]?.views.map((view) => view.view)).toEqual(["status", "scratch"]);
  expect(rendered.viewers[1]?.commands.every((entry) => !entry.availability.available)).toBe(true);
  expect(rendered.characters.map((character) => character.id)).toEqual(["hero"]);
  expect(rendered.clock).toEqual({ module: "kitchen", time: "hp 10", round: 0 });
  expect(rendered.problems).toEqual([]);

  const veto = await dispatchToolUse(w, { ...ROOM, who: ada, calls: [{ id: "a", name: "forbidden", args: {} }, { id: "b", name: "look", args: {} }] });
  expect(veto.verdicts).toEqual([{ allowed: false, denials: [{ module: "kitchen", reason: "not here" }] }, { allowed: true }]);

  const hung = await dispatchToolUse(worker(["moody"], { timeoutMs: 200 }), { ...ROOM, who: ada, calls: [{ id: "a", name: "spin", args: {} }] });
  expect(hung.verdicts).toEqual([{ allowed: true }]);
  expect(hung.problems).toEqual([expect.stringContaining("toolUse did not answer within 200 ms")]);
  const none = await dispatchToolUse(null, { ...ROOM, who: ada, calls: [{ id: "a", name: "x", args: {} }] });
  expect(none).toEqual({ verdicts: [{ allowed: true }], logs: [], problems: [] });
});

test("the room snapshot: one module writing to its copy never changes what the next module sees", async () => {
  const w = worker(["scribbler", "peeker"]);
  const variables = { hp: 7, name: "Ada" };
  const started = await dispatchTurnStart(w, { turn: 2, seed: "s", text: "x", who: ada, variables, clock: null });
  expect(started.injections).toEqual(['turnStart 2 {"hp":7,"name":"Ada"}']);
  expect(variables).toEqual({ hp: 7, name: "Ada" });

  const replied = await dispatchReplyPhase(w, {
    turn: 2,
    seed: "s",
    reply: "r",
    rolls: [],
    clockAdvances: [],
    variableWrites: [],
    who: ada,
    variables,
    clock: { time: "dusk" },
  });
  expect(replied.logs).toEqual([{ module: "peeker", text: 'replyPhase 2 {"hp":7,"name":"Ada"} dusk' }]);

  const room = { turn: 3, variables, clock: { time: "night", round: 4 } };
  const rendered = await dispatchRender(w, [ada, mo], room);
  expect(rendered.viewers.map((viewer) => viewer.views.find((view) => view.view === "vars")?.data)).toEqual([
    { turn: 3, variables: { hp: 7, name: "Ada" }, clock: { time: "night", round: 4 } },
    { turn: 3, variables: { hp: 7, name: "Ada" }, clock: { time: "night", round: 4 } },
  ]);
  const used = await dispatchCommand(w, { module: "peeker", command: "vars", args: {}, who: ada, by: "member", seed: "s", room });
  expect(used).toMatchObject({ status: "ok", result: { data: { hp: 7, name: "Ada" } } });
});

test("a variables snapshot over the cap is not sent: the modules see {} and the operator is told", async () => {
  const w = worker(["peeker"]);
  const huge = { blob: x(DEFAULT_CAPS.variablesBytes) };
  const started = await dispatchTurnStart(w, { turn: 1, seed: "s", text: "x", who: ada, variables: huge, clock: null });
  expect(started.injections).toEqual(["turnStart 1 {}"]);
  expect(started.problems).toEqual([`the room's variables were not sent to the modules: not a JSON object of up to ${DEFAULT_CAPS.variablesBytes} bytes`]);

  const caps = { ...DEFAULT_CAPS, variablesBytes: 10 };
  const rendered = await dispatchRender(w, [ada], { turn: 1, variables: { a: "long enough" }, clock: null }, caps);
  expect(rendered.viewers[0]?.views[0]?.data).toEqual({ turn: 1, variables: {}, clock: null });
  expect(rendered.problems).toHaveLength(1);
  const fits = await dispatchRender(w, [ada], { turn: 1, variables: { a: 1 }, clock: null }, caps);
  expect(fits.viewers[0]?.views[0]?.data).toEqual({ turn: 1, variables: { a: 1 }, clock: null });
});
