// The gate that the two sides agree: the protocol package's client `Session` wired to this
// server's real `Session` over an in-memory pair (every frame goes through JSON, delivered
// asynchronously and in order, as a transport would), against a real room with the scripted
// Keeper of the room benches. The client's picture of the log is checked against the
// server's own stored log after every operation that moves it.
import { afterEach, expect, test } from "bun:test";

import {
  decodeByteReply,
  encodeByteLine,
  Session as ClientSession,
  type Attachment,
  type ClientFrame,
  type EventFrame,
  type Result,
  type ServerFrame,
  type SessionOptions, MAX_LINE_BYTES, PAGE_LIMIT } from "loreweaver-protocol/v3";

import { createHash } from "node:crypto";

import { ModelSettings } from "../../src/gateway/model_settings.ts";
import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { ServerSettings } from "../../src/infra/server_settings.ts";
import { ByteChannel } from "../../src/net/bytes.ts";
import { Session as ServerSession } from "../../src/net/session.ts";
import { KEYS, reply, ROOM, RoomBench, type BenchOptions } from "../gateway/room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((b) => b.close()));
});

function setup(options: BenchOptions = {}): RoomBench {
  const b = new RoomBench(options);
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

  /**
   * A PUT on a byte stream of the current connection (the byte channel beside the control
   * stream): the header line, the body in reads no larger than the server asks for, the end of
   * the stream. The server's answer line.
   */
  async put(uploadId: string, bytes: Uint8Array): Promise<unknown> {
    const server = this.#server;
    if (server === null) throw new Error("not connected");
    const header = encodeByteLine({ op: "put", upload_id: uploadId });
    let sentHeader = false;
    let at = 0;
    const read = (max: number): Promise<Uint8Array | null> => {
      if (!sentHeader) {
        sentHeader = true;
        return Promise.resolve(header);
      }
      if (at >= bytes.length) return Promise.resolve(null);
      const chunk = bytes.subarray(at, at + max);
      at += chunk.length;
      return Promise.resolve(chunk);
    };
    const out: Uint8Array[] = [];
    await new ByteChannel(() => server.byteAccess(), () => "en").serve(
      { read, stop: () => undefined },
      {
        write: (chunk) => {
          out.push(chunk.slice());
          return Promise.resolve();
        },
        finish: () => Promise.resolve(),
      },
    );
    const text = Buffer.concat(out).toString("utf8");
    return decodeByteReply(JSON.parse(text.slice(0, text.indexOf("\n"))));
  }

  /** The network drops: both sides notice. */
  drop(): void {
    this.#live = false;
    this.#server?.closed();
    this.#attachment?.closed("network dropped");
  }

  /**
   * A GET on a byte stream of the current connection: the server's answer line, and the
   * bytes that follow it when it says yes.
   */
  async get(hash: string): Promise<{ readonly head: Record<string, unknown>; readonly body: Uint8Array }> {
    const server = this.#server;
    if (server === null) throw new Error("not connected");
    const queue = [encodeByteLine({ op: "get", hash })];
    const out: Uint8Array[] = [];
    await new ByteChannel(() => server.byteAccess(), () => "en").serve(
      { read: () => Promise.resolve(queue.shift() ?? null), stop: () => undefined },
      {
        write: (chunk) => {
          out.push(chunk.slice());
          return Promise.resolve();
        },
        finish: () => Promise.resolve(),
      },
    );
    const all = Buffer.concat(out);
    const end = all.indexOf(0x0a);
    return { head: JSON.parse(all.subarray(0, end).toString("utf8")) as Record<string, unknown>, body: new Uint8Array(all.subarray(end + 1)) };
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
  expect({ ...first?.data, rolls: undefined, total: undefined, text: undefined, detail: undefined }).toEqual({ ...second?.data, rolls: undefined, total: undefined, text: undefined, detail: undefined });
  expect(first?.data).toMatchObject({ actor: "Ada", kind: "roll", expr: "2d6" });
  // A plain roll states itself in `text`; `detail.text` keeps the same line.
  expect(first?.data.text).toMatch(/^2d6 \(\d, \d\) = \d+$/u);
  expect(first?.data.text).toBe((first?.data.detail as { text: string }).text);
  expect(first?.data.label).toBeUndefined();
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

test("views: a module's character, seated by its module, reaches the client through the views' schemas — `module`, resources without a maximum — for its player and another member", async () => {
  const b = setup({ modules: ["colony"] });
  const ada = await join(b, KEYS.ada);
  const bao = await join(b, KEYS.bao);
  await done(b, ada.session.viewSubscribe(["me", "party", "characters"]));
  await done(b, bao.session.viewSubscribe(["party", "characters"]));
  expect(await done(b, ada.session.runCommand("colony/join", { settler: "ana" }))).toMatchObject({ ok: true, text: "joined" });
  const resources = [
    { id: "hp", label: "HP", value: 5, max: 5 },
    { id: "food", label: "Food", value: 0 },
  ];
  expect(ada.session.view("me")?.data.character).toEqual({ id: "colony:ana", name: "Ana", pack: "", status: [], resources, attributes: [], skills: [], module: "colony" });
  expect(bao.session.view("party")?.data.characters).toEqual([{ id: "colony:ana", name: "Ana", pack: "", status: [], resources, player: { id: expect.any(String), name: "Ada" }, module: "colony" }]);
  const offered = bao.session.view("characters")?.data.claimable.find((entry) => entry.id === "colony:ana");
  expect(offered).toMatchObject({ source: { kind: "module", id: "colony" }, player: { name: "Ada" } });
  // Nothing was dropped as not matching a schema.
  for (const player of [ada, bao]) {
    expect(player.session.droppedFrames).toBe(0);
    expect([...player.session.getSnapshot().viewProblems.values()]).toEqual([]);
  }
});

function diceData(player: Player): Extract<EventFrame, { kind: "dice" }>["data"][] {
  return player.session
    .getSnapshot()
    .events.filter((event): event is Extract<EventFrame, { kind: "dice" }> => event.kind === "dice")
    .map((event) => event.data);
}

test("a dice event reads without the rule system: label and text in the room's language, through the client as the server stored them", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada, { locale: "zh" });
  for (const line of [".coc Alice", ".ra 侦查", ".rav 斗殴, 闪避", ".sc 1/1d6", ".en 侦查", ".ti", ".ri roll"]) expect(await done(b, ada.session.input(line))).toMatchObject({ ok: true });
  // The client's language is Chinese; the room's is English, and events are the table's.
  const rolled = diceData(ada).map((data) => ({ kind: data.kind, label: data.label, text: data.text }));
  expect(rolled).toEqual([
    { kind: "check", label: "Spot Hidden", text: undefined },
    { kind: "opposed", label: "Fighting (Brawl)", text: "Fighting (Brawl) 28 (Failure) vs Dodge 53 (Failure): Dodge wins (higher value)" },
    { kind: "subsystem", label: "Sanity", text: "Sanity 55 vs 75 (Success): loses 1 (1 = 1), Sanity 75 → 74" },
    { kind: "subsystem", label: "Spot Hidden", text: "Spot Hidden 91 vs 25: grows by 10, 25 → 35" },
    { kind: "subsystem", label: "Temporary madness", text: expect.stringMatching(/^Temporary madness \(8\): /u) },
    { kind: "init", label: "Initiative", text: undefined },
  ]);
  // `detail` is as it was.
  expect(diceData(ada)[1]?.detail).toMatchObject({ winner: "b", decidedBy: "value", a: { skill: "Fighting (Brawl)", total: 28 }, b: { skill: "Dodge", total: 53 } });
  expect(ada.session.getSnapshot().events as unknown[]).toEqual(serverLog(b));

  // In a Chinese room the same rolls read in Chinese.
  const root = await join(b, KEYS.root);
  expect(await done(b, root.session.runCommand("language", { locale: "zh" }))).toMatchObject({ ok: true });
  expect(await done(b, ada.session.input(".rav 斗殴, 闪避"))).toMatchObject({ ok: true });
  expect(await done(b, ada.session.input(".ri roll"))).toMatchObject({ ok: true });
  const [opposed, initiative] = diceData(ada).slice(-2);
  expect(opposed?.label).toBe("斗殴");
  expect(opposed?.text).toMatch(/^斗殴 \d+（[^）]+） 对 闪避 \d+（[^）]+）：/u);
  expect(initiative?.label).toBe("先攻");
  expect(ada.session.droppedFrames).toBe(0);
});

test("`me` marks the values the rule system derives; `usage` carries the Keeper model's context window and follows a model switch", async () => {
  const models = new ModelSettings({ llm: { preset: "openai", apiKey: "sk-env-roundtrip-0123456789", model: "no-such-model" }, lanes: {} }, new ServerSettings(openDatabase(":memory:")), {
    llm: (settings) => ({ client: new ScriptedLLM(() => "Reply"), contextWindow: settings.contextWindow }),
  });
  const b = setup({ models });
  const ada = await join(b, KEYS.ada);
  const root = await join(b, KEYS.root);
  await done(b, ada.session.viewSubscribe(["me", "usage"]));
  expect(await done(b, ada.session.input(".coc Alice"))).toMatchObject({ ok: true });
  const sheet = () => ada.session.view("me")?.data.character;
  const derivedKeys = (stats: readonly { key: string; derived?: true }[] | undefined) => (stats ?? []).filter((stat) => stat.derived === true).map((stat) => stat.key);
  expect(derivedKeys(sheet()?.attributes)).toEqual(["HPMAX", "MPMAX", "SANMAX", "IDEA", "KNOW"]);
  expect(derivedKeys(sheet()?.skills)).toEqual(["闪避", "母语"]);
  expect(sheet()?.attributes.find((stat) => stat.key === "STR")).not.toHaveProperty("derived");
  // A derived attribute cannot be set; a derived skill can, and then shows its own value.
  expect(await done(b, ada.session.runCommand("sheet", { op: "set", writes: [{ name: "HPMAX", op: "=", value: "20" }] }))).toMatchObject({ ok: false, error: { code: "sheet_write" } });
  expect(await done(b, ada.session.runCommand("sheet", { op: "set", writes: [{ name: "闪避", op: "=", value: "40" }] }))).toMatchObject({ ok: true });
  expect(sheet()?.skills.find((stat) => stat.key === "闪避")).toEqual({ key: "闪避", label: "Dodge", value: 40 });

  // A model the server does not know: its default window, said to be a default.
  expect(ada.session.view("usage")?.data).toEqual({ last: null, contextWindow: 32_000, contextWindowKnown: false });
  expect(await done(b, root.session.runCommand("model", { op: "set", provider: "openai", model: "gpt-5.5", contextWindow: 400_000 }))).toMatchObject({ ok: true });
  expect(ada.session.view("usage")?.data).toEqual({ last: null, contextWindow: 400_000 });
  expect(ada.session.droppedFrames).toBe(0);
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

// An import REPLACES the room: another log under another numbering. No event appended after
// the imported history can tell a connected client that (the first version appended a
// `reset`, which a client applies by clearing the very log it should load). The members'
// connections are ended instead, and each comes back as after any dropped link.
test("an import sends every member back to reconnect, and they come back holding the imported room", async () => {
  const b = setup({ media: true });
  const ada = await join(b, KEYS.ada);
  const root = await join(b, KEYS.root);
  await done(b, ada.session.input("one"));
  await done(b, ada.session.input("two"));
  // An undo leaves a `rewind` marker in the log: the save then carries a marker of this life.
  await done(b, root.session.runCommand("undo", {}));
  const saved = await done(b, root.session.runCommand("save", { op: "export" }));
  if (!saved.ok) throw new Error("export refused");
  const file = (saved.data as { media: { hash: string; size: number } }).media;
  const fetched = await done(b, root.get(file.hash));
  // The same room offers its own export back: the bytes are already there, nothing travels.
  const offered = await done(b, root.session.call("media.offer", { name: "room.json", mime: "application/json", size: file.size, sha256: createHash("sha256").update(fetched.body).digest("hex"), purpose: "save" }));
  expect(offered).toMatchObject({ ok: true, data: { existing: { hash: file.hash } } });
  const before = serverLog(b).length;
  expect(b.store.eventsAfter(ROOM, 0, 10_000).some((event) => event.kind === "rewind")).toBe(true);
  await done(b, ada.session.input("after the save"));

  // The admin who imports is answered first; then every member's link goes.
  expect(await done(b, root.session.runCommand("save", { op: "import", file: file.hash }))).toMatchObject({ ok: true });
  await settle(b);
  for (const player of [ada, root]) {
    expect(player.session.status).toBe("offline");
    expect(player.session.canRedial).toBe(true);
  }

  // The imported log: the saved events renumbered after everything this room ever handed
  // out, and WITHOUT the markers of its earlier life.
  const stored = b.store.eventsAfter(ROOM, 0, 10_000);
  expect(stored.some((event) => event.kind === "rewind" || event.kind === "reset")).toBe(false);
  expect(stored.length).toBe(before - 1);

  for (const player of [ada, root]) {
    player.connect();
    await settle(b);
    const snapshot = player.session.getSnapshot();
    expect(snapshot.status).toBe("online");
    expect(snapshot.events as unknown[]).toEqual(serverLog(b));
    // `head` is far above the number of events held; `first` is how the client knows it has them all.
    expect(snapshot.complete).toBe(true);
    expect(snapshot.welcome?.first).toBe(stored[0]?.seq);
  }
  expect(narratives(ada).map(([, text]) => text)).toEqual(["one", "Reply 1"]);
});

/** A room's content as `exportRoom` gives it, without what belongs to the room it lives in (event numbers are not in it). */
function content(b: RoomBench): unknown {
  const bundle = b.store.exportRoom(ROOM);
  return { turn: bundle.turn, documents: bundle.documents, state: bundle.state, modules: bundle.modules, events: bundle.events };
}

// A save no longer travels in a control-stream line: a room larger than `MAX_LINE_BYTES`
// goes out as a file fetched over the byte channel and comes back as an upload.
test("a save larger than a control-stream line goes out over the byte channel and comes back as an upload into another server, whole", async () => {
  const from = setup({ media: true });
  // Over 8 MiB of log: narratives each within what a client accepts of one text.
  const writer = from.store.beginTurn(ROOM);
  for (let index = 0; index < 48; index++) {
    const text = `${index}:${"灯".repeat(10)}${String(index % 10).repeat(180_000)}`;
    writer.appendEvent({ id: `big-${index}`, ts: 1_764_240_000_000 + index, kind: "narrative", turn: writer.turn, data: { speaker: "kp", text, format: "plain" } });
  }
  const root = await join(from, KEYS.root);
  const before = content(from);

  const saved = await done(from, root.session.runCommand("save", { op: "export" }));
  if (!saved.ok) throw new Error(saved.error.code);
  const file = (saved.data as { media: { hash: string; mime: string; size: number; name: string } }).media;
  expect(file.size).toBeGreaterThan(MAX_LINE_BYTES);
  expect(file.mime).toBe("application/json");
  // The answer is a reference, not the room: it fits a line with room to spare.
  expect(JSON.stringify(saved).length).toBeLessThan(2048);
  const fetched = await done(from, root.get(file.hash));
  expect(fetched.head).toMatchObject({ op: "get", ok: true, hash: file.hash, size: file.size, mime: "application/json" });
  expect(fetched.body.length).toBe(file.size);
  const sha256 = createHash("sha256").update(fetched.body).digest("hex");
  expect(sha256).toBe(file.hash);
  // A player on the same server cannot fetch it.
  const ada = await join(from, KEYS.ada);
  expect((await done(from, ada.get(file.hash))).head).toMatchObject({ ok: false, code: "media_not_found" });

  // Another server: the admin offers the file as a save, sends the bytes, and imports it.
  const to = setup({ media: true });
  const admin = await join(to, KEYS.root);
  const offered = await done(to, admin.session.call("media.offer", { name: file.name, mime: "application/json", size: fetched.body.length, sha256, purpose: "save" }));
  if (!offered.ok) throw new Error(offered.error.code);
  const uploadId = (offered.data as { upload_id: string }).upload_id;
  expect(await done(to, admin.put(uploadId, fetched.body))).toMatchObject({ op: "put", ok: true, hash: sha256, size: fetched.body.length, mime: "application/json" });
  // Nobody heard of the upload, and no player can fetch it.
  expect(admin.session.getSnapshot().events).toEqual([]);
  const bao = await join(to, KEYS.bao);
  expect((await done(to, bao.get(sha256))).head).toMatchObject({ ok: false, code: "media_not_found" });

  expect(await done(to, admin.session.runCommand("save", { op: "import", file: sha256 }))).toMatchObject({ ok: true, data: { turn: writer.turn } });
  await settle(to);
  expect(admin.session.status).toBe("offline");
  expect(content(to)).toEqual(before);
  // The upload was read and removed.
  expect(to.media?.find(ROOM, sha256, "admin")).toBeUndefined();

  // Back on the restored room, the client holds the server's log.
  admin.connect();
  await settle(to);
  expect(admin.session.status).toBe("online");
  expect(admin.session.getSnapshot().events as unknown[]).toEqual(serverLog(to));
  expect(admin.session.droppedFrames).toBe(0);
});

test("a member who connects in the middle of a turn is told one is running; the turn says busy once", async () => {
  const b = setup();
  const ada = await join(b, KEYS.ada);
  const hold = Promise.withResolvers<void>();
  b.keeper.next(async (call) => {
    await hold.promise;
    return reply(call, "at last");
  });
  const line = ada.session.input("a long one");
  // The turn is held, and with it the room's lock: wait on the clock, not on the room.
  await Bun.sleep(10);
  expect(ada.session.getSnapshot().turn).toMatchObject({ status: "busy", actor: "Ada" });

  const late = new Player(b, KEYS.bao);
  late.connect();
  await Bun.sleep(10);
  expect(late.session.getSnapshot().turn).toMatchObject({ status: "busy", actor: "Ada" });

  hold.resolve();
  await done(b, line);
  expect(late.session.getSnapshot().turn).toMatchObject({ status: "idle" });
  const busy = (ada.received[0] ?? []).filter((frame) => frame.type === "signal" && frame.kind === "turn" && frame.data.status === "busy");
  expect(busy.length).toBe(1);
});

test("audio: an admin uploads a sound for the library and plays it; a member who connects later finds it playing in the audio view; a player is refused both", async () => {
  const b = setup({ media: true });
  const root = await join(b, KEYS.root);
  const ada = await join(b, KEYS.ada);
  const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new TextEncoder().encode("harbor rain at night")]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const offer = { name: "Harbor Rain.ogg", mime: "audio/ogg", size: bytes.length, sha256, purpose: "audio" };

  // A player may neither upload to the library nor play it.
  expect(await done(b, ada.session.call("media.offer", offer))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await done(b, ada.session.input(".bgm play harbor"))).toMatchObject({ ok: false, error: { code: "forbidden" } });

  const offered = await done(b, root.session.call("media.offer", offer));
  if (!offered.ok) throw new Error(offered.error.code);
  const uploadId = (offered.data as { upload_id: string }).upload_id;
  expect(await done(b, root.put(uploadId, bytes))).toMatchObject({ op: "put", ok: true, hash: sha256, mime: "audio/ogg" });
  await done(b, root.session.viewSubscribe(["audio"]));
  expect(root.session.view("audio")?.data.library).toEqual([{ hash: sha256, mime: "audio/ogg", size: bytes.length, id: sha256, title: "Harbor Rain", layer: null, tags: [], source: { kind: "upload", id: null } }]);
  // No event announces a library upload.
  expect(ada.session.getSnapshot().events).toEqual([]);

  const signals: unknown[] = [];
  ada.session.onSignal((frame) => {
    if (frame.kind === "audio") signals.push(frame.data);
  });
  const played = await done(b, root.session.runCommand("bgm", { op: "play", query: "harbor", volume: 0.8 }));
  expect(played).toMatchObject({ ok: true, text: "BGM: playing Harbor Rain." });
  expect(signals).toEqual([{ id: expect.any(String), action: "play", layer: "bgm", sound: sha256, hash: sha256, mime: "audio/ogg", size: bytes.length, title: "Harbor Rain", loop: true, volume: 0.8 }]);

  // Bao connects after the signal went out: the view is how he learns what plays.
  const bao = await join(b, KEYS.bao);
  await done(b, bao.session.viewSubscribe(["audio"]));
  const seen = bao.session.view("audio")?.data;
  expect(seen?.playing).toEqual({ bgm: { id: sha256, title: "Harbor Rain", hash: sha256, mime: "audio/ogg", size: bytes.length, loop: true, volume: 0.8, paused: false } });
  // A player's library is what fetching needs, nothing that names a sound.
  expect(seen?.library).toEqual([{ hash: sha256, mime: "audio/ogg", size: bytes.length }]);
  expect(bao.session.droppedFrames).toBe(0);
  expect(ada.session.droppedFrames).toBe(0);
});

test("keys and the model from a client: an admin mints a key and a second client joins with it; revoked, its link ends and it cannot rejoin; a player gets no admin view and is refused the commands", async () => {
  const clients = new Map<string, ScriptedLLM>();
  const models = new ModelSettings({ llm: { preset: "openai", apiKey: "sk-env-roundtrip-0123456789", model: "gpt-5.5" }, lanes: {} }, new ServerSettings(openDatabase(":memory:")), {
    llm: (settings) => {
      const client = new ScriptedLLM(() => `from ${settings.preset ?? "?"}`);
      clients.set(settings.preset ?? "?", client);
      return { client };
    },
  });
  const b = setup({ models });
  const root = await join(b, KEYS.root);
  await done(b, root.session.viewSubscribe(["admin/keys", "admin/model"]));
  expect(root.session.view("admin/model")?.data.lanes[0]).toMatchObject({ lane: "keeper", provider: "openai", source: "environment" });

  const minted = await done(b, root.session.runCommand("key", { op: "mint", name: "Cleo" }));
  if (!minted.ok) throw new Error(minted.error.code);
  const { key, id } = minted.data as { key: string; id: string };
  const cleo = await join(b, key);
  expect(cleo.session.getSnapshot().welcome?.you).toMatchObject({ name: "Cleo", role: "player" });
  await settle(b);
  expect(root.session.view("admin/keys")?.data.keys.find((entry) => entry.id === id)).toMatchObject({ name: "Cleo", role: "player", online: true });

  // The model, switched over the wire with the key in a structured call: the answer masks it.
  const switched = await done(b, root.session.runCommand("model", { op: "set", provider: "deepseek", model: "deepseek-v4-pro", key: "sk-roundtrip-secret-0123456789" }));
  expect(switched).toMatchObject({ ok: true, data: { lane: { provider: "deepseek", key: { masked: "sk-r...6789" } } } });
  expect(root.session.view("admin/model")?.data.lanes[0]).toMatchObject({ provider: "deepseek", source: "override" });

  const revoked = await done(b, root.session.runCommand("key", { op: "revoke", id }));
  expect(revoked).toMatchObject({ ok: true, data: { id, revoked: true } });
  expect(cleo.session.status).toBe("offline");
  cleo.connect();
  await settle(b);
  expect(cleo.session.status).toBe("ended");
  expect(cleo.session.getSnapshot().lastError).toMatchObject({ code: "bad_key", fatal: true });
  expect(root.session.view("admin/keys")?.data.keys.map((entry) => entry.id)).not.toContain(id);

  const ada = await join(b, KEYS.ada);
  const subscribed = await done(b, ada.session.viewSubscribe(["admin/keys", "admin/model"]));
  expect(subscribed).toEqual({ ok: true, data: { problems: [{ name: "admin/keys", code: "unknown_view" }, { name: "admin/model", code: "unknown_view" }] } });
  expect(ada.session.view("admin/keys")).toBeNull();
  expect(ada.session.view("admin/model")).toBeNull();
  expect(await done(b, ada.session.runCommand("key", { op: "list" }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await done(b, ada.session.runCommand("model", { op: "set", provider: "openai", model: "gpt-5.5" }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await done(b, ada.session.input(".key mint admin Mallory"))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  // None of it went to the table, and nothing secret reached the player.
  expect(ada.session.getSnapshot().events).toEqual([]);
  const seenByAda = JSON.stringify(ada.received);
  for (const secret of [key, "sk-roundtrip-secret-0123456789", "sk-env-roundtrip-0123456789"]) expect(seenByAda).not.toContain(secret);
  expect(JSON.stringify(root.received)).not.toContain("sk-roundtrip-secret-0123456789");
  expect(ada.seqs()).toEqual(serverSeqs(b));
  expect(ada.session.droppedFrames).toBe(0);
  expect(root.session.droppedFrames).toBe(0);
});

test("the session report: a player asks for the page and fetches it over the byte channel; the reveal edition is the admin's, and its hash is no use to a player", async () => {
  const b = setup({ media: true });
  const root = await join(b, KEYS.root);
  const ada = await join(b, KEYS.ada);
  await done(b, ada.session.input("I light the lamp."));

  const asked = await done(b, ada.session.runCommand("report", { format: "html" }));
  if (!asked.ok) throw new Error(asked.error.code);
  const page = (asked.data as { edition: string; media: { hash: string; mime: string; size: number; name: string } }).media;
  expect(asked.data).toMatchObject({ format: "html", edition: "player", media: { mime: "text/html" } });
  const fetched = await done(b, ada.get(page.hash));
  expect(fetched.head).toMatchObject({ op: "get", ok: true, hash: page.hash, mime: "text/html", size: page.size });
  expect(createHash("sha256").update(fetched.body).digest("hex")).toBe(page.hash);
  expect(new TextDecoder().decode(fetched.body)).toContain("I light the lamp.");
  // Asking for the page tells the table nothing: no event beyond the line and its reply.
  expect(ada.session.getSnapshot().events.map((event) => event.kind)).toEqual(["narrative", "narrative"]);

  expect(await done(b, ada.session.runCommand("report", { format: "html", reveal: true }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  const revealed = await done(b, root.session.runCommand("report", { format: "html", reveal: true }));
  if (!revealed.ok) throw new Error(revealed.error.code);
  const secret = (revealed.data as { media: { hash: string } }).media.hash;
  expect((await done(b, root.get(secret))).head).toMatchObject({ ok: true, mime: "text/html" });
  expect((await done(b, ada.get(secret))).head).toMatchObject({ ok: false });
  expect(ada.session.droppedFrames).toBe(0);
});
