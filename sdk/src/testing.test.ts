import { expect, test } from "bun:test";

import { defineModule, type ModuleDefinition } from "./module.ts";
import tally from "./test_fixtures/tally.ts";
import { createTestHost, who } from "./testing.ts";

const ada = who("Ada", { character: { id: "ada", name: "Ada" } });
const mo = who("Mo", { role: "admin" });
const eve = who("Eve", { role: "observer" });

function duel() {
  let hp = 10;
  return defineModule({
    id: "duel",
    create() {
      hp = 10;
    },
    load(snapshot) {
      hp = (snapshot as { hp: number }).hp;
    },
    save: () => ({ hp }),
    characters: () => [{ id: "ada", name: "Ada", resources: [{ id: "hp", label: "HP", value: hp, max: 10 }] }],
    clock: () => ({ time: `hp ${hp}`, round: 1 }),
    on: {
      turnStart(event, fx) {
        fx.inject(`${event.who.character?.name ?? "nobody"} at ${hp} hp`);
        fx.fact({ text: "the duel goes on" }, { to: "keeper", importance: "high" });
      },
      replyPhase(event, fx) {
        if (event.reply.includes("hit")) {
          const roll = fx.roll("1d6", "damage");
          hp -= roll.total;
          fx.setVar("duel.hp", hp);
          fx.blocks([{ type: "bar", value: hp }], { id: "hp" });
        }
      },
    },
    commands: {
      heal: {
        title: "Heal",
        role: "admin",
        run(_args, _who, fx) {
          hp = 10;
          fx.log("healed");
        },
      },
      strike: {
        title: "Strike",
        params: { type: "object", properties: { target: { type: "string" } } },
        text: ["strike {target}"],
        available: (viewer) => (viewer.character ? true : "sit down first"),
        run: (args) => ({ text: `you strike ${String(args.target)}` }),
      },
    },
    views: {
      hp: { title: "HP", schema: { type: "number" }, for: (viewer) => (viewer.character ? hp : null) },
    },
  });
}

test("events, effects and the clock reading the turn was given", async () => {
  const host = createTestHost(duel(), { dice: [4], who: ada });
  const started = await host.turnStart({ text: "I draw" });
  expect(started.injected).toEqual(["Ada at 10 hp"]);
  expect(started.facts).toEqual([{ module: "duel", kind: "fact", text: "the duel goes on", to: "keeper", importance: "high", narrateNow: false }]);
  expect(started.clock).toEqual({ time: "hp 10", round: 1 });

  const replied = await host.replyPhase({ reply: "a hit!" });
  expect(replied.rolls).toEqual([{ module: "duel", kind: "roll", notation: "1d6", label: "damage", total: 4, text: "1d6 = 4" }]);
  expect(replied.writes).toEqual([{ module: "duel", kind: "setVar", path: "duel.hp", value: 6 }]);
  expect(replied.blocks).toEqual([{ module: "duel", kind: "blocks", blocks: [{ type: "bar", value: 6 }], id: "hp" }]);
  expect(replied.checkpoint).toEqual({ hp: 6 });
  expect(host.checkpoint).toEqual({ hp: 6 });
});

test("commands run as a given who, with the role and availability checks", async () => {
  const host = createTestHost(duel());
  expect((await host.command("heal", {}, ada)).outcome).toEqual({ status: "refused", reason: "role" });
  expect((await host.command("heal", {}, eve)).outcome).toEqual({ status: "refused", reason: "role" });
  const healed = await host.command("heal", {}, mo);
  expect(healed.outcome).toEqual({ status: "ok", result: {} });
  expect(healed.logs).toEqual(["healed"]);
  expect((await host.command("strike", { target: "Bo" }, mo)).outcome).toEqual({ status: "refused", reason: "unavailable", text: "sit down first" });
  expect((await host.command("strike", { target: "Bo" }, ada)).outcome).toEqual({ status: "ok", result: { text: "you strike Bo" } });
  expect(await host.available("strike", ada)).toBe(true);
  expect(await host.available("strike", mo)).toBe("sit down first");
  expect(await host.available("heal", ada)).toBe("role");
  expect(host.description.commands.map((command) => [command.name, command.role, command.text])).toEqual([
    ["heal", "admin", []],
    ["strike", "player", ["strike {target}"]],
  ]);
});

test("views are per viewer; characters and clock read the state", async () => {
  const host = createTestHost(duel(), { snapshot: { hp: 3 } });
  expect(await host.view("hp", ada)).toBe(3);
  expect(await host.view("hp", mo)).toBeNull();
  expect(await host.characters()).toEqual([{ id: "ada", name: "Ada", resources: [{ id: "hp", label: "HP", value: 3, max: 10 }] }]);
  expect(await host.clock()).toEqual({ time: "hp 3", round: 1 });
});

test("tool veto verdicts come back in call order", async () => {
  const host = createTestHost(
    defineModule({
      id: "guard",
      on: {
        toolUse(event, fx) {
          for (const call of event.calls) if (call.args.secret === true) fx.deny(call.id, "keep it hidden");
        },
      },
    }),
  );
  const veto = await host.toolUse([{ name: "reveal", args: { secret: true } }, { name: "look" }]);
  expect(veto.verdicts).toEqual(["keep it hidden", true]);
});

test("a module that rolls without scripted dice fails its call, and the failure is reported", async () => {
  const host = createTestHost(duel());
  const replied = await host.replyPhase({ reply: "hit" });
  expect(replied.error).toContain("no scripted dice left");
  expect(replied.effects).toEqual([]);
});

test("restart: a fresh instance loaded from the checkpoint shows what save() forgot", async () => {
  let generation = 0;
  const host = createTestHost(tally, {
    fresh: async () => ((await import(`./test_fixtures/tally.ts?restart=${++generation}`)) as { default: ModuleDefinition }).default,
  });
  await host.command("hit", { note: "first" });
  expect(await host.view("tally")).toEqual({ hits: 1, notes: ["first"] });
  await host.restart();
  expect(await host.view("tally")).toEqual({ hits: 1, notes: [] });
});

test("argument keys named like prototype properties are plain data", async () => {
  const host = createTestHost(
    defineModule({
      id: "echo",
      commands: { echo: { title: "Echo", run: (args) => ({ data: { keys: Object.keys(args), args } }) } },
    }),
  );
  const args = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}') as Record<string, never>;
  const echoed = await host.command("echo", args);
  expect(echoed.outcome).toEqual({ status: "ok", result: { data: { keys: ["__proto__", "constructor"], args } } });
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("the room snapshot: per call, with defaults of turn 1, no variables and no clock", async () => {
  const host = createTestHost(
    defineModule({
      id: "mirror",
      characters: (room) => [{ id: "c", name: `turn ${room.turn}` }],
      clock: (room) => ({ time: room.clock ? `after ${room.clock.time}` : "start" }),
      on: {
        replyPhase(event, fx) {
          fx.log(`${event.turn} ${JSON.stringify(event.variables)} ${event.clock?.time ?? "none"}`);
        },
      },
      commands: { show: { title: "Show", run: (_args, _who, _fx, room) => ({ data: room.variables }) } },
      views: { vars: { schema: {}, for: (_who, room) => room.variables } },
    }),
    { variables: { mood: "calm" } },
  );
  expect(await host.view("vars")).toEqual({ mood: "calm" });
  expect(await host.view("vars", undefined, { variables: { mood: "tense" } })).toEqual({ mood: "tense" });
  expect((await host.command("show", {}, undefined, { variables: { x: 1 } })).outcome).toEqual({ status: "ok", result: { data: { x: 1 } } });
  expect(await host.characters()).toEqual([{ id: "c", name: "turn 1" }]);
  expect(await host.clock()).toEqual({ time: "start" });
  expect(await host.clock({ clock: { time: "noon" } })).toEqual({ time: "after noon" });
  const replied = await host.replyPhase({ reply: "r", variables: { a: 2 }, clock: { time: "dusk" } });
  expect(replied.logs).toEqual(['1 {"a":2} dusk']);
});
