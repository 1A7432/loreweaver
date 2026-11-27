// Who may run what, where an outcome goes, the `commands` view, the module seam, and the
// flows of the commands that change the room.
import { describe, expect, test } from "bun:test";
import { parseForm, type TextForm } from "loreweaver/runner";

import { CHARACTER_TYPE, type CharacterFullView, SEATING_ID, SEATING_TYPE, type SeatingView } from "../../../src/core/characters/index.ts";
import { INITIATIVE_ID, INITIATIVE_TYPE, type InitiativeView } from "../../../src/core/clock/index.ts";
import { VARIABLE_TREE_ID, VARIABLE_TREE_TYPE, type VariableTreeView } from "../../../src/core/variables/index.ts";
import { KEEPER_MUTED, type ModuleCommandEntry, ROOM_LOCALE, ROOM_RULE_VARIANT, type ModuleCommands } from "../../../src/gateway/commands/index.ts";
import { ADA, ADMIN, BAO, bench, code, EVE, ok, ROOM } from "./bench.ts";
import { seedRoster, seedVariables } from "./seed.ts";

describe("roles", () => {
  test("every admin command is refused to a player, with nothing for the table", async () => {
    const b = bench();
    const admin = b.registry.specs(b.context(ADA)).filter((spec) => spec.role === "admin");
    expect(admin.map((spec) => spec.id).sort()).toEqual(["ambience", "audio", "bgm", "chronicle", "habits", "imagegen", "key", "language", "npc", "reset", "save", "sfx", "skill", "undo", "var"]);
    for (const spec of admin) {
      const outcome = await b.run(ADA, spec.id, {});
      expect([spec.id, code(outcome)]).toEqual([spec.id, "forbidden"]);
      expect("events" in outcome).toBe(false);
    }
  });

  test("arguments that need the admin are refused to a player and accepted from the admin", async () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["rule", { variant: "rule2" }],
      ["bot", { on: false }],
      ["lore", { op: "add", title: "Town", content: "Quiet." }],
      ["lore", { op: "list", disabled: true }],
      ["init", { op: "roll", name: "Goblin", value: 5 }],
      ["pack", { op: "disable", id: "nothing-here" }],
    ];
    for (const [id, args] of cases) {
      const b = bench();
      expect([id, code(await b.run(ADA, id, args))]).toEqual([id, "forbidden"]);
      expect([id, (await b.run(ADMIN, id, args)).ok]).toEqual([id, true]);
    }
  });

  test("an observer may read help and the recap, and play nothing", async () => {
    const b = bench();
    expect(code(await b.run(EVE, "roll", {}))).toBe("forbidden");
    expect(ok(await b.run(EVE, "help", {})).text).toContain(".help");
    expect(ok(await b.run(EVE, "recap", {})).events).toEqual([]);
  });

  test("structured arguments are strict: unknown names, wrong types and over-long text are refused", async () => {
    const b = bench();
    expect(code(await b.run(ADA, "roll", { expr: "1d6", sides: 6 }))).toBe("unknown_arg");
    expect(code(await b.run(ADA, "roll", { repeat: "2" }))).toBe("invalid_arg");
    expect(code(await b.run(ADA, "roll", { repeat: 21 }))).toBe("invalid_arg");
    expect(code(await b.run(ADA, "roll", { expr: "1".repeat(1001) }))).toBe("invalid_arg");
    expect(code(await b.run(ADA, "sheet", {}))).toBe("missing_arg");
    expect(code(await b.run(ADA, "roll", ["1d6"]))).toBe("invalid_arg");
    expect(code(await b.run(ADA, "no_such", {}))).toBe("unknown_command");
  });
});

describe("where an outcome goes", () => {
  test("a public roll is a dice event, with nothing to say to the caller", async () => {
    const b = bench();
    const outcome = ok(await b.run(ADA, "roll", { expr: "2d6" }));
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("dice");
    expect(outcome.text).toBeUndefined();
  });

  test("a hidden roll is the caller's alone: no event", async () => {
    const b = bench();
    const outcome = ok(await b.run(ADA, "hidden_roll", { expr: "1d100" }));
    expect(outcome.events).toEqual([]);
    expect(outcome.text).toContain("1d100");
  });

  test("a failure is never an event", async () => {
    const b = bench();
    const outcome = await b.run(ADA, "roll", { expr: "1d" });
    expect(code(outcome)).toBe("bad_dice");
    expect("events" in outcome).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("1d");
  });

  test("a refusal rolls back what the handler wrote before refusing", async () => {
    const b = bench();
    seedRoster(b);
    // The roster character's stored payload is damaged: the claim seats Ada, then finds it unreadable.
    b.store.writer(ROOM).docPut(CHARACTER_TYPE, "pregen-holmes", 1, "not json", "{}");
    expect(code(await b.run(ADA, "pc", { op: "claim", name: "Holmes" }))).toBe("document_unreadable");
    expect(b.store.docGet(ROOM, SEATING_TYPE, SEATING_ID)).toBeNull();
  });

  test("a writer of a past generation is refused", async () => {
    const b = bench();
    await b.input(ADA, ".coc Alice");
    const stale = b.context(ADA);
    ok(await b.run(ADMIN, "undo", { turns: 1 }));
    const outcome = await b.registry.run(stale, "roll", {}, "en");
    expect(code(outcome)).toBe("stale_generation");
  });

  test("results are in the caller's language, table events in the room's", async () => {
    const b = bench();
    const outcome = ok(await b.registry.run(b.context(ADA, { locale: "zh" }), "hidden_roll", {}, "en"));
    expect(outcome.text).toStartWith("Hidden roll");
    const event = ok(await b.registry.run(b.context(ADA, { locale: "zh" }), "jrrp", {}, "en")).events[0];
    expect(event?.kind === "narrative" ? event.data.text : "").toContain("今天的人品");
    const refusal = await b.registry.run(b.context(ADA, { locale: "en" }), "npc", {}, "zh");
    if (refusal.ok) throw new Error("expected a refusal");
    expect(refusal.message).toBe("这需要房间管理员来做。");
  });
});

describe("the commands view", () => {
  test("a player sees the table's commands and no admin command", async () => {
    const b = bench();
    const view = await b.registry.view(b.context(ADA), "en");
    const ids = view.commands.map((entry) => entry.id);
    expect(ids).toContain("roll");
    expect(ids).toContain("rules.sanity_check");
    for (const hidden of ["var", "npc", "chronicle", "habits", "undo", "reset", "save", "language"]) expect(ids).not.toContain(hidden);
    const sanity = view.commands.find((entry) => entry.id === "rules.sanity_check");
    expect(sanity).toMatchObject({ source: "pack", title: "Sanity", available: true, text: { forms: ["sc", "sanity"] } });
    expect(view.commands.find((entry) => entry.id === "roll")?.params).toMatchObject({ type: "object" });
  });

  test("the admin sees every command; destructive ones are marked", async () => {
    const b = bench();
    const view = await b.registry.view(b.context(ADMIN), "en");
    const reset = view.commands.find((entry) => entry.id === "reset");
    expect(reset).toMatchObject({ role: "admin", danger: true, available: true });
    expect(view.commands.map((entry) => entry.id)).toContain("npc");
  });

  test("an observer sees the player's table, unavailable except what an observer may read", async () => {
    const b = bench();
    const view = await b.registry.view(b.context(EVE), "en");
    expect(view.commands.find((entry) => entry.id === "roll")).toMatchObject({ available: false, reason: "observer" });
    expect(view.commands.find((entry) => entry.id === "recap")).toMatchObject({ available: true });
  });

  test("availability follows the room's rule system", async () => {
    const none = bench({ system: null });
    const view = await none.registry.view(none.context(ADA), "en");
    expect(view.commands.find((entry) => entry.id === "check")).toMatchObject({ available: false, reason: "no_rule_system" });
    expect(code(await none.run(ADA, "check", { target: 50 }))).toBe("no_rule_system");
    const wod = bench({ system: "wod" });
    const wodView = await wod.registry.view(wod.context(ADA), "en");
    expect(wodView.commands.find((entry) => entry.id === "opposed")).toMatchObject({ available: false, reason: "not_in_system" });
    expect(wodView.commands.some((entry) => entry.id.startsWith("rules."))).toBe(false);
  });

  test("the view speaks the viewer's language", async () => {
    const b = bench();
    const view = await b.registry.view(b.context(ADA), "zh");
    expect(view.commands.find((entry) => entry.id === "roll")).toMatchObject({ title: "掷骰", text: { forms: ["r", "rd"] } });
  });
});

/** Forms read against `params`, as the load does. */
function forms(params: unknown, ...sources: string[]): TextForm[] {
  return sources.map((source) => {
    const read = parseForm(source, params);
    if (!read.ok) throw new Error(`bad form in the test: ${source}`);
    return read.form;
  });
}

/** A module seam over a fixed table that records what it is asked to run. */
function stubModules(entries: readonly ModuleCommandEntry[], calls: unknown[], listed: { now: boolean } = { now: true }): ModuleCommands {
  return {
    list: async () => entries,
    listNow: () => (listed.now ? entries : null),
    run: async (_context, id, args, locale) => {
      calls.push({ id, args, locale });
      return { ok: true, text: "done", events: [], signals: [] };
    },
  };
}

describe("module commands", () => {
  const calls: unknown[] = [];
  const attackParams = { type: "object", properties: { target: { type: "string" } } };
  const modules = stubModules(
    [
      { id: "demo/attack", module: "demo", title: "Attack", description: "Hit something.", params: attackParams, forms: forms(attackParams, "strike {target}"), role: "player", available: true },
      { id: "demo/rig", module: "demo", title: "Rig", description: "Admin only.", params: { type: "object" }, forms: [], role: "admin", available: true },
    ],
    calls,
  );

  test("are listed in the view by role and routed to the dispatcher from both entrances", async () => {
    const b = bench({ modules });
    const playerView = await b.registry.view(b.context(ADA), "en");
    expect(playerView.commands.filter((entry) => entry.source === "module").map((entry) => entry.id)).toEqual(["demo/attack"]);
    ok(await b.run(ADA, "demo/attack", { target: "door" }));
    const typed = await b.input(ADA, '.demo/attack {"target":"door"}');
    expect(typed.kind === "command" && typed.outcome.ok).toBe(true);
    expect(calls).toEqual([
      { id: "demo/attack", args: { target: "door" }, locale: "en" },
      { id: "demo/attack", args: { target: "door" }, locale: "en" },
    ]);
    expect(code(await b.run(EVE, "demo/attack", {}))).toBe("forbidden");
    const view = playerView.commands.find((entry) => entry.id === "demo/attack");
    expect(view?.text).toEqual({ forms: ["strike"], usage: ".strike {target}" });
    // Typed by its form, coerced and routed like the JSON form.
    await b.input(ADA, ".strike door");
    expect(calls.at(-1)).toEqual({ id: "demo/attack", args: { target: "door" }, locale: "en" });
  });
});

describe("module text forms", () => {
  const sayParams = { type: "object", properties: { text: { type: "string" }, loud: { type: "boolean" } } };
  const moveParams = { type: "object", properties: { steps: { type: "integer" }, pace: { type: "number" }, where: { type: "string" } } };
  const entries = (calls: unknown[]) =>
    stubModules(
      [
        { id: "talk/say", module: "talk", title: "Say", description: "", params: sayParams, forms: forms(sayParams, "say {text...}", "shout {loud} {text...}"), role: "player", available: true },
        {
          id: "walk/move",
          module: "walk",
          title: "Move",
          description: "",
          params: moveParams,
          // `go north {steps}` has more literal words than `go {where} {steps}`: it wins.
          forms: forms(moveParams, "go {where} {steps}", "go north {steps}", "pace {pace}", "前进 {steps}"),
          role: "player",
          available: true,
        },
        // `roll` is an engine word: the room's own command wins and the form is dropped.
        { id: "walk/tumble", module: "walk", title: "Tumble", description: "", params: { type: "object" }, forms: forms({}, "roll"), role: "player", available: true },
        // Two modules both claim `wave`: dropped for both.
        { id: "talk/wave", module: "talk", title: "Wave", description: "", params: { type: "object" }, forms: forms({}, "wave"), role: "player", available: true },
        { id: "walk/wave", module: "walk", title: "Wave", description: "", params: { type: "object" }, forms: forms({}, "wave"), role: "player", available: true },
      ],
      calls,
    );

  test("one word, the rest of the line, coercion by type, literal precedence", async () => {
    const calls: unknown[] = [];
    const b = bench({ modules: entries(calls) });
    expect((await b.input(ADA, ".say   hello there,  friend ")).kind).toBe("command");
    await b.input(ADA, ".SAY");
    await b.input(ADA, ".shout true Hey!");
    await b.input(ADA, ".go north 3");
    await b.input(ADA, ".go west 2");
    await b.input(ADA, ".pace 1.5");
    await b.input(ADA, "。前进 4", "zh");
    expect(calls).toEqual([
      { id: "talk/say", args: { text: "hello there,  friend" }, locale: "en" },
      { id: "talk/say", args: {}, locale: "en" },
      { id: "talk/say", args: { loud: true, text: "Hey!" }, locale: "en" },
      { id: "walk/move", args: { steps: 3 }, locale: "en" },
      { id: "walk/move", args: { where: "west", steps: 2 }, locale: "en" },
      { id: "walk/move", args: { pace: 1.5 }, locale: "en" },
      { id: "walk/move", args: { steps: 4 }, locale: "zh" },
    ]);
  });

  test("a word the forms take that no form fits is refused with the usage; a word they do not take is speech", async () => {
    const calls: unknown[] = [];
    const b = bench({ modules: entries(calls) });
    const wrong = await b.input(ADA, ".go");
    expect(wrong.kind === "command" ? code(wrong.outcome) : "speech").toBe("usage");
    expect(wrong.kind === "command" && !wrong.outcome.ok ? wrong.outcome.message : "").toContain(".go {where} {steps} | .go north {steps}");
    expect((await b.input(ADA, ".dance wildly")).kind).toBe("speech");
    expect(calls).toEqual([]);
  });

  test("the room's own words win, a word two modules claim is dropped for both, each reported once", async () => {
    const calls: unknown[] = [];
    const b = bench({ modules: entries(calls) });
    const rolled = await b.input(ADA, ".roll 1d6");
    expect(rolled.kind === "command" ? rolled.id : null).toBe("roll");
    expect((await b.input(ADA, ".wave")).kind).toBe("speech");
    expect(calls).toEqual([]);
    const drops = await b.registry.moduleFormDrops(b.context(ADA));
    expect(drops.map((drop) => [drop.code, drop.command, drop.form])).toEqual([
      ["word_taken", "walk/tumble", "roll"],
      ["word_shared", "talk/wave", "wave"],
      ["word_shared", "walk/wave", "wave"],
    ]);
    const said = b.reports.filter((line) => line.includes("text form"));
    expect(said).toHaveLength(3);
    await b.registry.view(b.context(ADA), "en");
    expect(b.reports.filter((line) => line.includes("text form"))).toHaveLength(3);
    // The view shows each command as it is really typed now.
    const view = await b.registry.view(b.context(ADA), "en");
    expect(view.commands.find((entry) => entry.id === "walk/move")?.text).toEqual({ forms: ["go", "pace", "前进"], usage: ".go {where} {steps} | .go north {steps} | .pace {pace} | .前进 {steps}" });
    expect(view.commands.find((entry) => entry.id === "walk/tumble")?.text).toBeUndefined();
    expect(view.commands.find((entry) => entry.id === "talk/wave")?.text).toBeUndefined();
  });

  test("a line may be a module's before the modules were ever loaded; known words only after", () => {
    const listed = { now: false };
    const b = bench({ modules: stubModules([{ id: "talk/say", module: "talk", title: "Say", description: "", params: sayParams, forms: forms(sayParams, "say {text...}"), role: "player", available: true }], [], listed) });
    expect(b.registry.mayBeModuleText(b.context(ADA), ".anything")).toBe(true);
    listed.now = true;
    expect(b.registry.mayBeModuleText(b.context(ADA), ".say hi")).toBe(true);
    expect(b.registry.mayBeModuleText(b.context(ADA), ".anything")).toBe(false);
    expect(b.registry.mayBeModuleText(b.context(ADA), ".talk/say {}")).toBe(true);
    expect(b.registry.mayBeModuleText(b.context(ADA), "plain speech")).toBe(false);
  });
});

describe("flows", () => {
  test("a creation word makes a character and seats its maker", async () => {
    const b = bench();
    const made = ok(await b.run(ADA, "new_character", { system: "dnd", name: "Tav" }));
    expect(made.data).toMatchObject({ name: "Tav", system: "dnd5e" });
    expect(b.context(ADA).who.character?.name).toBe("Tav");
    expect(code(await b.run(BAO, "new_character", { system: "coc7", name: "tav" }))).toBe("name_taken");
    expect(code(await b.run(ADA, "new_character", { system: "nope" }))).toBe("unknown_system");
  });

  test("setting a value on a fresh table makes a blank character of the room's system", async () => {
    const b = bench();
    const set = ok(await b.run(ADA, "sheet", { op: "set", writes: [{ name: "力量", op: "=", value: "65" }] }));
    expect(set.text).toContain("65");
    const shown = ok(await b.run(ADA, "sheet", { op: "show" }));
    expect((shown.data as CharacterFullView).owner).toBe(ADA.id);
    expect(code(await b.run(ADA, "sheet", { op: "set", writes: [{ name: "spot hidden x", op: "=", value: "5" }] }))).toBe("key_has_space");
  });

  test("a check reads the caller's stat; an unknown skill is refused, not rolled against 0", async () => {
    const b = bench();
    await b.input(ADA, ".coc Alice");
    const checked = ok(await b.run(ADA, "check", { skill: "侦查" }));
    const event = checked.events[0];
    expect(event?.kind === "dice" ? event.data.target : null).toBe(25);
    expect(code(await b.run(ADA, "check", { skill: "basket weaving" }))).toBe("unknown_skill");
    expect(code(await b.run(BAO, "check", { skill: "侦查" }))).toBe("no_character");
    expect(ok(await b.run(BAO, "check", { target: 40 })).events).toHaveLength(1);
  });

  test("the roster: claim, taken, release by the holder or the admin", async () => {
    const b = bench();
    seedRoster(b);
    ok(await b.run(ADA, "pc", { op: "claim", name: "holmes" }));
    expect(b.context(ADA).who.character).toEqual({ id: "pregen-holmes", name: "Holmes" });
    const sheet = ok(await b.run(ADA, "sheet", { op: "show" }));
    expect((sheet.data as CharacterFullView).owner).toBe(ADA.id);
    expect(code(await b.run(BAO, "pc", { op: "claim", name: "Holmes" }))).toBe("taken");
    expect(code(await b.run(BAO, "pc", { op: "release", name: "Holmes" }))).toBe("forbidden");
    expect(code(await b.run(ADA, "sheet", { op: "clear" }))).toBe("use_release");
    ok(await b.run(ADMIN, "pc", { op: "release", name: "Holmes" }));
    const seats = b.services.views.view(ROOM, SEATING_TYPE, SEATING_ID, { grade: "player", locale: "en" }) as SeatingView;
    expect(seats.seats).toEqual([]);
  });

  test("initiative: roll, a named combatant from the admin, next, clear", async () => {
    const b = bench();
    await b.input(ADA, ".coc Alice");
    ok(await b.run(ADA, "init", { op: "roll" }));
    ok(await b.run(ADMIN, "init", { op: "roll", name: "Goblin", value: 1 }));
    const next = ok(await b.run(BAO, "init", { op: "next" }));
    expect(next.events[0]?.kind).toBe("narrative");
    const view = b.services.views.view(ROOM, INITIATIVE_TYPE, INITIATIVE_ID, { grade: "player", locale: "en" }) as InitiativeView;
    expect(view.acting).toBe("Goblin");
    ok(await b.run(ADA, "init", { op: "clear" }));
    expect((b.services.views.view(ROOM, INITIATIVE_TYPE, INITIATIVE_ID, { grade: "player", locale: "en" }) as InitiativeView).order).toEqual([]);
  });

  test("room settings land in their declared state keys", async () => {
    const b = bench();
    ok(await b.run(ADMIN, "rule", { variant: "rule3" }));
    expect(b.store.stateGet(ROOM, ROOM_RULE_VARIANT)).toBe("rule3");
    expect(b.context(ADA).variant).toBe("rule3");
    expect(code(await b.run(ADMIN, "rule", { variant: "rule99" }))).toBe("unknown_variant");
    ok(await b.run(ADMIN, "rule", { variant: null }));
    expect(b.store.stateGet(ROOM, ROOM_RULE_VARIANT)).toBeNull();
    const language = ok(await b.run(ADMIN, "language", { locale: "zh" }));
    expect(b.store.stateGet(ROOM, ROOM_LOCALE)).toBe("zh");
    expect(language.events[0]?.kind === "narrative" ? language.events[0].data.text : "").toContain("中文");
    ok(await b.run(ADMIN, "bot", { on: false }));
    expect(b.store.stateGet(ROOM, KEEPER_MUTED)).toBe(true);
    expect(ok(await b.run(ADA, "bot", {})).data).toEqual({ on: false });
  });

  test("exposing a variable branch shows it to players", async () => {
    const b = bench();
    seedVariables(b);
    ok(await b.run(ADMIN, "var", { op: "expose", path: "plot" }));
    const player = b.services.views.view(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, { grade: "player", locale: "en" }) as VariableTreeView;
    expect(player.leaves.map((leaf) => leaf.path)).toEqual(["stats.hp", "plot.ending"]);
    ok(await b.run(ADMIN, "var", { op: "add", path: "stats.hp", delta: -3 }));
    expect(ok(await b.run(ADMIN, "var", { op: "list" })).text).toContain("stats.hp = 7");
    expect(code(await b.run(ADMIN, "var", { op: "set", path: "stats.mp", value: "3" }))).toBe("var_refused");
  });

  test("a branch is never replaced by a value: set and add on a branch are refused, naming its leaves", async () => {
    const b = bench();
    seedVariables(b);
    const before = b.services.views.view(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, { grade: "keeper", locale: "en" }) as VariableTreeView;
    for (const args of [
      { op: "set", path: "stats", value: "4" },
      { op: "add", path: "plot", delta: 1 },
    ]) {
      const refused = await b.run(ADMIN, "var", args);
      expect(code(refused)).toBe("var_branch");
      expect(refused.ok ? "" : refused.message).toContain(args.path === "stats" ? "stats.hp" : "plot.ending");
    }
    // Nothing of the tree moved.
    expect(b.services.views.view(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, { grade: "keeper", locale: "en" })).toEqual(before);
    // A leaf is written as before.
    expect(ok(await b.run(ADMIN, "var", { op: "set", path: "stats.hp", value: "4" })).text).toContain("stats.hp is now 4");
    expect(ok(await b.run(ADMIN, "var", { op: "set", path: "stats.hp", value: "4" }, "zh")).text).toContain("4");
  });
});
