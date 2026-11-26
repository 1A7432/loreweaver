// One connection: hello and welcome, resuming the log, one result per input and call matched
// by `rid`, connection-level errors, the rate limit.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventFrame, ResultFrame, WelcomeFrame } from "loreweaver-protocol/v3";

import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { events, KEYS, results, resultFor, RoomBench, type BenchOptions } from "../gateway/room_bench.ts";
import { bench, fixtureModule, isIdle, Wire } from "../helpers.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((b) => b.close()));
});

function setup(options: BenchOptions = {}): RoomBench {
  const b = new RoomBench(options);
  benches.push(b);
  return b;
}

test("hello with a known key is welcomed with the room's language; an unknown key is refused and the connection closed", async () => {
  const b = setup();
  const good = b.join(KEYS.ada);
  expect(good.sent[0]).toMatchObject({ type: "welcome", protocol: "3.0", room: { id: "table", locale: "en" }, you: { name: "Ada", role: "player" }, epoch: 1, head: 0 });
  expect((good.sent[0] as WelcomeFrame).you.id).not.toContain(KEYS.ada);
  expect(good.closed).toBe(false);

  const bad = b.join("no-such-key", { locale: "zh" });
  expect(bad.sent).toEqual([{ type: "error", code: "bad_key", message: "钥匙无效。", fatal: true }]);
  expect(bad.closed).toBe(true);

  // The room's language, not the client's: the room speaks Chinese now.
  const root = b.join(KEYS.root);
  root.receive({ type: "input", rid: "l", text: ".language zh" });
  await b.settled();
  const later = b.join(KEYS.bao, { locale: "en" });
  expect(later.sent[0]).toMatchObject({ type: "welcome", room: { locale: "zh" } });
});

test("another protocol major is refused by the server, naming both versions", () => {
  const b = setup();
  const wire = b.join(KEYS.ada, { protocol: "2.6" });
  expect(wire.sent).toEqual([{ type: "error", code: "protocol_mismatch", message: "Protocol mismatch: this server speaks 3.0, the client speaks 2.6.", fatal: true }]);
  expect(wire.closed).toBe(true);
});

test("a name over the cap is refused, not cut", () => {
  const b = setup();
  const wire = b.join(KEYS.ada, { name: "x".repeat(65) });
  expect(wire.sent).toEqual([{ type: "error", code: "bad_name", message: "That name is too long (limit 64).", fatal: true }]);
  const named = b.join(KEYS.ada, { name: "  Ada Lovelace " });
  expect(named.sent[0]).toMatchObject({ you: { name: "Ada Lovelace" } });
});

test("frames that cannot be read: before hello the connection ends; after it, a frame with a rid is answered and one without is an error", () => {
  const b = setup();
  const early = new Wire({ keystore: b.keystore, room: (id) => b.hub.room(id) });
  early.receive({ type: "ping", t: 5 });
  expect(early.sent).toEqual([{ type: "pong", t: 5 }]);
  early.receive({ type: "input", rid: "1", text: "hi" });
  expect(early.sent[1]).toMatchObject({ type: "error", code: "hello_first", fatal: true });
  expect(early.closed).toBe(true);

  const wire = b.join(KEYS.ada);
  wire.receive({ type: "nonsense" });
  wire.session.receive(42);
  wire.receive({ type: "hello", protocol: "3.0", key: KEYS.ada, locale: "en", client: { name: "x", version: "0" }, caps: [] });
  wire.receive({ type: "input", rid: "long", text: "x".repeat(8001) });
  wire.receive({ type: "call", rid: "p", method: "view.get", params: [] });
  wire.receive({ type: "call", rid: "id", method: "command.run", params: { id: 7 } });
  expect(wire.sent.slice(1)).toEqual([
    { type: "error", code: "bad_frame", message: "That frame could not be read.", fatal: false },
    { type: "error", code: "bad_frame", message: "That frame could not be read.", fatal: false },
    { type: "error", code: "bad_frame", message: "That frame could not be read.", fatal: false },
    { type: "result", rid: "long", ok: false, error: { code: "input_too_long", message: "That message is too long." } },
    { type: "result", rid: "p", ok: false, error: { code: "invalid_params", message: "Those parameters are not valid." } },
    { type: "result", rid: "id", ok: false, error: { code: "invalid_params", message: "Those parameters are not valid." } },
  ]);
  expect(wire.closed).toBe(false);
});

test("every input and call gets exactly one result, matched by its rid", async () => {
  const b = setup();
  const wire = b.join(KEYS.ada, { locale: "zh" });
  wire.receive({ type: "input", rid: "say", text: "hello" });
  wire.receive({ type: "input", rid: "roll", text: ".r 1d6" });
  wire.receive({ type: "call", rid: "run", method: "command.run", params: { id: "roll", args: { expr: "2d6" } } });
  wire.receive({ type: "call", rid: "list", method: "view.list", params: {} });
  wire.receive({ type: "call", rid: "media", method: "media.offer", params: { name: "a.png", mime: "image/png", size: 1, sha256: "x" } });
  wire.receive({ type: "call", rid: "what", method: "no.such" });
  await b.settled();
  expect(results(wire.sent).map((frame) => frame.rid).sort()).toEqual(["list", "media", "roll", "run", "say", "what"]);
  expect(resultFor(wire.sent, "media")).toEqual({ type: "result", rid: "media", ok: false, error: { code: "media_unavailable", message: "本服务器不保存文件：无法上传。" } });
  expect(resultFor(wire.sent, "what")).toMatchObject({ ok: false, error: { code: "unknown_method", message: "没有这个方法。" } });
  expect(resultFor(wire.sent, "say")?.ok).toBe(true);
});

test("the rate limit refuses with a stable code once a member's burst is spent", async () => {
  const b = setup({ rateLimit: { capacity: 2, refillPerSecond: 0 } });
  const wire = b.join(KEYS.ada);
  wire.receive({ type: "input", rid: "1", text: ".r 1d6" });
  wire.receive({ type: "call", rid: "2", method: "command.run", params: { id: "roll", args: {} } });
  wire.receive({ type: "input", rid: "3", text: "one more" });
  await b.settled();
  expect(resultFor(wire.sent, "3")).toEqual({ type: "result", rid: "3", ok: false, error: { code: "rate_limited", message: "Slow down: too many messages at once." } });
  expect(events(wire.sent).map((event) => event.kind)).toEqual(["dice", "dice"]);
  // Views are not rate-limited.
  wire.receive({ type: "call", rid: "4", method: "view.list", params: {} });
  await b.settled();
  expect(resultFor(wire.sent, "4")?.ok).toBe(true);
});

test("resume: the same generation gets exactly what was missed; another generation gets the log afresh; history is paged", async () => {
  const b = setup();
  const first = b.join(KEYS.ada);
  first.receive({ type: "input", rid: "1", text: "one" });
  await b.settled();
  first.session.closed();
  b.join(KEYS.bao).receive({ type: "input", rid: "1", text: "two" });
  await b.settled();

  const back = b.join(KEYS.ada, { resume: { epoch: 1, after: 2 } });
  expect(back.sent[0]).toMatchObject({ type: "welcome", epoch: 1, head: 4 });
  expect(events(back.sent).map((event) => event.seq)).toEqual([3, 4]);

  const stale = b.join(KEYS.ada, { resume: { epoch: 99, after: 3 } });
  expect(events(stale.sent).map((event) => event.seq)).toEqual([1, 2, 3, 4]);

  back.receive({ type: "call", rid: "p", method: "log.page", params: { before: 3, limit: 5 } });
  const page = back.sent.at(-1) as ResultFrame & { ok: true; data: { events: EventFrame[] } };
  expect(page.data.events.map((event) => event.seq)).toEqual([1, 2]);

  // After an undo the generation moves: a client resuming with the old one reloads.
  const root = b.join(KEYS.root);
  root.receive({ type: "input", rid: "u", text: ".undo" });
  await b.settled();
  const after = b.join(KEYS.ada, { resume: { epoch: 1, after: 4 } });
  expect(after.sent[0]).toMatchObject({ type: "welcome", epoch: 2 });
  expect(events(after.sent).map((event) => event.kind)).toEqual(["narrative", "narrative", "rewind"]);
});

test("lines accepted while a turn is running get their turn numbers at once, in order", async () => {
  const b = setup();
  const wire = b.join(KEYS.ada);
  for (const [rid, text] of [["1", "a"], ["2", "b"], ["3", "c"]] as const) wire.receive({ type: "input", rid, text });
  await b.settled();
  const log = events(wire.sent).map((event) => [event.seq, event.turn, event.kind === "narrative" ? event.data.speaker : ""]);
  expect(log).toEqual([
    [1, 1, "player"],
    [2, 2, "player"],
    [3, 3, "player"],
    [4, 1, "kp"],
    [5, 2, "kp"],
    [6, 3, "kp"],
  ]);
});

test("a restart loses nothing: the log, the turn count and a module's state come back from the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loreweaver-test-"));
  const dbPath = join(dir, "room.db");
  try {
    const before = bench({ llm: new ScriptedLLM([]), modules: [fixtureModule("counter")], dbPath });
    const wire = new Wire(before.deps);
    wire.hello("player-key");
    wire.receive({ type: "input", rid: "1", text: "before the restart" });
    await wire.until(isIdle);
    await before.hub.close();
    before.store.close();

    const after = bench({ llm: new ScriptedLLM([]), modules: [fixtureModule("counter")], dbPath });
    const back = new Wire(after.deps);
    back.hello("player-key", { resume: { epoch: 1, after: 2 } });
    expect(back.sent[0]).toMatchObject({ type: "welcome", epoch: 1, head: 2 });
    back.receive({ type: "input", rid: "2", text: "after the restart" });
    await back.until(isIdle);
    // The player's line and the reply that answers it carry the same turn; the module counted on.
    expect(events(back.sent).map((event) => [event.seq, event.turn])).toEqual([
      [3, 2],
      [4, 2],
    ]);
    expect(events(back.sent).at(-1)?.data).toMatchObject({ text: 'counter: turn 2, Ada said "after the restart"' });
    expect(after.store.moduleStates("table")).toEqual(new Map([["counter", { turns: 2 }]]));
    await after.hub.close();
    after.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
