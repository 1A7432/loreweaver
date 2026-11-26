// The gate that the two sides agree: the protocol package's client `Session` wired to this
// server's real `Session` over an in-memory pair (every frame goes through JSON, delivered
// asynchronously and in order, as a transport would), against a real room with the scripted
// Keeper of the room benches. The client's picture of the log is checked against the
// server's own stored log after every operation that moves it.
import { afterEach, expect, test } from "bun:test";

import {
  Session as ClientSession,
  type Attachment,
  type ClientFrame,
  type EventFrame,
  type Result,
  type ServerFrame,
  type SessionOptions, PAGE_LIMIT } from "loreweaver-protocol/v3";

import { Session as ServerSession } from "../../src/net/session.ts";
import { KEYS, ROOM, RoomBench } from "../gateway/room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((b) => b.close()));
});

function setup(): RoomBench {
  const b = new RoomBench();
  benches.push(b);
  return b;
}

/** One client and the connections it has made, each a fresh server session. */
class Player {
  readonly session: ClientSession;
  /** What the server sent on each connection, as the client received it. */
  readonly received: ServerFrame[][] = [];
  #bench: RoomBench;
  #server: ServerSession | null = null;
  #attachment: Attachment | null = null;
  #live = false;

  constructor(bench: RoomBench, key: string, options: Partial<SessionOptions> = {}) {
    this.#bench = bench;
    this.session = new ClientSession({ key, locale: "en", client: { name: "roundtrip", version: "0" }, caps: [], ...options });
  }

  /** Dial: a new server session, a new link, hello. */
  connect(): void {
    const frames: ServerFrame[] = [];
    this.received.push(frames);
    this.#live = true;
    const alive = (): boolean => this.#live && this.#server === server;
    const server: ServerSession = new ServerSession(
      { keystore: this.#bench.keystore, room: (id) => this.#bench.hub.room(id) },
      {
        send: (frame) => {
          const wire = JSON.stringify(frame);
          queueMicrotask(() => {
            if (!alive()) return;
            const value = JSON.parse(wire) as ServerFrame;
            frames.push(value);
            this.#attachment?.receive(value);
          });
        },
        close: () => {
          queueMicrotask(() => {
            if (!alive()) return;
            this.#live = false;
            this.#attachment?.closed("server closed the connection");
          });
        },
      },
    );
    this.#server = server;
    this.#attachment = this.session.attach({
      send: (frame: ClientFrame) => {
        const wire = JSON.stringify(frame);
        queueMicrotask(() => {
          if (alive()) server.receive(JSON.parse(wire));
        });
      },
    });
  }

  /** The network drops: both sides notice. */
  drop(): void {
    this.#live = false;
    this.#server?.closed();
    this.#attachment?.closed("network dropped");
  }

  seqs(): number[] {
    return this.session.getSnapshot().events.map((event) => event.seq);
  }

  /** Events this connection was sent. */
  eventsOn(connection: number): EventFrame[] {
    return (this.received[connection] ?? []).filter((frame): frame is EventFrame => frame.type === "event");
  }
}

/** Let both sides run until nothing is left in flight. */
async function settle(b: RoomBench): Promise<void> {
  for (let round = 0; round < 6; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await b.settled();
  }
}

/** The room's log as the server stores it, by seq. */
function serverSeqs(b: RoomBench): number[] {
  return b.store.eventsAfter(ROOM, 0, 10_000).map((event) => event.seq);
}

/** The room's log as the server stores it, as it would go on the wire. */
function serverLog(b: RoomBench): unknown[] {
  return b.store.eventsAfter(ROOM, 0, 10_000).map((event) => JSON.parse(JSON.stringify({ type: "event", ...event, ...(event.turn === undefined ? {} : { turn: event.turn }) })) as unknown);
}

async function join(b: RoomBench, key: string, options: Partial<SessionOptions> = {}): Promise<Player> {
  const player = new Player(b, key, options);
  player.connect();
  await settle(b);
  expect(player.session.status).toBe("online");
  return player;
}

/** Await a request while the bench runs. */
async function done<T>(b: RoomBench, pending: Promise<T>): Promise<T> {
  await settle(b);
  return pending;
}

function narratives(player: Player): [string, string][] {
  return player.session
    .getSnapshot()
    .events.filter((event): event is Extract<EventFrame, { kind: "narrative" }> => event.kind === "narrative")
    .map((event) => [event.data.speaker, event.data.text]);
}

test("hello, welcome, a line of speech: its result, then the player's and the Keeper's narrative in the client's log", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const snapshot = ada.session.getSnapshot();
  expect(snapshot.welcome).toMatchObject({ protocol: "3.0", room: { id: ROOM, locale: "en" }, you: { name: "Ada", role: "player" }, epoch: 1, head: 0 });
  expect(snapshot).toMatchObject({ epoch: 1, head: 0, complete: true, events: [] });

  const said = ada.session.input("I open the door.");
  expect(await done(b, said)).toEqual({ ok: true, data: undefined });
  expect(narratives(ada)).toEqual([
    ["player", "I open the door."],
    ["kp", "Reply 1"],
  ]);
  const events = ada.session.getSnapshot().events;
  expect(events.map((event) => event.turn)).toEqual([1, 1]);
  expect(events.map((event) => event.seq)).toEqual(serverSeqs(b));
  expect(events as unknown[]).toEqual(serverLog(b));
  expect(ada.session.getSnapshot()).toMatchObject({ head: 2, turn: { status: "idle" }, drafts: [] });
  expect(ada.session.droppedFrames).toBe(0);
});

test("fatal refusals end the client for good; the caller can tell them from a dropped link", async () => {
  const b = setup();
  const stranger = new Player(b, "no-such-key");
  stranger.connect();
  await settle(b);
  expect(stranger.session.status).toBe("ended");
  expect(stranger.session.canRedial).toBe(false);
  expect(stranger.session.getSnapshot().lastError).toMatchObject({ code: "bad_key", fatal: true });

  const loud = new Player(b, KEYS.ada, { name: "x".repeat(65) });
  loud.connect();
  await settle(b);
  expect(loud.session.getSnapshot().lastError).toMatchObject({ code: "bad_name", fatal: true });

  const ada = await join(b, KEYS.ada);
  ada.drop();
  expect(ada.session.status).toBe("offline");
  expect(ada.session.canRedial).toBe(true);
});

test("a roll through command.run and through typed text reach the same command with the same outcome shape", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const run = await done(b, ada.session.runCommand("roll", { expr: "2d6" }));
  const typed = await done(b, ada.session.input(".r 2d6"));
  expect(run.ok && typed.ok).toBe(true);
  const shape = (result: Result): unknown => (result.ok ? { text: result.text, totals: (result.data as { totals: number[] }).totals.length } : result.error.code);
  expect(shape(run)).toEqual(shape(typed));
  const dice = ada.session.getSnapshot().events.filter((event): event is Extract<EventFrame, { kind: "dice" }> => event.kind === "dice");
  expect(dice).toHaveLength(2);
  const [first, second] = dice;
  expect({ ...first?.data, rolls: undefined, total: undefined, detail: undefined }).toEqual({ ...second?.data, rolls: undefined, total: undefined, detail: undefined });
  expect(first?.data).toMatchObject({ actor: "Ada", kind: "roll", expr: "2d6" });
  expect(run.ok ? (run.data as { totals: number[] }).totals[0] : null).toBe(first?.data.total as number);
  // A command opens no Keeper turn: nothing but the two rolls is in the log.
  expect(ada.session.getSnapshot().events.map((event) => event.kind)).toEqual(["dice", "dice"]);
  expect(ada.seqs()).toEqual(serverSeqs(b));

  // A refusal is the caller's answer and never an event.
  const refused = await done(b, ada.session.runCommand("roll", { expr: "" }));
  expect(refused.ok).toBe(false);
  const unknown = await done(b, ada.session.call("no.such"));
  expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_method" } });
  expect(ada.seqs()).toEqual(serverSeqs(b));
});

test("views: me, party and commands subscribed; a sheet change pushes a new `me`; view.list and view.get agree", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const subscribed = await done(b, ada.session.viewSubscribe(["me", "party", "commands"]));
  expect(subscribed).toEqual({ ok: true, data: { problems: [] } });
  expect(ada.session.view("me")?.data.member).toMatchObject({ name: "Ada", role: "player" });
  expect(ada.session.view("me")?.data.character).toBeNull();
  expect(ada.session.view("party")?.data.members.map((member) => member.name)).toEqual(["Ada"]);
  const roll = ada.session.view("commands")?.data.commands.find((command) => command.id === "roll");
  expect(roll).toMatchObject({ source: "engine", available: true });

  expect(await done(b, ada.session.input(".coc Alice"))).toMatchObject({ ok: true });
  const seated = ada.session.view("me");
  expect(seated?.data.character?.name).toBe("Alice");
  const hp = seated?.data.character?.resources.find((resource) => resource.id === "hp");
  expect(hp).toBeDefined();

  expect(await done(b, ada.session.input(".st HP-2"))).toMatchObject({ ok: true });
  const after = ada.session.view("me");
  expect(after?.rev).toBeGreaterThan(seated?.rev ?? 0);
  expect(after?.data.character?.resources.find((resource) => resource.id === "hp")?.value).toBe((hp?.value ?? 0) - 2);
  expect(after?.at).toBe(b.store.room(ROOM).head);

  // Another member arriving changes `party`.
  await join(b, KEYS.bao);
  expect(ada.session.view("party")?.data.members.map((member) => member.name)).toEqual(["Ada", "Bao"]);

  const listed = await done(b, ada.session.viewList());
  expect(listed.ok && listed.data.views.map((view) => view.name)).toEqual(expect.arrayContaining(["me", "party", "commands", "scene", "room"]));
  expect(listed.ok && listed.data.views.some((view) => view.name.startsWith("admin/"))).toBe(false);
  const got = await done(b, ada.session.viewGet("me"));
  expect(got).toMatchObject({ ok: true, data: { name: "me", rev: after?.rev } });

  const refused = await done(b, ada.session.viewSubscribe(["admin/model", "nope"]));
  expect(refused.ok && refused.data.problems.map((problem) => problem.code)).toEqual(["unknown_view", "unknown_view"]);
  expect(ada.session.getSnapshot().viewProblems.get("nope")).toBe("unknown_view");
  expect(ada.session.droppedFrames).toBe(0);
  expect(ada.session.getSnapshot().lastError).toBeNull();
});

test("an admin's undo reaches every client as a rewind that cuts its log back to the server's", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const root = await join(b, KEYS.root);
  await done(b, ada.session.input("one"));
  await done(b, ada.session.input("two"));
  expect(ada.seqs()).toEqual([1, 2, 3, 4]);

  const undone = await done(b, root.session.runCommand("undo", {}));
  expect(undone).toMatchObject({ ok: true, data: { turn: 1, epoch: 2 } });
  for (const player of [ada, root]) {
    expect(player.session.getSnapshot().epoch).toBe(2);
    expect(player.seqs()).toEqual(serverSeqs(b));
    expect(player.session.getSnapshot().events as unknown[]).toEqual(serverLog(b));
  }
  expect(ada.seqs()).toEqual([1, 2, 5]);
  expect(narratives(ada)).toEqual([
    ["player", "one"],
    ["kp", "Reply 1"],
  ]);
  expect(ada.session.getSnapshot().events.at(-1)).toMatchObject({ kind: "rewind", data: { from: 3, kept: [], epoch: 2 } });

  // Typed, by a player: refused, as the caller's answer only.
  const refused = await done(b, ada.session.input(".undo"));
  expect(refused.ok).toBe(false);
  expect(ada.seqs()).toEqual(serverSeqs(b));

  // Play goes on in the new generation.
  await done(b, ada.session.input("three"));
  expect(ada.seqs()).toEqual(serverSeqs(b));
  expect(narratives(ada).at(-1)).toEqual(["kp", "Reply 3"]);
});

// Turns interleave in the log: a line is logged when it is accepted, its reply when the
// Keeper's turn ends. Undoing the later turn then removes events from the MIDDLE, and the
// rewind says so: everything from `from` on is gone except what `kept` names. (The first
// form of the event, `rewind {to}` — "drop what follows `to`" — could not say it, and the
// client kept a line the server had deleted; this test found that.)
test("an undo of interleaved turns leaves the client's log equal to the server's", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const root = await join(b, KEYS.root);
  // Both lines are accepted before the first turn runs.
  const first = ada.session.input("a");
  const second = ada.session.input("b");
  await done(b, Promise.all([first, second]));
  expect(ada.session.getSnapshot().events.map((event) => [event.seq, event.turn])).toEqual([
    [1, 1],
    [2, 2],
    [3, 1],
    [4, 2],
  ]);
  await done(b, root.session.runCommand("undo", {}));
  expect(serverSeqs(b)).toEqual([1, 3, 5]);
  expect(ada.seqs()).toEqual(serverSeqs(b));
  expect(ada.session.getSnapshot().events.at(-1)).toMatchObject({ kind: "rewind", data: { from: 2, kept: [3], epoch: 2 } });
  expect(ada.session.getSnapshot().events as unknown[]).toEqual(serverLog(b));
});

test("drop the link and reattach: the resume fills exactly what was missed, views come back, and requests in flight were rejected", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const bao = await join(b, KEYS.bao);
  await done(b, ada.session.viewSubscribe(["me", "party"]));
  await done(b, ada.session.input("before the drop"));
  const held = ada.seqs();
  expect(held).toEqual([1, 2]);

  // A request whose answer never comes back: rejected when the link goes.
  const lost = ada.session.call("view.list");
  ada.drop();
  await expect(lost).rejects.toMatchObject({ code: "link_closed" });
  expect(ada.session.getSnapshot()).toMatchObject({ status: "offline", turn: null });

  await done(b, bao.session.input("while Ada is away"));
  await done(b, bao.session.runCommand("roll", { expr: "1d6" }));
  await done(b, bao.session.input("still away"));
  const missed = serverSeqs(b).filter((seq) => seq > 2);
  expect(missed).toEqual([3, 4, 5, 6, 7]);
  expect(ada.seqs()).toEqual(held);
  expect(ada.session.view("party")?.data.members.map((member) => member.name)).toEqual(["Ada", "Bao"]);

  ada.connect();
  await settle(b);
  expect(ada.session.status).toBe("online");
  // Exactly the missed events were sent on the new connection, once each.
  expect(ada.eventsOn(1).map((event) => event.seq)).toEqual(missed);
  expect(ada.seqs()).toEqual(serverSeqs(b));
  expect(ada.session.getSnapshot().events as unknown[]).toEqual(serverLog(b));
  expect(ada.session.getSnapshot().gap).toBeNull();
  // Subscriptions died with the connection; the session made them again.
  const viewsOnNew = (ada.received[1] ?? []).filter((frame) => frame.type === "view").map((frame) => (frame.type === "view" ? frame.name : ""));
  expect(viewsOnNew).toEqual(expect.arrayContaining(["me", "party"]));
  expect(ada.session.view("party")?.rev).toBeGreaterThanOrEqual(1);
  expect(ada.session.view("party")?.data.members.map((member) => member.name).sort()).toEqual(["Ada", "Bao"]);

  // The reattached connection works as any other.
  expect(await done(b, ada.session.input("back"))).toMatchObject({ ok: true });
  expect(ada.seqs()).toEqual(serverSeqs(b));
});

test("a resume past the server's replay window leaves a gap that loadOlder fills from log.page", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const bao = await join(b, KEYS.bao);
  await done(b, ada.session.input("hello"));
  ada.drop();
  // 260 rolls while Ada is away: more than the server replays on a resume (200).
  for (let i = 0; i < 260; i++) void bao.session.runCommand("roll", { expr: "1d6" });
  await settle(b);
  expect(b.store.room(ROOM).head).toBe(262);

  ada.connect();
  await settle(b);
  expect(ada.eventsOn(1).length).toBe(200);
  expect(ada.session.getSnapshot().gap).toEqual({ after: 2, before: 63 });
  let added = 0;
  while (ada.session.getSnapshot().gap !== null) {
    const loading = ada.session.loadOlder();
    await settle(b);
    added += await loading;
  }
  expect(added).toBe(60);
  expect(ada.seqs()).toEqual(serverSeqs(b));
  expect(ada.session.getSnapshot().events as unknown[]).toEqual(serverLog(b));

  // A newcomer gets the newest stretch and pages the rest back.
  const late = await join(b, KEYS.root);
  expect(late.session.getSnapshot().complete).toBe(false);
  expect(late.seqs()[0]).toBe(63);
  while (!late.session.getSnapshot().complete) {
    const loading = late.session.loadOlder();
    await settle(b);
    if ((await loading) === 0) break;
  }
  expect(late.seqs()).toEqual(serverSeqs(b));
});

test("an undo while a client is away: the welcome's new epoch makes it discard its log and take the server's afresh", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const root = await join(b, KEYS.root);
  await done(b, ada.session.input("one"));
  await done(b, ada.session.input("two"));
  ada.drop();
  await done(b, root.session.runCommand("undo", {}));
  ada.connect();
  await settle(b);
  expect(ada.session.getSnapshot().epoch).toBe(2);
  expect(ada.seqs()).toEqual(serverSeqs(b));
  expect(ada.session.getSnapshot().events as unknown[]).toEqual(serverLog(b));
});

test("a reset clears every client's log and moves the epoch", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const root = await join(b, KEYS.root);
  await done(b, ada.session.input("one"));
  await done(b, ada.session.runCommand("roll", { expr: "1d6" }));
  const epoch = ada.session.getSnapshot().epoch ?? 0;

  expect(await done(b, root.session.input(".reset story"))).toMatchObject({ ok: true, data: { armed: "story" } });
  expect(ada.seqs()).toEqual(serverSeqs(b));
  expect(await done(b, root.session.input(".reset story confirm"))).toMatchObject({ ok: true });
  for (const player of [ada, root]) {
    expect(player.session.getSnapshot().epoch).toBe(epoch + 1);
    expect(player.session.getSnapshot().events.map((event) => event.kind)).toEqual(["reset"]);
    expect(player.session.getSnapshot().complete).toBe(true);
    expect(player.seqs()).toEqual(serverSeqs(b));
  }

  // After the reset play starts over, and a resume sees the same generation.
  await done(b, ada.session.input("again"));
  ada.drop();
  ada.connect();
  await settle(b);
  expect(ada.eventsOn(ada.received.length - 1)).toEqual([]);
  expect(ada.session.getSnapshot().events as unknown[]).toEqual(serverLog(b));
});

test("ping: only the client pings, and the pong measures the round trip", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const rtt = await done(b, ada.session.ping());
  expect(rtt).toBeGreaterThanOrEqual(0);
  expect(ada.session.getSnapshot().rtt).toBe(rtt);
});

test("a page over the protocol's limit is refused, not cut to it", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  await done(b, ada.session.input("one"));
  const over = await done(b, ada.session.call("log.page", { before: 10, limit: PAGE_LIMIT + 1 }));
  expect(over).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  const within = await done(b, ada.session.call("log.page", { before: 10, limit: PAGE_LIMIT }));
  expect(within.ok).toBe(true);
});
