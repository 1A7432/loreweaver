// The room: speech and commands through one lock, lifecycle commands that do not wait for
// it, and what follows a turn.
import { afterEach, describe, expect, test } from "bun:test";

import { markNarrateNow, NARRATE_NOW, NARRATE_NOW_SETTING } from "../../src/agent/effects.ts";
import { CHRONICLE_RECORD_TYPE } from "../../src/core/chronicle/index.ts";
import { StaleGeneration } from "../../src/infra/lifecycle/errors.ts";
import { events, gate, KEYS, LANES_ON, reply, result, resultFor, RoomBench, ROOM, scribeReply, signals, testKit, views, type BenchOptions } from "./room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

function setup(options: BenchOptions = {}): RoomBench {
  const bench = new RoomBench(options);
  benches.push(bench);
  return bench;
}

function narrativeTexts(frames: Parameters<typeof events>[0]): string[] {
  return events(frames).flatMap((event) => (event.kind === "narrative" ? [event.data.text] : []));
}

describe("speech", () => {
  test("the line is published under its turn before the turn's events; busy, reply, idle; the answer is the speaker's", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const bao = b.join(KEYS.bao);
    ada.receive({ type: "input", rid: "r1", text: "I open the door." });
    await b.settled();
    expect(ada.kinds()).toEqual(["welcome", "event:narrative", "result", "signal:turn", "event:narrative", "signal:turn"]);
    expect(bao.kinds()).toEqual(ada.kinds().filter((kind) => kind !== "result"));
    expect(resultFor(ada.sent, "r1")).toEqual({ type: "result", rid: "r1", ok: true });
    const [line, answer] = events(ada.sent);
    expect(line).toMatchObject({ seq: 1, turn: 1, kind: "narrative", data: { speaker: "player", name: "Ada", text: "I open the door.", format: "plain" } });
    expect(answer).toMatchObject({ seq: 2, turn: 1, data: { speaker: "kp", text: "Reply 1" } });
    expect(signals(ada.sent, "turn").map((frame) => frame.data)).toEqual([{ status: "busy", actor: "Ada" }, { status: "idle" }]);
    // The turn was told which line it answers.
    expect(b.keeper.calls[0]?.input).toMatchObject({ work: "action", action: line?.id, text: "I open the door.", speaker: "Ada" });
  });

  test("inline rolls are dice events of the same turn, right after the line", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    ada.receive({ type: "input", rid: "r1", text: "I swing [[1d6]] and [[2d4]]" });
    await b.settled();
    const logged = events(ada.sent);
    expect(logged.map((event) => [event.kind, event.turn])).toEqual([
      ["narrative", 1],
      ["dice", 1],
      ["dice", 1],
      ["narrative", 1],
    ]);
  });

  test("two lines from two members queue in arrival order, each accepted at once", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const bao = b.join(KEYS.bao);
    const hold = gate();
    b.keeper.next(async (call) => {
      await hold.promise;
      return reply(call, "first");
    });
    ada.receive({ type: "input", rid: "a", text: "one" });
    bao.receive({ type: "input", rid: "b", text: "two" });
    await Bun.sleep(5);
    // Both lines are in the log and answered; only the first turn has started.
    expect(narrativeTexts(ada.sent)).toEqual(["one", "two"]);
    expect(resultFor(bao.sent, "b")?.ok).toBe(true);
    expect(b.keeper.calls.length).toBe(1);
    hold.open();
    await b.settled();
    expect(b.keeper.calls.map((call) => [call.input.text, call.context.turn])).toEqual([
      ["one", 1],
      ["two", 2],
    ]);
    expect(narrativeTexts(ada.sent)).toEqual(["one", "two", "first", "Reply 2"]);
  });

  test("an observer may not speak: a coded refusal in its own language, nothing logged", async () => {
    const b = setup();
    const eve = b.join(KEYS.eve, { locale: "zh" });
    eve.receive({ type: "input", rid: "9", text: "hello" });
    await b.settled();
    expect(resultFor(eve.sent, "9")).toEqual({ type: "result", rid: "9", ok: false, error: { code: "observer_speech", message: "旁观者只能看，不能在桌上发言。" } });
    expect(b.store.room(ROOM).head).toBe(0);
    expect(b.keeper.calls).toEqual([]);
  });

  test("a muted Keeper: the line is logged, no turn runs", async () => {
    const b = setup();
    const root = b.join(KEYS.root);
    const ada = b.join(KEYS.ada);
    root.receive({ type: "input", rid: "m", text: ".bot off" });
    ada.receive({ type: "input", rid: "r", text: "anyone there?" });
    await b.settled();
    expect(resultFor(root.sent, "m")?.ok).toBe(true);
    // The line was accepted before the command ran, so it precedes the command's event; its
    // turn queued behind the command and found the Keeper muted.
    expect(narrativeTexts(ada.sent)).toEqual(["anyone there?", "The Keeper is muted; the table plays on."]);
    expect(b.keeper.calls).toEqual([]);
    expect(signals(ada.sent, "turn")).toEqual([]);
  });
});

describe("commands", () => {
  test("a command waits for the running turn, then runs: its events to all, its answer to the caller alone, no new turn", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const bao = b.join(KEYS.bao);
    const hold = gate();
    b.keeper.next(async (call) => {
      await hold.promise;
      return reply(call, "done");
    });
    ada.receive({ type: "input", rid: "line", text: "I wait." });
    bao.receive({ type: "input", rid: "roll", text: ".r 1d6" });
    await Bun.sleep(5);
    expect(resultFor(bao.sent, "roll")).toBeUndefined();
    hold.open();
    await b.settled();
    const logged = events(bao.sent);
    expect(logged.map((event) => event.kind)).toEqual(["narrative", "narrative", "dice"]);
    // The roll came after the turn's reply, and carries no turn of its own.
    expect(logged[2]?.turn).toBeUndefined();
    expect(b.store.room(ROOM).turn).toBe(1);
    expect(resultFor(bao.sent, "roll")?.ok).toBe(true);
    expect(resultFor(ada.sent, "roll")).toBeUndefined();
    // The table saw it, so the Keeper is told.
    expect(b.actions).toEqual([{ actor: "Bao", action: "roll", text: expect.stringContaining("1d6") }]);
  });

  test("a refused command leaves no event and is answered with its code", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    ada.receive({ type: "input", rid: "u", text: ".undo" });
    ada.receive({ type: "call", rid: "c", method: "command.run", params: { id: "roll", args: { expr: "1d6", sides: 6 } } });
    await b.settled();
    expect(resultFor(ada.sent, "u")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(resultFor(ada.sent, "c")).toMatchObject({ ok: false, error: { code: "unknown_arg" } });
    expect(events(ada.sent)).toEqual([]);
    expect(b.actions).toEqual([]);
  });

  test("the text form and command.run reach the same handler", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    ada.receive({ type: "input", rid: "t", text: ".rule" });
    ada.receive({ type: "call", rid: "s", method: "command.run", params: { id: "rule", args: {} } });
    await b.settled();
    const text = resultFor(ada.sent, "t");
    const structured = resultFor(ada.sent, "s");
    expect(text?.ok).toBe(true);
    expect(text?.ok === true && structured?.ok === true ? [text.text, text.data] : null).toEqual(structured?.ok === true ? [structured.text, structured.data] : []);
  });

  test("the room's rule system comes from its setting, else the hub's default", async () => {
    const b = setup({ system: null });
    const root = b.join(KEYS.root);
    root.receive({ type: "input", rid: "1", text: ".ra 侦查50" });
    root.receive({ type: "input", rid: "2", text: ".rule system coc7" });
    await b.settled();
    expect(resultFor(root.sent, "1")).toMatchObject({ ok: false, error: { code: "no_rule_system" } });
    expect(b.hub.room(ROOM).pack?.id).toBe("coc7");
    expect(narrativeTexts(root.sent)).toEqual(["Rule system set to coc7."]);
  });
});

describe("lifecycle", () => {
  test("undo while a turn is suspended: the turn's later publish is refused, the rewind goes out under the new generation, views refresh", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const root = b.join(KEYS.root);
    ada.receive({ type: "input", rid: "1", text: "first" });
    await b.settled();
    ada.receive({ type: "call", rid: "sub", method: "view.subscribe", params: { names: ["usage"] } });
    await b.settled();
    const before = views(ada.sent, "usage").length;
    const hold = gate();
    let refused: unknown = null;
    b.keeper.next(async (call) => {
      await hold.promise;
      try {
        call.ports.publish("narrative", "late", { speaker: "kp", text: "too late", format: "markdown" });
      } catch (error) {
        refused = error;
      }
      return result("stale");
    });
    ada.receive({ type: "input", rid: "2", text: "second" });
    await Bun.sleep(5);
    expect(b.keeper.calls.length).toBe(2);
    // The admin's undo does not wait behind the suspended turn.
    root.receive({ type: "input", rid: "undo", text: ".undo 2" });
    await Bun.sleep(5);
    expect(resultFor(root.sent, "undo")?.ok).toBe(true);
    const rewind = events(ada.sent).find((event) => event.kind === "rewind");
    expect(rewind).toMatchObject({ kind: "rewind", data: { to: 0, epoch: 2 } });
    hold.open();
    await b.settled();
    expect(refused).toBeInstanceOf(StaleGeneration);
    expect(narrativeTexts(ada.sent)).not.toContain("too late");
    expect(b.store.room(ROOM)).toMatchObject({ epoch: 2, turn: 0 });
    // The undone turn's usage is gone from the view.
    expect(views(ada.sent, "usage").length).toBeGreaterThan(before);
  });

  test("a line queued behind a turn that an undo removes never runs", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const root = b.join(KEYS.root);
    const hold = gate();
    b.keeper.next(async (call) => {
      await hold.promise;
      return reply(call, "x");
    });
    ada.receive({ type: "input", rid: "1", text: "first" });
    ada.receive({ type: "input", rid: "2", text: "second" });
    await Bun.sleep(5);
    root.receive({ type: "input", rid: "u", text: ".undo" });
    hold.open();
    await b.settled();
    expect(b.keeper.calls.map((call) => call.input.text)).toEqual(["first"]);
  });

  test("a Scribe pass scheduled before a reset does not commit after it", async () => {
    const held = gate();
    const b = setup({
      lanes: LANES_ON,
      scribe: async () => {
        await held.promise;
        return scribeReply({ chronicle: "Ada opened the door." });
      },
    });
    const ada = b.join(KEYS.ada);
    const root = b.join(KEYS.root);
    ada.receive({ type: "input", rid: "1", text: "I open the door." });
    await b.hub.room(ROOM).settled();
    expect(b.scribe.calls.length).toBe(1);
    root.receive({ type: "input", rid: "arm", text: ".reset story" });
    root.receive({ type: "input", rid: "go", text: ".reset story confirm" });
    await Bun.sleep(5);
    expect(resultFor(root.sent, "go")?.ok).toBe(true);
    expect(events(ada.sent).at(-1)).toMatchObject({ kind: "reset", data: { scope: "story", epoch: 2 } });
    held.open();
    await b.settled();
    expect(b.store.docList(ROOM, CHRONICLE_RECORD_TYPE)).toEqual([]);
  });
});

describe("after a turn", () => {
  test("the Scribe chain keeps order across turns, and a slow pass never delays the next turn", async () => {
    const first = gate();
    let calls = 0;
    const b = setup({
      lanes: LANES_ON,
      scribe: async (messages) => {
        calls += 1;
        if (calls === 1) await first.promise;
        const prompt = messages[0]?.content ?? "";
        return scribeReply({ chronicle: prompt.includes("alpha-line") ? "The first thing." : "The second thing." });
      },
    });
    const ada = b.join(KEYS.ada);
    ada.receive({ type: "input", rid: "1", text: "alpha-line" });
    ada.receive({ type: "input", rid: "2", text: "beta-line" });
    await b.hub.room(ROOM).settled();
    // Both turns finished while the first pass is still waiting on its model.
    expect(b.keeper.calls.length).toBe(2);
    expect(signals(ada.sent, "turn").filter((frame) => "status" in frame.data && frame.data.status === "idle").length).toBe(2);
    expect(calls).toBe(1);
    first.open();
    await b.settled();
    const records = b.store.docList(ROOM, CHRONICLE_RECORD_TYPE).map((row) => JSON.parse(row.data) as { turn: number; text: string });
    expect(records.map((record) => [record.turn, record.text])).toEqual([
      [1, "The first thing."],
      [2, "The second thing."],
    ]);
  });

  test("the Director stages a beat when the room has a kit, and only then", async () => {
    const staged = JSON.stringify({ blocks: [{ kind: "letter", body: "Come to the quay." }] });
    const withKit = setup({ lanes: LANES_ON, kit: testKit(), scribe: () => scribeReply({ beat: "scene_change" }), director: () => staged });
    const ada = withKit.join(KEYS.ada);
    ada.receive({ type: "input", rid: "1", text: "We go to the quay." });
    await withKit.settled();
    const blocks = events(ada.sent).find((event) => event.kind === "blocks");
    expect(blocks).toMatchObject({ turn: 1, data: { blocks: [{ kind: "letter", body: "Come to the quay." }] } });
    expect(withKit.director.calls.length).toBe(1);

    const noBeat = setup({ lanes: LANES_ON, kit: testKit(), scribe: () => scribeReply({}), director: () => staged });
    noBeat.join(KEYS.ada).receive({ type: "input", rid: "1", text: "We wait." });
    await noBeat.settled();
    expect(noBeat.director.calls.length).toBe(0);

    const noKit = setup({ lanes: LANES_ON, kit: null, scribe: () => scribeReply({ beat: "scene_change" }), director: () => staged });
    noKit.join(KEYS.ada).receive({ type: "input", rid: "1", text: "We go." });
    await noKit.settled();
    expect(noKit.director.calls.length).toBe(0);
  });

  test("usage is recorded under the turn", async () => {
    const b = setup();
    b.join(KEYS.ada).receive({ type: "input", rid: "1", text: "hi" });
    await b.settled();
    expect(b.store.stateList(ROOM).get("views.last_turn_usage")).toContain('"turn":1');
  });
});

describe("narrate now", () => {
  function marking(call: Parameters<Parameters<RoomBench["keeper"]["next"]>[0]>[0]) {
    const store = call.context.services.store;
    const marked = markNarrateNow(store.stateGet(ROOM, NARRATE_NOW), call.input.action, call.input.work);
    if (marked.raised && marked.state !== null) call.context.writer.statePut(NARRATE_NOW, marked.state);
    // Inside the facts turn a mark is not raised; force one to prove the room does not open another.
    if (call.input.work === "facts_turn") call.context.writer.statePut(NARRATE_NOW, { action: call.input.action, requested: true, opened: false });
    return reply(call, `${call.input.work} ${call.context.turn}`);
  }

  test("one facts turn per player action, never one from inside it", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    b.keeper.next(marking, marking, marking);
    ada.receive({ type: "input", rid: "1", text: "pull the lever" });
    await b.settled();
    expect(b.keeper.calls.map((call) => [call.input.work, call.input.text, call.context.turn])).toEqual([
      ["action", "pull the lever", 1],
      ["facts_turn", "", 2],
    ]);
    expect(b.keeper.calls[1]?.input.action).toBe(b.keeper.calls[0]?.input.action);
  });

  test("no facts turn when a line is already waiting: that line's turn is next and carries the facts", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const gate = Promise.withResolvers<void>();
    b.keeper.next(
      async (call) => {
        await gate.promise;
        return marking(call);
      },
      marking,
      marking,
    );
    ada.receive({ type: "input", rid: "1", text: "pull the lever" });
    await Promise.resolve();
    // Accepted, and numbered, while the first turn is still running.
    ada.receive({ type: "input", rid: "2", text: "and then run" });
    gate.resolve();
    await b.settled();
    expect(b.keeper.calls.map((call) => [call.input.work, call.input.text, call.context.turn])).toEqual([
      ["action", "pull the lever", 1],
      ["action", "and then run", 2],
      // The second line asked too, and nothing waits behind it.
      ["facts_turn", "", 3],
    ]);
  });

  test("off when the room switched it off", async () => {
    const b = setup();
    b.store.writer(ROOM).statePut(NARRATE_NOW_SETTING, false);
    b.keeper.next(marking);
    b.join(KEYS.ada).receive({ type: "input", rid: "1", text: "pull the lever" });
    await b.settled();
    expect(b.keeper.calls.map((call) => call.input.work)).toEqual(["action"]);
  });
});
