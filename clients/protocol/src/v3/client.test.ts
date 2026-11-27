import { expect, test } from "bun:test";

import { builtInView, Session, SessionError, type Link, type SessionOptions, type Timers } from "./client";
import type { ClientFrame, EventFrame } from "./frames";
import { stripControlChars } from "./index";

/** A link that records what the session sent. */
class FakeLink implements Link {
  readonly sent: ClientFrame[] = [];
  send(frame: ClientFrame): void {
    this.sent.push(frame);
  }
  last<T extends ClientFrame["type"]>(type: T): Extract<ClientFrame, { type: T }> {
    const found = this.sent.filter((frame) => frame.type === type).at(-1);
    if (found === undefined) throw new Error(`nothing of type ${type} sent`);
    return found as Extract<ClientFrame, { type: T }>;
  }
  calls(method?: string): Extract<ClientFrame, { type: "call" }>[] {
    return this.sent.filter((frame): frame is Extract<ClientFrame, { type: "call" }> => frame.type === "call" && (method === undefined || frame.method === method));
  }
}

/** Timers and a clock the test moves by hand. */
class ManualClock implements Timers {
  now = 1000;
  #timers = new Map<number, { at: number; callback: () => void }>();
  #next = 0;
  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.now + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.now) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
  get pending(): number {
    return this.#timers.size;
  }
}

function make(extra: Partial<SessionOptions> = {}): { session: Session; clock: ManualClock } {
  const clock = new ManualClock();
  const session = new Session({ key: "k", locale: "en", client: { name: "test", version: "1" }, caps: ["text-only"], timers: clock, now: () => clock.now, ...extra });
  return { session, clock };
}

/** A welcome of a room whose log, when it has one, starts at 1 (`first`): nothing was ever reset away. */
function welcome(epoch = 1, head = 0, role = "player", first = head === 0 ? 0 : 1): Record<string, unknown> {
  return { type: "welcome", protocol: "3.0", server: { name: "lw", version: "3" }, room: { id: "table", locale: "en" }, you: { id: "m1", name: "Ada", role }, features: [], epoch, head, first };
}

function narrative(seq: number, id = `e${seq}`, text = `line ${seq}`): EventFrame {
  return { type: "event", seq, id, ts: seq, kind: "narrative", data: { speaker: "kp", text, format: "markdown" } };
}

function online(extra: Partial<SessionOptions> = {}, epoch = 1, head = 0): { session: Session; clock: ManualClock; link: FakeLink } {
  const { session, clock } = make(extra);
  const link = new FakeLink();
  session.attach(link);
  session.receive(welcome(epoch, head));
  return { session, clock, link };
}

function seqs(session: Session): number[] {
  return session.getSnapshot().events.map((event) => event.seq);
}

// --- hello / welcome ----------------------------------------------------------------

test("attach says hello with the protocol, key, name, locale, client and caps; no resume before a log exists", () => {
  const { session } = make({ name: "Ada" });
  expect(session.status).toBe("idle");
  const link = new FakeLink();
  session.attach(link);
  expect(link.sent).toEqual([{ type: "hello", protocol: "3.0", key: "k", name: "Ada", locale: "en", client: { name: "test", version: "1" }, caps: ["text-only"] }]);
  expect(session.status).toBe("connecting");
  session.receive(welcome(4, 0));
  expect(session.status).toBe("online");
  expect(session.getSnapshot()).toMatchObject({ status: "online", epoch: 4, head: 0, welcome: { you: { name: "Ada" } }, complete: true });
});

test("a welcome naming another protocol major ends the session", () => {
  const { session } = make();
  session.attach(new FakeLink());
  session.receive({ ...welcome(), protocol: "4.0" });
  expect(session.status).toBe("ended");
  expect(session.getSnapshot().lastError).toMatchObject({ code: "protocol_mismatch", fatal: true });
});

// --- fatal versus non-fatal ---------------------------------------------------------

test("a fatal error ends the session for good: pending requests are rejected with its code, and attach refuses", async () => {
  const { session } = make();
  session.attach(new FakeLink());
  const pending = session.input("hi");
  session.receive({ type: "error", code: "bad_key", message: "Bad key.", fatal: true });
  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SessionError);
  expect(error).toMatchObject({ code: "bad_key", fatal: true });
  expect(session.status).toBe("ended");
  expect(session.canRedial).toBe(false);
  expect(session.getSnapshot().lastError).toEqual({ code: "bad_key", message: "Bad key.", fatal: true });
  // The transport reports the close that follows: still ended.
  session.closed("server closed");
  expect(session.status).toBe("ended");
  expect(() => session.attach(new FakeLink())).toThrow(SessionError);
  await expect(session.input("x")).rejects.toMatchObject({ code: "session_ended" });
});

test("a non-fatal error is recorded and nothing else changes; a dropped link may be redialled", async () => {
  const { session } = online();
  const pending = session.call("view.list");
  session.receive({ type: "error", code: "bad_frame", message: "Unreadable.", fatal: false });
  expect(session.status).toBe("online");
  expect(session.getSnapshot().lastError).toEqual({ code: "bad_frame", message: "Unreadable.", fatal: false });
  session.closed("network");
  await expect(pending).rejects.toMatchObject({ code: "link_closed", fatal: false });
  expect(session.status).toBe("offline");
  expect(session.canRedial).toBe(true);
  expect(session.getSnapshot().lastError).toMatchObject({ code: "link_closed", message: "network" });
});

test("end() is the caller giving up: ended, not redialled", () => {
  const { session } = online();
  session.end();
  expect(session.status).toBe("ended");
  expect(session.canRedial).toBe(false);
});

// --- requests -------------------------------------------------------------------------

test("each request gets the one result with its rid; a result for an unknown rid is ignored; a refusal is an answer", async () => {
  const { session, link } = online();
  const say = session.input("hello");
  const run = session.runCommand("roll", { expr: "2d6" });
  const sayRid = link.last("input").rid;
  const runCall = link.last("call");
  expect(runCall).toMatchObject({ method: "command.run", params: { id: "roll", args: { expr: "2d6" } } });
  expect(sayRid).not.toBe(runCall.rid);
  session.receive({ type: "result", rid: "nobody", ok: true, data: 1 });
  session.receive({ type: "result", rid: runCall.rid, ok: false, error: { code: "usage", message: "Usage." } });
  session.receive({ type: "result", rid: sayRid, ok: true, text: "fine" });
  expect(await say).toEqual({ ok: true, data: undefined, text: "fine" });
  expect(await run).toEqual({ ok: false, error: { code: "usage", message: "Usage." } });
  // A second result for the same rid changes nothing.
  session.receive({ type: "result", rid: sayRid, ok: false, error: { code: "x", message: "x" } });
});

test("a request times out when asked to, and a late result is then ignored; a default timeout applies to all", async () => {
  const { session, clock, link } = online({ requestTimeoutMs: 5000 });
  const slow = session.call("view.list", {}, { timeoutMs: 100 });
  const usual = session.call("view.list");
  const [slowRid, usualRid] = link.calls("view.list").map((frame) => frame.rid);
  clock.advance(100);
  await expect(slow).rejects.toMatchObject({ code: "timeout" });
  session.receive({ type: "result", rid: slowRid as string, ok: true, data: { views: [] } });
  session.receive({ type: "result", rid: usualRid as string, ok: true, data: { views: [] } });
  expect(await usual).toMatchObject({ ok: true });
  expect(clock.pending).toBe(0);
});

test("requests while not connected are refused with not_connected", async () => {
  const { session } = make();
  await expect(session.input("x")).rejects.toMatchObject({ code: "not_connected" });
  await expect(session.ping()).rejects.toMatchObject({ code: "not_connected" });
});

test("a link whose send throws is treated as closed", async () => {
  const { session } = online();
  const { session: other } = make();
  other.attach({
    send: (frame) => {
      if (frame.type !== "hello") throw new Error("socket gone");
    },
  });
  other.receive(welcome());
  await expect(other.input("x")).rejects.toMatchObject({ code: "link_closed" });
  expect(other.status).toBe("offline");
  expect(session.status).toBe("online");
});

test("typed helpers: view.list, view.get, log.page validate what comes back", async () => {
  const { session, link } = online();
  const listed = session.viewList();
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { views: [{ name: "me", schema: {} }, { name: 5 }, { name: "mod/x", schema: {}, title: "X" }] } });
  expect(await listed).toEqual({ ok: true, data: { views: [{ name: "me", schema: {} }, { name: "mod/x", schema: {}, title: "X" }] } });

  const page = session.logPage(10, 5);
  expect(link.last("call")).toMatchObject({ method: "log.page", params: { before: 10, limit: 5 } });
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { events: [narrative(3), { bogus: 1 }, narrative(2)] } });
  expect(await page).toEqual({ ok: true, data: { events: [narrative(2), narrative(3)] } });
  expect(session.droppedFrames).toBe(1);

  const broken = session.viewList();
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { nothing: true } });
  expect(await broken).toMatchObject({ ok: false, error: { code: "bad_result" } });
});

test("ping measures the round trip on the injected clock; a pong nobody asked for is ignored", async () => {
  const { session, clock, link } = online();
  const rtt = session.ping();
  const t = link.last("ping").t;
  session.receive({ type: "pong", t: t + 999 });
  clock.now += 42;
  session.receive({ type: "pong", t });
  expect(await rtt).toBe(42);
  expect(session.getSnapshot().rtt).toBe(42);
  const lost = session.ping();
  session.closed();
  await expect(lost).rejects.toMatchObject({ code: "link_closed" });
});

// --- the log --------------------------------------------------------------------------

test("events are kept in seq order without duplicates, and head follows the newest", () => {
  const { session } = online();
  for (const seq of [1, 2, 4, 3, 2, 4]) session.receive(narrative(seq));
  expect(seqs(session)).toEqual([1, 2, 3, 4]);
  expect(session.getSnapshot().head).toBe(4);
});

test("rewind cuts the log back and adopts the new epoch; the rewind itself stays in the log", () => {
  const { session } = online();
  for (const seq of [1, 2, 3, 4]) session.receive(narrative(seq));
  session.receive({ type: "event", seq: 5, id: "rw", ts: 5, kind: "rewind", data: { from: 3, kept: [], epoch: 2 } });
  expect(seqs(session)).toEqual([1, 2, 5]);
  expect(session.getSnapshot().epoch).toBe(2);
  // A replayed rewind of an older generation never moves the epoch back.
  session.receive({ type: "event", seq: 6, id: "rw0", ts: 6, kind: "rewind", data: { from: 6, kept: [], epoch: 1 } });
  expect(session.getSnapshot().epoch).toBe(2);
});

test("a rewind of interleaved turns removes from the middle: what `kept` names survives", () => {
  const { session } = online();
  // Turn 1's line, turn 2's line (accepted while turn 1 ran), turn 1's reply, turn 2's reply.
  for (const seq of [1, 2, 3, 4]) session.receive(narrative(seq));
  // Undo turn 2: its line (2) and reply (4) go; turn 1's reply (3) landed after the cut began and stays.
  session.receive({ type: "event", seq: 5, id: "rw", ts: 5, kind: "rewind", data: { from: 2, kept: [3], epoch: 2 } });
  expect(seqs(session)).toEqual([1, 3, 5]);
});

test("reset clears the log and adopts the new epoch", () => {
  const { session } = online();
  for (const seq of [1, 2, 3]) session.receive(narrative(seq));
  session.receive({ type: "signal", kind: "draft", data: { id: "d", text: "x" } });
  session.receive({ type: "event", seq: 4, id: "rs", ts: 4, kind: "reset", data: { scope: "story", epoch: 7 } });
  expect(session.getSnapshot()).toMatchObject({ epoch: 7, complete: true, drafts: [] });
  expect(session.getSnapshot().events.map((event) => event.kind)).toEqual(["reset"]);
});

test("a welcome under another epoch discards the log; under the same one it resumes after the newest seq", () => {
  const { session, link } = online();
  for (const seq of [1, 2, 3]) session.receive(narrative(seq));
  session.closed();
  const again = new FakeLink();
  session.attach(again);
  expect(again.last("hello").resume).toEqual({ epoch: 1, after: 3 });
  session.receive(welcome(1, 5));
  expect(seqs(session)).toEqual([1, 2, 3]);
  session.receive(narrative(4));
  session.receive(narrative(5));
  expect(seqs(session)).toEqual([1, 2, 3, 4, 5]);

  session.closed();
  const third = new FakeLink();
  session.attach(third);
  expect(third.last("hello").resume).toEqual({ epoch: 1, after: 5 });
  session.receive(welcome(2, 9));
  expect(seqs(session)).toEqual([]);
  expect(session.getSnapshot().epoch).toBe(2);
  session.receive(narrative(8));
  expect(seqs(session)).toEqual([8]);
  expect(link.sent[0]?.type).toBe("hello");
});

test("a gap the resume could not replay is detected and filled by loadOlder paging log.page", async () => {
  const { session, link } = online();
  for (const seq of [1, 2]) session.receive(narrative(seq));
  session.closed();
  const again = new FakeLink();
  session.attach(again);
  // 400 events happened meanwhile: the server replays the newest 200 (seq 203..402).
  session.receive(welcome(1, 402));
  for (let seq = 203; seq <= 402; seq++) session.receive(narrative(seq));
  expect(session.getSnapshot().gap).toEqual({ after: 2, before: 203 });

  const first = session.loadOlder();
  expect(again.last("call")).toMatchObject({ method: "log.page", params: { before: 203, limit: 100 } });
  session.receive({ type: "result", rid: again.last("call").rid, ok: true, data: { events: Array.from({ length: 100 }, (_, i) => narrative(103 + i)) } });
  expect(await first).toBe(100);
  expect(session.getSnapshot().gap).toEqual({ after: 2, before: 103 });

  const second = session.loadOlder();
  expect(again.last("call")).toMatchObject({ params: { before: 103 } });
  // Holes are normal (an undo removed some): the page reaches back past the gap's start.
  const page = [narrative(1), narrative(2), ...Array.from({ length: 98 }, (_, i) => narrative(5 + i))];
  session.receive({ type: "result", rid: again.last("call").rid, ok: true, data: { events: page } });
  expect(await second).toBe(98);
  expect(session.getSnapshot().gap).toBeNull();
  expect(seqs(session).slice(0, 4)).toEqual([1, 2, 5, 6]);
  expect(seqs(session).length).toBe(2 + 98 + 100 + 200);
  expect(link.sent.length).toBeGreaterThan(0);
});

test("loadOlder pages history before the oldest event while the window has room, and knows when it reached the start", async () => {
  const { session, link } = online({ maxEvents: 300 }, 1, 500);
  for (let seq = 301; seq <= 500; seq++) session.receive(narrative(seq));
  expect(session.getSnapshot().complete).toBe(false);
  const load = session.loadOlder();
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { events: Array.from({ length: 100 }, (_, i) => narrative(201 + i)) } });
  expect(await load).toBe(100);
  expect(seqs(session)[0]).toBe(201);
  // The window is full: nothing more is fetched.
  expect(await session.loadOlder()).toBe(0);
  expect(link.calls("log.page").length).toBe(1);
});

test("a page that arrives after the log was cut is void", async () => {
  const { session, link } = online({}, 1, 300);
  for (let seq = 101; seq <= 300; seq++) session.receive(narrative(seq));
  const load = session.loadOlder();
  session.receive({ type: "event", seq: 301, id: "rw", ts: 1, kind: "rewind", data: { from: 251, kept: [], epoch: 2 } });
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { events: [narrative(99), narrative(100)] } });
  expect(await load).toBe(0);
  expect(seqs(session)[0]).toBe(101);
});

test("the window keeps at most maxEvents, dropping the oldest", () => {
  const { session } = online({ maxEvents: 3 });
  for (const seq of [1, 2, 3, 4, 5]) session.receive(narrative(seq));
  expect(seqs(session)).toEqual([3, 4, 5]);
  expect(session.getSnapshot().complete).toBe(false);
});

test("an event of an unknown kind is ignored but still counts as seen for a resume", () => {
  const { session } = online();
  session.receive(narrative(1));
  session.receive({ type: "event", seq: 2, id: "x", ts: 2, kind: "smell", data: {} });
  expect(seqs(session)).toEqual([1]);
  session.closed();
  const link = new FakeLink();
  session.attach(link);
  expect(link.last("hello").resume).toEqual({ epoch: 1, after: 2 });
});

// --- drafts, turn, notices ------------------------------------------------------------

test("drafts append, discard, and are replaced by the narrative event with the same id", () => {
  const { session } = online();
  session.receive({ type: "signal", kind: "draft", data: { id: "a", text: "Hel" } });
  session.receive({ type: "signal", kind: "draft", data: { id: "a", text: "lo" } });
  session.receive({ type: "signal", kind: "draft", data: { id: "b", text: "tool round" } });
  expect(session.getSnapshot().drafts).toEqual([
    { id: "a", text: "Hello" },
    { id: "b", text: "tool round" },
  ]);
  session.receive({ type: "signal", kind: "draft", data: { id: "b", discard: true } });
  expect(session.getSnapshot().drafts).toEqual([{ id: "a", text: "Hello" }]);
  session.receive(narrative(1, "a", "Hello."));
  expect(session.getSnapshot().drafts).toEqual([]);
  expect(session.getSnapshot().events.at(-1)).toMatchObject({ id: "a", data: { text: "Hello." } });
  // A late slice for a bubble whose event already arrived is dropped.
  session.receive({ type: "signal", kind: "draft", data: { id: "a", text: "!" } });
  expect(session.getSnapshot().drafts).toEqual([]);
});

test("the latest turn status is kept; idle clears leftover drafts; notices are delivered, not kept", () => {
  const { session } = online();
  const notices: string[] = [];
  const signals: string[] = [];
  session.onNotice((notice) => notices.push(notice.text));
  const off = session.onSignal((frame) => signals.push(frame.kind));
  session.receive({ type: "signal", kind: "turn", data: { status: "busy", actor: "Ada" } });
  expect(session.getSnapshot().turn).toEqual({ status: "busy", actor: "Ada" });
  session.receive({ type: "signal", kind: "draft", data: { id: "x", text: "half" } });
  session.receive({ type: "signal", kind: "notice", data: { level: "warn", text: "The turn failed." } });
  session.receive({ type: "signal", kind: "turn", data: { status: "idle" } });
  expect(session.getSnapshot()).toMatchObject({ turn: { status: "idle" }, drafts: [] });
  expect(notices).toEqual(["The turn failed."]);
  off();
  session.receive({ type: "signal", kind: "audio", data: { id: "a", action: "stop", layer: "bgm" } });
  expect(signals).toEqual(["turn", "draft", "notice", "turn"]);
});

// --- views ----------------------------------------------------------------------------

const me = (name: string) => ({ member: { id: "m1", name, role: "player", roleLabel: "Player" }, character: null });

test("views: subscribe, latest value per name, a stale rev ignored, typed and module accessors", async () => {
  const { session, link } = online();
  const subscribed = session.viewSubscribe(["me", "mod/clock", "nope"]);
  expect(link.last("call")).toMatchObject({ method: "view.subscribe", params: { names: ["me", "mod/clock", "nope"] } });
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { problems: [{ name: "nope", code: "unknown_view" }] } });
  expect(await subscribed).toEqual({ ok: true, data: { problems: [{ name: "nope", code: "unknown_view" }] } });
  expect(session.getSnapshot().viewProblems.get("nope")).toBe("unknown_view");

  session.receive({ type: "view", name: "me", rev: 2, at: 5, data: me("Ada") });
  session.receive({ type: "view", name: "me", rev: 1, at: 4, data: me("Old") });
  session.receive({ type: "view", name: "mod/clock", rev: 1, at: 5, data: { hour: 3 } });
  session.receive({ type: "view", name: "party", rev: 1, at: 5, data: {} });
  expect(session.view("me")?.data.member.name).toBe("Ada");
  expect(builtInView(session.getSnapshot(), "me")).toMatchObject({ rev: 2, at: 5 });
  expect(session.moduleView("mod/clock")?.data).toEqual({ hour: 3 });
  expect(session.getSnapshot().views.has("party")).toBe(false);

  // The audio view is a built-in: typed, and checked against its schema like the others.
  const audio = { library: [{ hash: "h", mime: "audio/ogg", size: 3 }], playing: { ambience: { id: "harbor/bell", title: "Bell", hash: "h", mime: "audio/ogg", size: 3, loop: true, volume: 1, paused: false } } };
  void session.viewSubscribe(["audio"]);
  session.receive({ type: "view", name: "audio", rev: 1, at: 5, data: audio });
  expect(session.view("audio")?.data.playing.ambience?.title).toBe("Bell");
  session.receive({ type: "view", name: "audio", rev: 2, at: 6, data: { library: "all of it", playing: {} } });
  expect(session.view("audio")?.rev).toBe(1);

  // A built-in view that does not fit its schema never reaches the UI.
  session.receive({ type: "view", name: "me", rev: 3, at: 6, data: { member: "Ada" } });
  expect(session.view("me")?.rev).toBe(2);
  expect(session.getSnapshot().lastError).toMatchObject({ code: "bad_view" });

  const removed = session.viewUnsubscribe(["mod/clock"]);
  expect(session.moduleView("mod/clock")).toBeNull();
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { removed: ["mod/clock"] } });
  expect(await removed).toEqual({ ok: true, data: { removed: ["mod/clock"] } });
  session.receive({ type: "view", name: "mod/clock", rev: 2, at: 6, data: { hour: 4 } });
  expect(session.moduleView("mod/clock")).toBeNull();
});

test("view.get updates a wanted view under the same rules", async () => {
  const { session, link } = online();
  void session.viewSubscribe(["me"]);
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { problems: [] } });
  session.receive({ type: "view", name: "me", rev: 1, at: 1, data: me("Ada") });
  const got = session.viewGet("me");
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { name: "me", rev: 2, at: 3, data: me("Ada L.") } });
  expect(await got).toMatchObject({ ok: true, data: { rev: 2 } });
  expect(session.view("me")?.data.member.name).toBe("Ada L.");
});

test("after a reattach the session re-subscribes what it wants, and the new connection's revs start over", async () => {
  const { session, link } = online();
  void session.viewSubscribe(["me", "party"]);
  session.receive({ type: "result", rid: link.last("call").rid, ok: true, data: { problems: [] } });
  session.receive({ type: "view", name: "me", rev: 5, at: 1, data: me("Ada") });
  session.closed();
  // Wanted while offline: remembered, subscribed on the next connection.
  await expect(session.viewSubscribe(["room"])).rejects.toMatchObject({ code: "not_connected" });
  const again = new FakeLink();
  session.attach(again);
  expect(again.calls("view.subscribe")).toEqual([]);
  session.receive(welcome(1, 0));
  expect(again.calls("view.subscribe").map((frame) => frame.params.names)).toEqual([["me", "party", "room"]]);
  // The held value stays visible until the new one arrives, and rev 1 of the new connection replaces rev 5.
  expect(session.view("me")?.rev).toBe(5);
  session.receive({ type: "view", name: "me", rev: 1, at: 1, data: me("Ada again") });
  expect(session.view("me")).toMatchObject({ rev: 1, data: { member: { name: "Ada again" } } });
});

// --- snapshots ------------------------------------------------------------------------

test("the snapshot is the same object until something changes, and listeners hear each change", () => {
  const { session } = online();
  let heard = 0;
  const off = session.subscribe(() => heard++);
  const before = session.getSnapshot();
  expect(session.getSnapshot()).toBe(before);
  // Nothing that changes state: no new snapshot, no notification.
  session.receive({ type: "result", rid: "nobody", ok: true });
  session.receive({ type: "hologram" });
  session.receive({ type: "pong", t: 1 });
  expect(session.getSnapshot()).toBe(before);
  expect(heard).toBe(0);
  session.receive(narrative(1));
  const after = session.getSnapshot();
  expect(after).not.toBe(before);
  expect(after.events).not.toBe(before.events);
  expect(after.views).toBe(before.views);
  expect(heard).toBe(1);
  expect(Object.isFrozen(after)).toBe(true);
  // A duplicate still notifies, but the events list stays the same object.
  session.receive(narrative(1));
  expect(session.getSnapshot().events).toBe(after.events);
  off();
  session.receive(narrative(2));
  expect(heard).toBe(2);
});

test("a listener that throws does not break the session or the other listeners", () => {
  const errors: unknown[] = [];
  const { session } = online({ onListenerError: (error) => errors.push(error) });
  let heard = 0;
  session.subscribe(() => {
    throw new Error("boom");
  });
  session.subscribe(() => heard++);
  session.receive(narrative(1));
  expect(seqs(session)).toEqual([1]);
  expect(heard).toBe(1);
  expect(errors).toHaveLength(1);
});

test("a superseded attachment is deaf", () => {
  const { session } = make();
  const first = session.attach(new FakeLink());
  session.attach(new FakeLink());
  first.receive(welcome());
  expect(session.status).toBe("connecting");
  first.closed("late");
  expect(session.status).toBe("connecting");
});

test("stripControlChars is re-exported from the v3 entry", () => {
  expect(stripControlChars("a\x1b]0;x\x07b")).toBe("a]0;xb");
});

test("after a reset the room's head stays high, but a first visit knows from `first` that it holds the whole log", () => {
  // 900 events were handed out and reset away; the log now holds two, numbered 901 and 902.
  const fresh = make();
  fresh.session.attach(new FakeLink());
  fresh.session.receive(welcome(3, 902, "player", 901));
  expect(fresh.session.getSnapshot().complete).toBe(true);

  // The same head with history reaching back before the replayed stretch: not complete.
  const other = make();
  other.session.attach(new FakeLink());
  other.session.receive(welcome(3, 902, "player", 10));
  expect(other.session.getSnapshot().complete).toBe(false);
});
