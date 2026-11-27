// Seating a member on a module's character (`fx.seat`), through a real room, a real worker
// and the `colony` sample module: the views, undo and `reset chars`, every refusal, `pc
// release` and `pc claim`, the sheet and check commands, and a module of another id that can
// neither seat on nor unseat from `colony`'s characters. And a command that runs in steps.
import { afterEach, expect, test } from "bun:test";

import type { ServerFrame } from "loreweaver-protocol/v3";

import { readSeating, SEATING_ID, SEATING_TYPE } from "../../src/core/characters/index.ts";
import type { Wire } from "../helpers.ts";
import { events, KEYS, resultFor, RoomBench, ROOM, views } from "./room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

function setup(onPost?: (op: string) => void): RoomBench {
  const bench = new RoomBench({ modules: ["colony", "rival"], ...(onPost === undefined ? {} : { onPost }) });
  benches.push(bench);
  return bench;
}

let rids = 0;

async function send(b: RoomBench, wire: Wire, text: string): Promise<Record<string, unknown>> {
  const rid = `r${++rids}`;
  wire.receive({ type: "input", rid, text });
  await b.settled();
  return (resultFor(wire.sent, rid) ?? {}) as Record<string, unknown>;
}

async function run(b: RoomBench, wire: Wire, id: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const rid = `r${++rids}`;
  wire.receive({ type: "call", rid, method: "command.run", params: { id, args } });
  await b.settled();
  return (resultFor(wire.sent, rid) ?? {}) as Record<string, unknown>;
}

async function watch(b: RoomBench, wire: Wire, ...names: string[]): Promise<void> {
  wire.receive({ type: "call", rid: `w${++rids}`, method: "view.subscribe", params: { names } });
  await b.settled();
}

function latest(frames: readonly ServerFrame[], name: string): Record<string, unknown> {
  return (views(frames, name).at(-1)?.data ?? {}) as Record<string, unknown>;
}

function memberId(wire: Wire): string {
  return String((latest(wire.sent, "me").member as { id: string }).id);
}

function seats(b: RoomBench): readonly { member: string; character: string }[] {
  const document = b.store.docGet(ROOM, SEATING_TYPE, SEATING_ID);
  return document === null ? [] : (readSeating(JSON.parse(document.data) as Record<string, never>)?.seats ?? []);
}

const ANA = { id: "colony:ana", name: "Ana", pack: "", status: [], resources: [{ id: "hp", label: "HP", value: 5, max: 5 }, { id: "food", label: "Food", value: 0 }], module: "colony" };

test("a member runs the module's command and is seated: me, party and characters show the character and its resources, to them and to another member", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  const bao = b.join(KEYS.bao);
  await watch(b, ada, "me", "party", "characters");
  await watch(b, bao, "me", "party", "characters");
  // Before anyone is seated, every character the modules offer is on the `characters` view, by its namespaced id.
  expect((latest(bao.sent, "characters").claimable as { id: string; source: unknown; player: unknown }[]).map((entry) => [entry.id, entry.source, entry.player])).toEqual([
    ["colony:ana", { kind: "module", id: "colony" }, null],
    ["colony:bo", { kind: "module", id: "colony" }, null],
    ["colony:cy", { kind: "module", id: "colony" }, null],
    ["rival:ana", { kind: "module", id: "rival" }, null],
  ]);

  expect(await send(b, ada, ".join ana")).toMatchObject({ ok: true, text: "joined" });
  const adaId = memberId(ada);
  expect(latest(ada.sent, "me").character).toEqual({ ...ANA, attributes: [], skills: [] });
  // Another member's views: the party lists the seated module character with its player.
  const party = latest(bao.sent, "party");
  expect(party.characters).toEqual([{ ...ANA, player: { id: adaId, name: "Ada" } }]);
  expect((party.members as { id: string; character: string | null }[]).find((member) => member.id === adaId)?.character).toBe("colony:ana");
  expect((latest(bao.sent, "characters").claimable as { id: string; player: unknown }[]).find((entry) => entry.id === "colony:ana")?.player).toEqual({ id: adaId, name: "Ada" });
  expect(latest(bao.sent, "me").character).toBeNull();

  // The module sees its own id; another module sees the namespaced one.
  expect(await run(b, ada, "colony/whoami")).toMatchObject({ ok: true, data: { id: "ana", name: "Ana" } });
  expect(await run(b, ada, "rival/whoami")).toMatchObject({ ok: true, data: { id: "colony:ana", name: "Ana" } });

  // A resource the module changes reaches the panels after the command.
  await run(b, bao, "colony/hurt", { settler: "ana" });
  expect((latest(ada.sent, "me").character as { resources: unknown[] }).resources[0]).toEqual({ id: "hp", label: "HP", value: 4, max: 5 });

  // A character the module no longer offers stays seated, shown by its id, until the module unseats it.
  await run(b, bao, "colony/die", { settler: "ana" });
  expect(latest(ada.sent, "me").character).toEqual({ id: "colony:ana", name: "colony:ana", pack: "", status: [], resources: [], attributes: [], skills: [], module: "colony" });
  expect(seats(b).map((seat) => seat.character)).toEqual(["colony:ana"]);
  // Death and replacement are the module's to say: it unseats, then seats the new one.
  expect(await run(b, ada, "colony/leave")).toMatchObject({ ok: true });
  expect(await run(b, ada, "colony/join", { settler: "bo" })).toMatchObject({ ok: true });
  expect((latest(ada.sent, "me").character as { id: string; name: string }).name).toBe("Bo");
});

test("the seat is undone with the turn it was written in, and cleared by reset chars", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  const root = b.join(KEYS.root);
  await watch(b, ada, "me");
  await send(b, ada, "I look around the camp.");
  expect(await send(b, ada, ".join cy")).toMatchObject({ ok: true });
  expect(seats(b).map((seat) => seat.character)).toEqual(["colony:cy"]);
  expect(await send(b, root, ".undo")).toMatchObject({ ok: true });
  expect(seats(b)).toEqual([]);
  expect(latest(ada.sent, "me").character).toBeNull();

  expect(await send(b, ada, ".join cy")).toMatchObject({ ok: true });
  expect(seats(b).map((seat) => seat.character)).toEqual(["colony:cy"]);
  await send(b, root, ".reset chars");
  expect(await send(b, root, ".reset chars confirm")).toMatchObject({ ok: true });
  expect(seats(b)).toEqual([]);
});

test("every refusal of fx.seat is a problem with its code and changes nothing", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  const bao = b.join(KEYS.bao);
  const root = b.join(KEYS.root);
  const eve = b.join(KEYS.eve);
  for (const wire of [ada, bao, root, eve]) await watch(b, wire, "me");
  const [adaId, baoId, rootId, eveId] = [ada, bao, root, eve].map(memberId) as [string, string, string, string];
  // Bao plays an engine character: never displaced.
  expect(await send(b, bao, ".coc Bram")).toMatchObject({ ok: true });
  const engineSeat = seats(b).find((seat) => seat.member === baoId)?.character;
  expect(engineSeat).toMatch(/^ch-/u);
  await run(b, ada, "colony/join", { settler: "ana" });

  const reported = (code: string): number => b.reports.filter((line) => line.includes(`module command colony/seat: ${code}`)).length;
  await run(b, root, "colony/seat", { member: "nobody-at-all", character: "bo" });
  expect(reported("not_member")).toBe(1);
  await run(b, root, "colony/seat", { member: baoId, character: "bo" });
  expect(reported("member_has_character")).toBe(1);
  await run(b, root, "colony/seat", { member: rootId, character: "zed" });
  expect(reported("unknown_character")).toBe(1);
  await run(b, root, "colony/seat", { member: rootId, character: "ana" });
  expect(reported("character_taken")).toBe(1);
  // Unseating someone who holds none of the module's characters is no change and no problem.
  await run(b, root, "colony/seat", { member: eveId, character: null });
  await run(b, root, "colony/seat", { member: baoId, character: null });
  expect(b.reports.filter((line) => line.includes("module command colony/seat:"))).toHaveLength(4);
  expect(seats(b).map((seat) => [seat.member, seat.character])).toEqual([
    [baoId, String(engineSeat)],
    [adaId, "colony:ana"],
  ]);
});

test("a module of another id can neither seat on nor unseat from colony's characters", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  const root = b.join(KEYS.root);
  await watch(b, ada, "me");
  const adaId = memberId(ada);
  await run(b, ada, "colony/join", { settler: "ana" });
  // `rival` names `colony`'s character: it is not one rival offers.
  await run(b, root, "rival/grab", { member: adaId, character: "colony:ana" });
  expect(b.reports.some((line) => line.includes("module command rival/grab: unknown_character"))).toBe(true);
  // Its own `ana` is another character, and Ada holds one that is not rival's: never displaced.
  await run(b, root, "rival/grab", { member: adaId, character: "ana" });
  expect(b.reports.some((line) => line.includes("module command rival/grab: member_has_character"))).toBe(true);
  // Unseating her from a character that is not its own changes nothing.
  await run(b, root, "rival/drop", { member: adaId });
  expect(seats(b).map((seat) => seat.character)).toEqual(["colony:ana"]);
  expect((latest(ada.sent, "me").character as { id: string }).id).toBe("colony:ana");
});

test("pc release stands a member up from a module's character, and the module sees nobody; pc claim of one is refused", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  await watch(b, ada, "me");
  await run(b, ada, "colony/join", { settler: "bo" });
  // Claiming a module's character, by its id or its name: the module seats, the engine does not.
  for (const text of [".pc claim colony:cy", ".pc claim Cy"]) {
    expect(await send(b, ada, text)).toMatchObject({ ok: false, error: { code: "module_character", message: expect.stringContaining("colony") } });
  }
  const listed = await send(b, ada, ".pc");
  expect(String(listed.text)).toContain("Bo");
  expect(String(listed.text)).toContain("colony");
  const released = await send(b, ada, ".pc release");
  expect(released).toMatchObject({ ok: true });
  expect(events(ada.sent).at(-1)?.data).toMatchObject({ speaker: "system", text: "Bo is free to claim again." });
  expect(latest(ada.sent, "me").character).toBeNull();
  expect(seats(b)).toEqual([]);
  const seen = await run(b, ada, "colony/whoami");
  expect(seen).toMatchObject({ ok: true });
  expect(seen.data).toBeUndefined();
});

test("a sheet command and a check refuse a member on a module's character with one code; a check that needs no sheet still rolls", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  await watch(b, ada, "me");
  await run(b, ada, "colony/join", { settler: "ana" });
  for (const text of [".st", ".st HP=3", ".ra Spot Hidden", ".sc 1/1d6", ".init roll", ".nn Anna"]) {
    expect(await send(b, ada, text)).toMatchObject({ ok: false, error: { code: "no_sheet", message: expect.stringContaining("colony") } });
  }
  // A check that needs no sheet still rolls.
  expect(await send(b, ada, ".ra 50")).toMatchObject({ ok: true });
  expect(seats(b).map((seat) => seat.character)).toEqual(["colony:ana"]);
});

test("a command that needs three steps: each step's effects applied as it completes, one answer, the views rendered once", async () => {
  const posts: string[] = [];
  const b = setup((op) => posts.push(op));
  const ada = b.join(KEYS.ada);
  const bao = b.join(KEYS.bao);
  await watch(b, ada, "me");
  await run(b, ada, "colony/join", { settler: "ana" });
  posts.length = 0;
  const answer = await run(b, ada, "colony/advance", { years: 3 });
  expect(answer).toMatchObject({ ok: true, text: "year 3", data: { steps: 3, data: { years: 3 } } });
  expect((answer.data as Record<string, unknown>).stopped).toBeUndefined();
  // Three calls into the worker, then one render.
  expect(posts.filter((op) => op === "command")).toHaveLength(3);
  expect(posts.filter((op) => op === "render")).toHaveLength(1);
  // The table got every step's events, in order: three dice, three facts.
  const table = events(bao.sent).filter((event) => event.kind === "narrative" && event.data.speaker === "system").map((event) => (event.data as { text: string }).text);
  expect(table.slice(-3)).toEqual(["year 1", "year 2", "year 3"]);
  expect(events(bao.sent).filter((event) => event.kind === "dice")).toHaveLength(3);
  expect(b.store.moduleStates(ROOM).get("colony")).toMatchObject({ years: 3 });
  expect((latest(ada.sent, "me").character as { resources: { value: number }[] }).resources[1]?.value).toBe(3);

  // A command that never ends by itself stops at the step limit, and says so.
  const forever = await run(b, ada, "colony/forever");
  expect(forever).toMatchObject({ ok: true, data: { steps: 8, data: null, stopped: "steps" } });
  expect(String(forever.text)).toContain("Stopped after step 8");

  // A step that throws after two good ones: the two stand, the caller is told.
  const failing = await run(b, ada, "colony/advance", { years: 5, fail_at: 2 });
  expect(failing).toMatchObject({ ok: true, data: { steps: 2, data: { years: 13 }, stopped: "failed" } });
  expect(b.store.moduleStates(ROOM).get("colony")).toMatchObject({ years: 13 });
  // A command whose first call fails changed nothing.
  expect(await run(b, ada, "colony/advance", { years: 2, fail_at: 0 })).toMatchObject({ ok: false, error: { code: "command_failed" } });
  expect(b.store.moduleStates(ROOM).get("colony")).toMatchObject({ years: 13 });
});
