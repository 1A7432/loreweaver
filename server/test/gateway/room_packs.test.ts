// Packs in a room: enabling makes the pack's module load in the room's real worker (and
// disabling unloads it), its kit part of the room's kit with its pictures and sounds served
// over the byte channel to that room only, its skills enableable and its cards importable;
// the setting survives `reset all`; the `packs` view and `pack list` per role.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeByteReply, encodeByteLine, PACKS_VIEW_SCHEMA } from "loreweaver-protocol/v3";

import { dispatchTurnStart } from "../../src/agent/modules.ts";
import { installPack, loadInstalledPacks } from "../../src/cli/packs.ts";
import { readEnabledSkills } from "../../src/core/skills/index.ts";
import { ROOM_PACKS } from "../../src/gateway/commands/index.ts";
import { assemblePacks, type LoadedPack, RoomPacks } from "../../src/gateway/packs.ts";
import { ByteChannel, type ByteSink, type ByteSource } from "../../src/net/bytes.ts";
import { writeZip } from "../../src/infra/zip.ts";
import { manifestYaml, packEntries, PNG_BYTES, text } from "../packs/fixture.ts";
import { KEYS, resultFor, RoomBench, ROOM, views } from "./room_bench.ts";
import { schemaProblems } from "./views/schema_check.ts";

const dir = mkdtempSync(join(tmpdir(), "loreweaver-room-packs-"));
let installed: readonly LoadedPack[] = [];
/** Packs whose modules declare text forms, installed apart so the other tests see the two above only. */
let withForms: readonly LoadedPack[] = [];

beforeAll(async () => {
  const dataDir = join(dir, "data");
  for (const manifest of [manifestYaml(), manifestYaml({ id: "quiet" })]) {
    const file = join(dir, `${manifest.includes("id: quiet") ? "quiet" : "harbor"}.lwpack`);
    const entries = packEntries({}, manifest);
    writeFileSync(file, writeZip(entries.sort((a, b) => (a.path === "pack.yaml" ? -1 : b.path === "pack.yaml" ? 1 : a.path < b.path ? -1 : 1))));
    const outcome = await installPack(dataDir, file, { yes: true, fetch: () => Promise.reject(new Error("offline")) });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  }
  // Two packs whose modules declare text forms: `roll` is the engine's word, `shout` both claim.
  for (const [id, forms] of [
    ["crier", '["roll {text...}", "shout {text...}", "cry {text...}"]'],
    ["herald", '["shout {text...}"]'],
  ] as const) {
    const module = `import { defineModule } from "loreweaver/module";
let voice = "";
export default defineModule({
  id: "${id}",
  create(init) { voice = String(init.options.voice); },
  load(_snapshot, init) { voice = String(init.options.voice); },
  commands: { call: { title: "Call", params: { type: "object", properties: { text: { type: "string" } } }, text: ${forms}, run: (args) => ({ text: "${id} (" + voice + "): " + String(args.text) }) } },
});
`;
    const manifest = manifestYaml({ id }).replace("{ id: tally, entry: modules/tally.js }", `{ id: ${id}, entry: modules/tally.js, options: { voice: loud } }`);
    const file = join(dir, `${id}.lwpack`);
    const entries = packEntries({ "modules/tally.js": text(module) }, manifest);
    writeFileSync(file, writeZip(entries.sort((a, b) => (a.path === "pack.yaml" ? -1 : b.path === "pack.yaml" ? 1 : a.path < b.path ? -1 : 1))));
    const outcome = await installPack(join(dir, "forms-data"), file, { yes: true, fetch: () => Promise.reject(new Error("offline")) });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  }
  installed = loadInstalledPacks(dataDir).packs;
  withForms = loadInstalledPacks(join(dir, "forms-data")).packs;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

function setup(packs: readonly LoadedPack[] = installed): RoomBench {
  const bench = new RoomBench({ media: true, packs: (media) => new RoomPacks({ packs, skills: assemblePacks(packs).skills, media }) });
  benches.push(bench);
  return bench;
}

async function say(b: RoomBench, key: string, rid: string, text: string): Promise<Record<string, unknown>> {
  const wire = b.join(key);
  wire.receive({ type: "input", rid, text });
  await b.settled();
  return (resultFor(wire.sent, rid) ?? {}) as Record<string, unknown>;
}

/** Ask for `hash` over the byte channel as the member `key` connects as. */
async function get(b: RoomBench, key: string, hash: string): Promise<unknown> {
  const wire = b.join(key);
  const access = wire.session.byteAccess();
  const queue = [encodeByteLine({ op: "get", hash })];
  const out: Uint8Array[] = [];
  const source: ByteSource = { read: () => Promise.resolve(queue.shift() ?? null), stop: () => undefined };
  const sink: ByteSink = {
    write: (bytes) => {
      out.push(bytes.slice());
      return Promise.resolve();
    },
    finish: () => Promise.resolve(),
  };
  await new ByteChannel(() => access, () => "en").serve(source, sink);
  const all = Buffer.concat(out);
  const newline = all.indexOf(0x0a);
  return { reply: decodeByteReply(JSON.parse(all.subarray(0, newline).toString("utf8"))), body: all.subarray(newline + 1) };
}

function turnStart(b: RoomBench): ReturnType<typeof dispatchTurnStart> {
  return dispatchTurnStart(b.hub.moduleWorker(ROOM), { turn: 1, seed: "s", text: "hello", who: { member: null, character: null }, variables: {}, clock: null, members: [] });
}

test("enabling names the pack's text forms the room does not take: the room's own words and a word two modules claim", async () => {
  const b = setup(withForms);
  const crier = await say(b, KEYS.root, "c", ".pack enable crier");
  expect(crier).toMatchObject({ ok: true });
  expect(String(crier.text)).toContain(".roll {text...} of crier/call");
  expect(String(crier.text)).not.toContain(".shout");
  // The manifest's options reached the module's `create` as `init.options`.
  expect(await say(b, KEYS.ada, "cry", ".cry hear ye")).toMatchObject({ ok: true, text: "crier (loud): hear ye" });
  expect(await say(b, KEYS.ada, "s1", ".shout hear ye")).toMatchObject({ ok: true, text: "crier (loud): hear ye" });
  const herald = await say(b, KEYS.root, "h", ".pack enable herald");
  expect(String(herald.text)).toContain(".shout {text...} of herald/call");
  // The shared word is dropped for both: a line of speech now, not a command.
  expect(await say(b, KEYS.ada, "s2", ".shout hear ye")).toEqual({ type: "result", rid: "s2", ok: true });
  expect(b.reports.filter((line) => line.includes("word_shared"))).toHaveLength(2);
  expect(b.reports.filter((line) => line.includes("word_taken"))).toHaveLength(1);
});

test("enabling loads the pack's module in the room's worker; disabling unloads it", async () => {
  const b = setup();
  expect(b.hub.moduleWorker(ROOM)).toBeNull();
  expect(await say(b, KEYS.ada, "p", ".pack enable harbor")).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await say(b, KEYS.root, "e", ".pack enable harbor")).toMatchObject({ ok: true });
  expect(b.store.stateGet(ROOM, ROOM_PACKS)).toEqual(["harbor"]);
  const started = await turnStart(b);
  expect(started.injections).toEqual(["tally saw turn 1"]);
  expect(b.hub.moduleWorker(ROOM)?.loaded).toEqual(["tally"]);
  // A second pack with a module of the same id cannot join that worker.
  expect(await say(b, KEYS.root, "q", ".pack enable quiet")).toMatchObject({ ok: false, error: { code: "module_id_taken" } });
  expect(await say(b, KEYS.root, "d", ".pack disable harbor")).toMatchObject({ ok: true });
  expect(b.hub.moduleWorker(ROOM)).toBeNull();
  expect((await turnStart(b)).injections).toEqual([]);
  // Back on: a fresh worker with the module again.
  expect(await say(b, KEYS.root, "e2", ".pack enable harbor")).toMatchObject({ ok: true });
  expect((await turnStart(b)).injections).toHaveLength(1);
  expect(await say(b, KEYS.root, "x", ".pack enable nothing")).toMatchObject({ ok: false, error: { code: "unknown_pack" } });
});

test("the kit merges into the room's kit, and its pictures are served to that room and no other", async () => {
  const b = setup();
  b.keystore.add("elsewhere-key", { room: "elsewhere", name: "Zed", role: "admin" });
  expect(b.packs?.kitFor(b.store, ROOM, "en")).toBeNull();
  await say(b, KEYS.root, "e", ".pack enable harbor");
  const kit = b.packs?.kitFor(b.store, ROOM, "en");
  const quay = kit?.subjects.find((subject) => subject.id === "quay");
  expect(kit?.style).toEqual(["ink wash"]);
  expect(quay?.reference?.mime).toBe("image/png");
  expect(kit?.cues.map((cue) => cue.id)).toEqual(["bell"]);
  const hash = quay?.reference?.hash ?? "";
  // Unlisted: fetchable by a member of the room, never in its listing.
  expect(b.media?.list(ROOM)).toEqual([]);
  const fetched = (await get(b, KEYS.ada, hash)) as { reply: { ok: boolean }; body: Buffer };
  expect(fetched.reply).toMatchObject({ ok: true, hash, mime: "image/png" });
  expect(Buffer.from(PNG_BYTES).equals(fetched.body)).toBe(true);
  const sound = kit?.cues[0]?.asset.hash ?? "";
  expect(((await get(b, KEYS.bao, sound)) as { reply: unknown }).reply).toMatchObject({ ok: true, mime: "audio/ogg" });
  // Another room: the same answer as a hash nobody holds.
  const elsewhere = (await get(b, "elsewhere-key", hash)) as { reply: unknown };
  const nobody = (await get(b, "elsewhere-key", "f".repeat(64))) as { reply: unknown };
  expect(elsewhere.reply).toMatchObject({ ok: false, code: "media_not_found" });
  expect(elsewhere.reply).toEqual(nobody.reply);
});

test("the pack's skills appear to `skill list`, can be enabled, and go when the pack goes", async () => {
  const b = setup();
  const before = await say(b, KEYS.root, "l0", ".skill list");
  expect(((before.data as { skills: { id: string }[] }).skills).map((skill) => skill.id)).toEqual(["mature-mode", "romance-relationships", "image-gen"]);
  expect(await say(b, KEYS.root, "s0", ".skill enable harbor-guide")).toMatchObject({ ok: false, error: { code: "skill_not_available" } });
  await say(b, KEYS.root, "e", ".pack enable harbor");
  const after = await say(b, KEYS.root, "l1", ".skill list");
  expect(((after.data as { skills: { id: string; pack: string | null }[] }).skills).at(-1)).toMatchObject({ id: "harbor-guide", pack: "harbor", tools: ["generate_image"], enabled: false });
  expect(await say(b, KEYS.ada, "s1", ".skill enable harbor-guide")).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await say(b, KEYS.root, "s2", ".skill enable harbor-guide")).toMatchObject({ ok: true });
  expect(await say(b, KEYS.root, "s3", ".skill enable mature-mode")).toMatchObject({ ok: true });
  expect(readEnabledSkills(b.store, ROOM)).toEqual(["harbor-guide", "mature-mode"]);
  expect(await say(b, KEYS.root, "d", ".pack disable harbor")).toMatchObject({ ok: true, data: { skillsDisabled: ["harbor-guide"] } });
  expect(readEnabledSkills(b.store, ROOM)).toEqual(["mature-mode"]);
});

test("the pack's cards import: a character by a player, the world by the admin only", async () => {
  const b = setup();
  expect(await say(b, KEYS.ada, "c0", ".import character harbor cards/sailor.json")).toMatchObject({ ok: false, error: { code: "pack_not_enabled" } });
  await say(b, KEYS.root, "e", ".pack enable harbor");
  expect(await say(b, KEYS.ada, "c1", ".import character harbor cards/sailor.json Mara the Bold")).toMatchObject({ ok: true, data: { name: "Mara the Bold" } });
  expect(await say(b, KEYS.ada, "c2", ".import character harbor cards/none.json")).toMatchObject({ ok: false, error: { code: "card_not_in_pack" } });
  expect(await say(b, KEYS.bao, "w0", ".import world harbor cards/drowned.json")).toMatchObject({ ok: false, error: { code: "forbidden" } });
  const wire = b.join(KEYS.root);
  wire.receive({ type: "call", rid: "w1", method: "command.run", params: { id: "import", args: { pack: "harbor", card: "cards/drowned.json", as: "world" } } });
  await b.settled();
  expect(resultFor(wire.sent, "w1")).toMatchObject({ ok: true, data: { name: "Drowned City" } });
});

test("the enabled packs are a room setting: they survive `reset all`", async () => {
  const b = setup();
  await say(b, KEYS.root, "e", ".pack enable harbor");
  expect(await say(b, KEYS.root, "r1", ".reset all")).toMatchObject({ ok: true });
  expect(await say(b, KEYS.root, "r2", ".reset all confirm")).toMatchObject({ ok: true });
  expect(b.store.stateGet(ROOM, ROOM_PACKS)).toEqual(["harbor"]);
  expect((await turnStart(b)).injections).toEqual(["tally saw turn 1"]);
});

test("the packs view and `pack list`: the admin sees every installed pack, a player the room's, by name", async () => {
  const b = setup();
  const root = b.join(KEYS.root);
  const ada = b.join(KEYS.ada);
  for (const wire of [root, ada]) wire.receive({ type: "call", rid: "sub", method: "view.subscribe", params: { names: ["packs"] } });
  await b.settled();
  expect(views(root.sent, "packs").at(-1)?.data).toEqual({
    packs: [
      {
        id: "harbor",
        version: "1.0.0",
        name: "Harbor",
        enabled: false,
        cards: [
          { file: "cards/drowned.json", name: "Drowned City", kind: "world" },
          { file: "cards/sailor.json", name: "Mara", kind: "character" },
        ],
      },
      { id: "quiet", version: "1.0.0", name: "Harbor", enabled: false, cards: expect.any(Array) },
    ],
  });
  expect(views(ada.sent, "packs").at(-1)?.data).toEqual({ packs: [] });
  root.receive({ type: "input", rid: "e", text: ".pack enable harbor" });
  await b.settled();
  expect((views(ada.sent, "packs").at(-1)?.data as { packs: { id: string; enabled: boolean }[] }).packs.map((pack) => [pack.id, pack.enabled])).toEqual([["harbor", true]]);
  ada.receive({ type: "input", rid: "l", text: ".pack" });
  root.receive({ type: "input", rid: "l", text: ".pack list" });
  await b.settled();
  expect(resultFor(ada.sent, "l")).toMatchObject({ ok: true, data: { packs: [{ id: "harbor", name: "Harbor" }] } });
  const listed = resultFor(ada.sent, "l");
  expect(Object.keys((listed?.ok === true ? (listed.data as { packs: Record<string, unknown>[] }) : { packs: [] }).packs[0] ?? {})).toEqual(["id", "name"]);
  const admin = resultFor(root.sent, "l");
  expect(admin).toMatchObject({ ok: true, data: { packs: [{ id: "harbor", enabled: true, modules: ["tally"], ruleSystems: ["harbor-rules"], skills: ["harbor-guide"], presentation: true, assets: 3, shadowed: [] }, { id: "quiet", shadowed: ["harbor-rules", "harbor-guide"] }] } });
  expect(admin?.type === "result" && admin.ok ? admin.text : "").toContain("Harbor (harbor 1.0.0) — enabled here");
  // The view's shape is the protocol's.
  expect(schemaProblems(PACKS_VIEW_SCHEMA, views(root.sent, "packs").at(-1)?.data)).toEqual([]);
});
