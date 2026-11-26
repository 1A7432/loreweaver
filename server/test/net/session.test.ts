import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventFrame, ResultFrame, ServerFrame, WelcomeFrame } from "loreweaver-protocol/v3";

import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { bench, fixtureModule, isIdle, Wire, type Bench } from "../helpers.ts";

const benches: Bench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((b) => b.hub.close()));
});

function setup(options: Parameters<typeof bench>[0]): Bench {
  const b = bench(options);
  benches.push(b);
  return b;
}

function events(frames: ServerFrame[]): EventFrame[] {
  return frames.filter((frame): frame is EventFrame => frame.type === "event");
}

test("hello with a known key is welcomed; an unknown key is refused and the connection closed", () => {
  const b = setup({ llm: new ScriptedLLM([]) });
  const good = new Wire(b.deps);
  good.hello("player-key");
  expect(good.sent[0]).toMatchObject({ type: "welcome", protocol: "3.0", room: { id: "table", locale: "en" }, you: { name: "Ada", role: "player" }, epoch: 1, head: 0 });
  expect((good.sent[0] as WelcomeFrame).you.id).not.toContain("player-key");
  expect(good.closed).toBe(false);

  const bad = new Wire(b.deps);
  bad.hello("no-such-key", { locale: "zh" });
  expect(bad.sent).toEqual([{ type: "error", code: "bad_key", message: "钥匙无效。", fatal: true }]);
  expect(bad.closed).toBe(true);
});

test("another protocol major is refused by the server, naming both versions", () => {
  const b = setup({ llm: new ScriptedLLM([]) });
  const wire = new Wire(b.deps);
  wire.hello("player-key", { protocol: "2.6" });
  expect(wire.sent).toEqual([
    { type: "error", code: "protocol_mismatch", message: "Protocol mismatch: this server speaks 3.0, the client speaks 2.6.", fatal: true },
  ]);
  expect(wire.closed).toBe(true);
});

test("anything before hello ends the connection; ping is answered at any time", () => {
  const b = setup({ llm: new ScriptedLLM([]) });
  const wire = new Wire(b.deps);
  wire.receive({ type: "ping", t: 5 });
  expect(wire.sent).toEqual([{ type: "pong", t: 5 }]);
  wire.receive({ type: "input", rid: "1", text: "hi" });
  expect(wire.sent[1]).toMatchObject({ type: "error", code: "hello_first", fatal: true });
  expect(wire.closed).toBe(true);
});

test("a line of speech: answered to the speaker, logged for everyone, then the Keeper's reply streams and lands", async () => {
  const llm = new ScriptedLLM(["The door creaks open."]);
  const b = setup({ llm });
  const ada = new Wire(b.deps);
  const bao = new Wire(b.deps);
  ada.hello("player-key");
  bao.hello("second-key");
  ada.receive({ type: "input", rid: "r1", text: "I open the door." });
  await ada.until(isIdle);

  expect(ada.kinds()).toEqual(["welcome", "result", "event:narrative", "signal:turn", "signal:draft", "signal:draft", "event:narrative", "signal:turn"]);
  // The answer goes to the caller alone; the table sees the same events and signals.
  expect(bao.kinds()).toEqual(ada.kinds().filter((kind) => kind !== "result"));
  expect(ada.sent[1]).toEqual({ type: "result", rid: "r1", ok: true });

  const [said, reply] = events(ada.sent);
  expect(said).toMatchObject({ seq: 1, kind: "narrative", turn: 1, data: { speaker: "player", name: "Ada", text: "I open the door.", format: "plain" } });
  expect(reply).toMatchObject({ seq: 2, kind: "narrative", turn: 1, data: { speaker: "kp", text: "The door creaks open.", format: "markdown" } });
  // The draft bubble carries the reply's id, and its pieces add up to the final text.
  const drafts = ada.sent.flatMap((frame) => (frame.type === "signal" && frame.kind === "draft" && "text" in frame.data ? [frame.data] : []));
  expect(drafts.map((draft) => draft.id)).toEqual([reply?.id ?? "", reply?.id ?? ""]);
  expect(drafts.map((draft) => draft.text).join("")).toBe("The door creaks open.");

  expect(llm.calls[0]).toEqual([
    { role: "system", content: "You are the Keeper." },
    { role: "user", content: "[Ada]\nI open the door." },
  ]);
});

test("a module's injection reaches the prompt, and its state survives into the next turn", async () => {
  const llm = new ScriptedLLM(["one", "two"]);
  const b = setup({ llm, modules: [fixtureModule("counter")] });
  const wire = new Wire(b.deps);
  wire.hello("player-key");
  wire.receive({ type: "input", rid: "1", text: "first" });
  wire.receive({ type: "input", rid: "2", text: "second" });
  await wire.until((frame) => frame.type === "event" && frame.seq === 4);

  expect(llm.calls.map((call) => call[0]?.content)).toEqual([
    'You are the Keeper.\n\ncounter: turn 1, Ada said "first"',
    'You are the Keeper.\n\ncounter: turn 2, Ada said "second"',
  ]);
  expect(b.store.moduleStates("table")).toEqual(new Map([["counter", { turns: 2 }]]));
  expect(b.problems).toEqual([]);
});

test("a module that hangs costs its room one timeout, not the turn: the Keeper still answers", async () => {
  const llm = new ScriptedLLM(["still here"]);
  const b = setup({ llm, modules: [fixtureModule("moody")], workerTimeoutMs: 300 });
  const wire = new Wire(b.deps);
  wire.hello("player-key");
  wire.receive({ type: "input", rid: "1", text: "spin" });
  await wire.until(isIdle);
  expect(events(wire.sent).at(-1)?.data).toMatchObject({ speaker: "kp", text: "still here" });
  expect(llm.calls[0]?.[0]?.content).toBe("You are the Keeper.");
  expect(b.problems).toHaveLength(1);
  expect(b.problems[0]).toContain("terminated");
});

test("a model failure closes the draft and frees the room; nothing is logged for the dead turn", async () => {
  const llm = new ScriptedLLM(() => {
    throw new Error("provider down");
  });
  const b = setup({ llm });
  const wire = new Wire(b.deps);
  wire.hello("player-key");
  wire.receive({ type: "input", rid: "1", text: "hello?" });
  await wire.until(isIdle);
  expect(events(wire.sent).map((event) => event.seq)).toEqual([1]);
  expect(b.problems).toEqual(["provider down"]);
});

test("an observer cannot speak, and is told so in its own language", () => {
  const b = setup({ llm: new ScriptedLLM([]) });
  const wire = new Wire(b.deps);
  wire.hello("watch-key", { locale: "zh-CN" });
  wire.receive({ type: "input", rid: "9", text: "hi" });
  expect(wire.sent[1]).toEqual({ type: "result", rid: "9", ok: false, error: { code: "forbidden", message: "你没有这个权限。" } });
});

test("reconnecting with the last seen position gets exactly what was missed; history is paged", async () => {
  const b = setup({ llm: new ScriptedLLM(["a", "b"]) });
  const first = new Wire(b.deps);
  first.hello("player-key");
  first.receive({ type: "input", rid: "1", text: "one" });
  await first.until(isIdle);
  first.session.closed();

  const other = new Wire(b.deps);
  other.hello("second-key");
  other.receive({ type: "input", rid: "1", text: "two" });
  await other.until((frame) => frame.type === "event" && frame.seq === 4);

  const back = new Wire(b.deps);
  back.hello("player-key", { resume: { epoch: 1, after: 2 } });
  expect(back.sent[0]).toMatchObject({ type: "welcome", epoch: 1, head: 4 });
  expect(events(back.sent).map((event) => event.seq)).toEqual([3, 4]);

  // A client from another generation holds nothing valid: it is sent the log afresh.
  const stale = new Wire(b.deps);
  stale.hello("player-key", { resume: { epoch: 99, after: 3 } });
  expect(events(stale.sent).map((event) => event.seq)).toEqual([1, 2, 3, 4]);

  back.receive({ type: "call", rid: "p", method: "log.page", params: { before: 3, limit: 5 } });
  const page = back.sent.at(-1) as ResultFrame & { ok: true; data: { events: EventFrame[] } };
  expect(page.data.events.map((event) => event.seq)).toEqual([1, 2]);
  back.receive({ type: "call", rid: "q", method: "no.such" });
  expect(back.sent.at(-1)).toMatchObject({ type: "result", rid: "q", ok: false, error: { code: "unknown_method" } });
});

test("a restart loses nothing: the log, the turn count and a module's state come back from the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loreweaver-test-"));
  const dbPath = join(dir, "room.db");
  try {
    const before = bench({ llm: new ScriptedLLM(["first reply"]), modules: [fixtureModule("counter")], dbPath });
    const wire = new Wire(before.deps);
    wire.hello("player-key");
    wire.receive({ type: "input", rid: "1", text: "before the restart" });
    await wire.until(isIdle);
    await before.hub.close();
    before.store.close();

    const llm = new ScriptedLLM(["second reply"]);
    const after = setup({ llm, modules: [fixtureModule("counter")], dbPath });
    const back = new Wire(after.deps);
    back.hello("player-key", { resume: { epoch: 1, after: 2 } });
    expect(back.sent[0]).toMatchObject({ type: "welcome", epoch: 1, head: 2 });
    back.receive({ type: "input", rid: "2", text: "after the restart" });
    await back.until(isIdle);
    // The player's line and the reply that answers it carry the same turn.
    expect(events(back.sent).map((event) => [event.seq, event.turn])).toEqual([[3, 2], [4, 2]]);
    expect(llm.calls[0]?.[0]?.content).toBe('You are the Keeper.\n\ncounter: turn 2, Ada said "after the restart"');
    after.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lines accepted while a turn is running get their turn numbers at once, in order", async () => {
  const b = setup({ llm: new ScriptedLLM(["one", "two", "three"]) });
  const wire = new Wire(b.deps);
  wire.hello("player-key");
  for (const [rid, text] of [["1", "a"], ["2", "b"], ["3", "c"]] as const) wire.receive({ type: "input", rid, text });
  await wire.until((frame) => frame.type === "event" && frame.seq === 6);
  const log = events(wire.sent).map((event) => [event.seq, event.turn, event.kind === "narrative" ? event.data.speaker : ""]);
  // All three lines are logged before any reply; each reply lands under its line's turn.
  expect(log).toEqual([[1, 1, "player"], [2, 2, "player"], [3, 3, "player"], [4, 1, "kp"], [5, 2, "kp"], [6, 3, "kp"]]);
});
