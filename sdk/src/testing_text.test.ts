// The test host's half of what the engine does before a command runs: reading its text forms
// (`host.text`, `host.forms`) and checking its arguments against `params` (`host.command`,
// `host.keeperCommand`).
import { expect, test } from "bun:test";

import { defineModule } from "./module.ts";
import { createTestHost, who } from "./testing.ts";

const ada = who("Ada", { character: { id: "ada", name: "Ada" } });
const mo = who("Mo", { role: "admin" });
const eve = who("Eve", { role: "observer" });

function skirmish() {
  return defineModule({
    id: "skirmish",
    commands: {
      attack: {
        title: "Attack",
        params: {
          type: "object",
          properties: { target: { type: "string" }, times: { type: "integer", minimum: 1 }, line: { type: "string" } },
          required: ["target"],
          additionalProperties: false,
        },
        // Three that read, and two the engine drops at load: an unknown name, double spacing.
        text: ["attack {target}", "attack {target} {times}", "attack at {target}", "strike {nobody}", "bad  spacing {target}"],
        run(args, speaker, fx) {
          fx.fact({ text: `${speaker.member?.name} attacks ${String(args.target)}` });
          return { text: JSON.stringify(args) };
        },
      },
      jab: {
        title: "Jab",
        params: { type: "object", properties: { target: { type: "string" } } },
        text: ["j {target}", "j 攻 {target}", "攻击 {target}"],
        run: (args) => ({ text: `jab ${String(args.target)}` }),
      },
      say: {
        title: "Say",
        params: { type: "object", properties: { line: { type: "string" } } },
        text: ["say {line...}"],
        run: (args) => ({ data: { line: args.line ?? null } }),
      },
      rest: {
        title: "Rest",
        text: ["rest", "rest well"],
        run: (_args, _who, _fx, _room, call) => ({ text: `form ${call.by}` }),
      },
      march: {
        title: "March",
        params: { type: "object", properties: { days: { type: "integer" } }, required: ["days"] },
        text: ["march {days}"],
        run(args, _who, fx, _room, call) {
          fx.fact({ text: `day ${call.step + 1}` });
          return call.step + 1 >= Number(args.days) ? { text: "arrived" } : { text: "on the road", more: true };
        },
      },
      rig: {
        title: "Rig",
        role: "admin",
        params: { type: "object", properties: { mode: { type: "string" } } },
        text: ["rig {mode}"],
        run: (args) => ({ text: `rigged ${String(args.mode)}` }),
      },
      advance: {
        title: "Advance the clock",
        role: "keeper",
        params: { type: "object", properties: { hours: { type: "integer" } }, additionalProperties: false },
        text: ["advance {hours}"],
        run: (args) => ({ text: `${String(args.hours ?? 1)} hours` }),
      },
      guard: {
        title: "Guard",
        params: { type: "object", properties: { who: { type: "string" } } },
        text: ["guard {who}"],
        available: (viewer) => (viewer.character ? true : "sit down first"),
        run: (args) => ({ text: `guarding ${String(args.who)}` }),
      },
      check: {
        title: "Check",
        params: { type: "object", properties: { target: { type: "string" } } },
        text: ["check {target}"],
        run: () => ({ text: "checked" }),
      },
    },
  });
}

test("the argument check: a refusal carries the engine's code and the argument's path, and the module is never called", async () => {
  const host = createTestHost(skirmish());
  const closed = await host.command("attack", { target: "Bo", extra: 1 }, ada);
  expect(closed.outcome).toEqual({ status: "refused", reason: "args", code: "unknown_arg", path: "extra" });
  expect(closed.effects).toEqual([]);
  expect(closed.steps).toBe(0);
  expect(closed.stopped).toBeNull();
  expect(closed.error).toBeNull();
  expect((await host.command("attack", {}, ada)).outcome).toEqual({ status: "refused", reason: "args", code: "missing_arg", path: "target" });
  expect((await host.command("attack", { target: "Bo", times: 0 }, ada)).outcome).toEqual({ status: "refused", reason: "args", code: "invalid_arg", path: "times" });
  expect((await host.command("attack", { target: 5 }, ada)).outcome).toEqual({ status: "refused", reason: "args", code: "invalid_arg", path: "target" });
  expect((await host.command("attack", { target: "Bo", times: 2 }, ada)).outcome).toEqual({ status: "ok", result: { text: '{"target":"Bo","times":2}' } });
});

test("the argument check comes after the unknown-command and role checks, and before `available`", async () => {
  const host = createTestHost(skirmish());
  expect((await host.command("nothing", { x: 1 }, ada)).outcome).toEqual({ status: "refused", reason: "unknown" });
  expect((await host.command("constructor", {}, ada)).outcome).toEqual({ status: "refused", reason: "unknown" });
  // A player who cannot run `advance` is refused for the role, whatever the arguments.
  expect((await host.command("advance", { hours: "many" }, ada)).outcome).toEqual({ status: "refused", reason: "role" });
  expect((await host.command("advance", { hours: "many" }, mo)).outcome).toEqual({ status: "refused", reason: "args", code: "invalid_arg", path: "hours" });
  // `guard` is unavailable to Mo (no character) and its arguments are bad: the arguments are refused first.
  expect((await host.command("guard", { who: 1 }, mo)).outcome).toEqual({ status: "refused", reason: "args", code: "invalid_arg", path: "who" });
  expect((await host.command("guard", { who: "Bo" }, mo)).outcome).toEqual({ status: "refused", reason: "unavailable", text: "sit down first" });
});

test("the Keeper's command is checked the same way", async () => {
  const host = createTestHost(skirmish(), { who: ada });
  const refused = await host.keeperCommand("advance", { hours: 6, extra: true });
  expect(refused.outcome).toEqual({ status: "refused", reason: "args", code: "unknown_arg", path: "extra" });
  expect(await host.keeperCommand("advance", { hours: "six" })).toMatchObject({ outcome: { status: "refused", reason: "args", code: "invalid_arg", path: "hours" }, effects: [] });
  expect((await host.keeperCommand("advance", { hours: 6 })).outcome).toEqual({ status: "ok", result: { text: "6 hours" } });
  // An admin command is the Keeper's to refuse for the role, before its arguments are read.
  expect((await host.keeperCommand("rig", { mode: 1 })).outcome).toEqual({ status: "refused", reason: "role" });
});

test("text: one word of the line fills `{name}`, and the answer is what command answers plus what matched", async () => {
  const host = createTestHost(skirmish());
  const typed = await host.text("attack Bo", ada);
  expect(typed.outcome).toEqual({ status: "ok", result: { text: '{"target":"Bo"}' } });
  expect(typed.matched).toEqual({ command: "attack", form: "attack {target}", args: { target: "Bo" } });
  expect(typed.facts.map((fact) => fact.text)).toEqual(["Ada attacks Bo"]);
  expect(typed.steps).toBe(1);
  // The same call, made as `command` makes it.
  const direct = await host.command("attack", { target: "Bo" }, ada);
  expect({ ...typed, matched: undefined }).toEqual({ ...direct, matched: undefined });
});

test("text: what follows the prefix is trimmed, the command word is case-folded, a typed number is coerced", async () => {
  const host = createTestHost(skirmish());
  const typed = await host.text("  ATTACK   Bo \t 3  ", ada);
  expect(typed.matched).toEqual({ command: "attack", form: "attack {target} {times}", args: { target: "Bo", times: 3 } });
  expect(typed.outcome).toEqual({ status: "ok", result: { text: '{"target":"Bo","times":3}' } });
  // A word that does not parse as its type stays text, and then fails the argument check.
  const many = await host.text("attack Bo many", ada);
  expect(many.matched?.args).toEqual({ target: "Bo", times: "many" });
  expect(many.outcome).toEqual({ status: "refused", reason: "args", code: "invalid_arg", path: "times" });
  expect(many.effects).toEqual([]);
  // A coerced number that breaks the schema is refused the same way.
  expect((await host.text("attack Bo 0", ada)).outcome).toEqual({ status: "refused", reason: "args", code: "invalid_arg", path: "times" });
});

test("text: the rest of the line is one argument, left out when empty", async () => {
  const host = createTestHost(skirmish());
  const said = await host.text("say Run,   now!  ", ada);
  expect(said.matched).toEqual({ command: "say", form: "say {line...}", args: { line: "Run,   now!" } });
  expect(said.outcome).toEqual({ status: "ok", result: { data: { line: "Run,   now!" } } });
  const silent = await host.text("say", ada);
  expect(silent.matched).toEqual({ command: "say", form: "say {line...}", args: {} });
  expect(silent.outcome).toEqual({ status: "ok", result: { data: { line: null } } });
});

test("text: of the forms that fit, the one with the most literal words wins, then the first declared", async () => {
  const host = createTestHost(skirmish());
  // `attack {target} {times}` and `attack at {target}` both fit: the one with a literal wins.
  const at = await host.text("ATTACK at Bo", ada);
  expect(at.matched).toEqual({ command: "attack", form: "attack at {target}", args: { target: "Bo" } });
  // `j {target}` is no match for two words, `j 攻 {target}` is; the lone word takes the first form.
  expect((await host.text("j 攻 刀客", ada)).matched).toEqual({ command: "jab", form: "j 攻 {target}", args: { target: "刀客" } });
  expect((await host.text("j 刀客", ada)).matched).toEqual({ command: "jab", form: "j {target}", args: { target: "刀客" } });
  expect((await host.text("攻击 刀客", ada)).outcome).toEqual({ status: "ok", result: { text: "jab 刀客" } });
  // Equal literals: declaration order. `rest well` has the literal, `rest` is the only fit for no words.
  expect((await host.text("rest well", ada)).matched?.form).toBe("rest well");
  expect((await host.text("rest", ada)).matched?.form).toBe("rest");
});

test("text: a first word the module owns, with a rest that fits none of its forms, is `usage`", async () => {
  const host = createTestHost(skirmish());
  const bare = await host.text("attack", ada);
  expect(bare.outcome).toEqual({ status: "refused", reason: "text", code: "usage", forms: ["attack {target}", "attack {target} {times}", "attack at {target}"] });
  expect(bare.matched).toBeNull();
  expect(bare.effects).toEqual([]);
  expect(bare.steps).toBe(0);
  expect((await host.text("attack Bo 3 now", ada)).outcome).toMatchObject({ status: "refused", code: "usage" });
  expect((await host.text("rest badly", ada)).outcome).toMatchObject({ status: "refused", code: "usage", forms: ["rest", "rest well"] });
  // The folded word: a CJK or full-width one is a word like any other.
  expect((await host.text("攻击", ada)).outcome).toMatchObject({ status: "refused", code: "usage", forms: ["攻击 {target}"] });
});

test("text: a first word that is none of the module's is `no_form`", async () => {
  const host = createTestHost(skirmish());
  for (const line of ["dance wildly", "", "   ", "duel/attack {\"target\":\"Bo\"}", ".attack Bo", "bad spacing Bo", "strike Bo"]) {
    const answer = await host.text(line, ada);
    expect(answer.outcome).toEqual({ status: "refused", reason: "text", code: "no_form" });
    expect(answer.matched).toBeNull();
    expect(answer.effects).toEqual([]);
  }
});

test("text: a form the engine drops at load is dropped by the host too, and listed", async () => {
  const host = createTestHost(skirmish());
  expect(host.forms.dropped).toEqual([
    { command: "attack", form: "strike {nobody}", problem: "unknown_param" },
    { command: "attack", form: "bad  spacing {target}", problem: "spacing" },
  ]);
  expect(host.forms.kept.filter((entry) => entry.command === "attack").map((entry) => entry.form)).toEqual(["attack {target}", "attack {target} {times}", "attack at {target}"]);
  expect(host.forms.kept.map((entry) => entry.command)).toEqual(["attack", "attack", "attack", "jab", "jab", "jab", "say", "rest", "rest", "march", "rig", "advance", "guard", "check"]);
  // The command itself stays, and runs by its name.
  expect((await host.command("attack", { target: "Bo" }, ada)).outcome).toMatchObject({ status: "ok" });
  expect((await host.text("strike Bo", ada)).outcome).toMatchObject({ code: "no_form" });
  await host.restart();
  expect(host.forms.dropped.map((entry) => entry.problem)).toEqual(["unknown_param", "spacing"]);
});

test("text: runs the command as `command` does: the role, `available`, and the steps", async () => {
  const host = createTestHost(skirmish());
  // Role: a form of an admin command is matched for anyone, and the role refuses it.
  const rigged = await host.text("rig loaded", ada);
  expect(rigged.matched).toEqual({ command: "rig", form: "rig {mode}", args: { mode: "loaded" } });
  expect(rigged.outcome).toEqual({ status: "refused", reason: "role" });
  expect((await host.text("rig loaded", mo)).outcome).toEqual({ status: "ok", result: { text: "rigged loaded" } });
  expect((await host.text("rig loaded", eve)).outcome).toEqual({ status: "refused", reason: "role" });
  // A `keeper` command is an admin's to type, never a player's.
  expect((await host.text("advance 2", ada)).outcome).toEqual({ status: "refused", reason: "role" });
  expect((await host.text("advance 2", mo)).outcome).toEqual({ status: "ok", result: { text: "2 hours" } });
  expect((await host.text("rest", ada)).outcome).toEqual({ status: "ok", result: { text: "form member" } });
  // `available` is asked, after the arguments.
  expect((await host.text("guard Bo", mo)).outcome).toEqual({ status: "refused", reason: "unavailable", text: "sit down first" });
  expect((await host.text("guard Bo", ada)).outcome).toEqual({ status: "ok", result: { text: "guarding Bo" } });
  // A command that asks for more runs its steps.
  const marched = await host.text("march 3", ada);
  expect(marched.steps).toBe(3);
  expect(marched.facts.map((fact) => fact.text)).toEqual(["day 1", "day 2", "day 3"]);
  expect(marched.outcome).toEqual({ status: "ok", result: { text: "arrived", data: { steps: 3, data: null } } });
  expect(marched.matched).toEqual({ command: "march", form: "march {days}", args: { days: 3 } });
});

test("text: the room and the caller are passed on, and the host's own `who` is the default", async () => {
  const host = createTestHost(skirmish(), { who: ada });
  const typed = await host.text("attack Bo");
  expect(typed.facts.map((fact) => fact.text)).toEqual(["Ada attacks Bo"]);
  expect((await host.text("guard Bo", undefined, { turn: 4 })).outcome).toEqual({ status: "ok", result: { text: "guarding Bo" } });
});

test("text: the host knows only this module, so a word the engine owns is still a form here", async () => {
  const host = createTestHost(skirmish());
  // The engine drops `check {target}` when a pack is enabled (`check` is its own command word);
  // the host cannot know that, and runs it.
  expect(host.forms.kept).toContainEqual({ command: "check", form: "check {target}" });
  expect((await host.text("check Bo", ada)).outcome).toEqual({ status: "ok", result: { text: "checked" } });
});
