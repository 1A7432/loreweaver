// `pack install` from chat (decision 45): a room's admin installs a pack on the RUNNING
// server and it is enabled in that room at once — its module in the room's real worker on
// the next turn, its rule system selectable, its skills enabled, its panels in the view —
// while another room is untouched until it enables the pack. Fetched by path, https URL or
// `gh:` release through the injected fetch; the refusals; an upgrade reloading the rooms
// that have it enabled; the trust card in both languages; the one table line; and the room
// going on taking input while a slow fetch is in flight.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResultFrame, ServerFrame } from "loreweaver-protocol/v3";

import { dispatchTurnStart } from "../../src/agent/modules.ts";
import { readEnabledSkills } from "../../src/core/skills/index.ts";
import { builtInSkills, SkillRegistry } from "../../src/core/skills/index.ts";
import { ROOM_PACKS, ROOM_RULE_PACK } from "../../src/gateway/commands/index.ts";
import { RoomPacks } from "../../src/gateway/packs.ts";
import type { FetchLike } from "../../src/infra/packs/fetch.ts";
import { writeZip } from "../../src/infra/zip.ts";
import type { Wire } from "../helpers.ts";
import { BUNDLED_MODULE, manifestYaml, packEntries, text } from "../packs/fixture.ts";
import { events, gate, KEYS, resultFor, RoomBench, ROOM, views } from "./room_bench.ts";

const root = mkdtempSync(join(tmpdir(), "loreweaver-pack-install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fresh(name: string): string {
  counter += 1;
  return join(root, `${name}-${counter}`);
}

/** A pack archive's bytes (`replace` and `manifest` as `packEntries`). */
function archive(replace: Parameters<typeof packEntries>[0] = {}, manifest = manifestYaml({ panels: true })): Uint8Array {
  const entries = packEntries(replace, manifest);
  return writeZip([...entries].sort((a, b) => (a.path === "pack.yaml" ? -1 : b.path === "pack.yaml" ? 1 : a.path < b.path ? -1 : 1)));
}

function archiveFile(replace: Parameters<typeof packEntries>[0] = {}, manifest?: string): string {
  const file = `${fresh("archive")}.lwpack`;
  writeFileSync(file, archive(replace, manifest));
  return file;
}

const NO_FETCH: FetchLike = () => Promise.reject(new Error("no network in tests"));

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

function setup(fetch: FetchLike = NO_FETCH): RoomBench {
  const dataDir = fresh("data");
  const bench = new RoomBench({ media: true, packs: (media) => new RoomPacks({ packs: [], skills: new SkillRegistry(builtInSkills()), media, install: { dataDir, fetch } }) });
  bench.keystore.add("elsewhere-key", { room: "elsewhere", name: "Zed", role: "admin" });
  benches.push(bench);
  return bench;
}

function isResult(rid: string): (frame: ServerFrame) => boolean {
  return (frame) => frame.type === "result" && frame.rid === rid;
}

/** Send `text` and wait for its result — however long it takes (an install runs outside the lock). */
async function send(wire: Wire, rid: string, text: string): Promise<ResultFrame> {
  wire.receive({ type: "input", rid, text });
  return (await wire.until(isResult(rid))) as ResultFrame;
}

function turnStart(b: RoomBench, room = ROOM): ReturnType<typeof dispatchTurnStart> {
  return dispatchTurnStart(b.hub.moduleWorker(room), { turn: 1, seed: "s", text: "hello", who: { member: null, character: null }, variables: {}, clock: null });
}

function answerText(frame: ResultFrame): string {
  return frame.ok ? (frame.text ?? "") : "";
}

test("installed from a path: enabled here, its module in this room's worker, its rule system, skills and panels; another room untouched", async () => {
  const b = setup();
  const root = b.join(KEYS.root);
  // An admin of another room, watching the installed packs.
  const zed = b.join("elsewhere-key");
  zed.receive({ type: "call", rid: "sub", method: "view.subscribe", params: { names: ["packs"] } });
  await zed.until(isResult("sub"));
  expect(b.hub.moduleWorker(ROOM)).toBeNull();
  const done = await send(root, "i", `.pack install ${archiveFile()}`);
  expect(done).toMatchObject({ ok: true, data: { id: "harbor", version: "1.0.0", replaced: null, enabled: true, skillsEnabled: ["harbor-guide"], trust: { runsCode: true } } });
  const said = answerText(done);
  expect(said).toContain("Installed Harbor (harbor 1.0.0) on this server.");
  expect(said).toContain("It runs code on this server, with no sandbox: modules tally.");
  expect(said).toContain("harbor-rules (extends coc7)");
  expect(said).toContain("Its world card: .import world harbor cards/drowned.json");
  await b.settled();
  expect(b.store.stateGet(ROOM, ROOM_PACKS)).toEqual(["harbor"]);
  expect(readEnabledSkills(b.store, ROOM)).toEqual(["harbor-guide"]);
  // The module runs in this room's real worker on the next turn.
  expect((await turnStart(b)).injections).toEqual(["tally saw turn 1"]);
  // The rule system joined the running server's registry.
  expect(await send(root, "r", ".rule system harbor-rules")).toMatchObject({ ok: true });
  expect(b.store.stateGet(ROOM, ROOM_RULE_PACK)).toBe("harbor-rules");
  const skills = await send(root, "s", ".skill list");
  expect(((skills.ok ? (skills.data as { skills: { id: string; enabled: boolean }[] }) : { skills: [] }).skills).at(-1)).toMatchObject({ id: "harbor-guide", enabled: true });
  const panels = await send(root, "p", ".panels");
  expect((panels.ok ? (panels.data as { panels: { id: string }[] }) : { panels: [] }).panels.map((panel) => panel.id)).toEqual(["harbor/tide", "harbor/ledger", "harbor/chart", "harbor/notes"]);

  // Another room: installed on the server, not enabled there, no worker, until it enables it.
  await b.hub.room("elsewhere").settled();
  expect(views(zed.sent, "packs").at(-1)?.data).toMatchObject({ packs: [{ id: "harbor", enabled: false }] });
  expect(b.hub.moduleWorker("elsewhere")).toBeNull();
  expect(b.store.stateGet("elsewhere", ROOM_PACKS)).toBeNull();
  expect(await send(zed, "l", ".pack list")).toMatchObject({ ok: true, data: { packs: [{ id: "harbor", enabled: false }] } });
  expect(events(zed.sent).filter((event) => event.kind === "narrative")).toEqual([]);
  expect(await send(zed, "e", ".pack enable harbor")).toMatchObject({ ok: true });
  await b.hub.room("elsewhere").settled();
  expect((await turnStart(b, "elsewhere")).injections).toEqual(["tally saw turn 1"]);
});

test("the table hears one line, by name; the trust card is the caller's alone, in their language", async () => {
  const b = setup();
  const root = b.join(KEYS.root, { locale: "zh" });
  const ada = b.join(KEYS.ada);
  const done = await send(root, "i", `.pack install ${archiveFile()}`);
  const said = answerText(done);
  expect(said).toContain("已在服务器上安装 港口（harbor 1.0.0）。");
  expect(said).toContain("它会在这台服务器上运行代码，没有沙箱：模块 tally。");
  await b.settled();
  const lines = events(ada.sent).filter((event) => event.kind === "narrative");
  expect(lines.map((event) => event.data)).toEqual([{ speaker: "system", text: "Pack installed and enabled: Harbor.", format: "plain" }]);
  // Nobody else gets a result for the admin's request.
  expect(resultFor(ada.sent, "i")).toBeUndefined();
  // In English, from another admin connection, a pack with no modules says it runs no code.
  const english = b.join(KEYS.root);
  const quiet = manifestYaml({ id: "plain" }).replace("modules:\n  - { id: tally, entry: modules/tally.js }\n", "");
  const plain = await send(english, "q", `.pack install ${archiveFile({ "modules/tally.js": null }, quiet)}`);
  expect(answerText(plain)).toContain("It runs no code on this server (no modules).");
});

test("by an https URL and by a gh: release, through the injected fetch", async () => {
  const bytes = archive();
  const second = archive({ "modules/tally.js": null }, manifestYaml({ id: "harbor-gh" }).replace("modules:\n  - { id: tally, entry: modules/tally.js }\n", ""));
  const asked: string[] = [];
  const fetch: FetchLike = (url) => {
    asked.push(url);
    if (url === "https://packs.example.org/harbor.lwpack") return Promise.resolve(new Response(bytes));
    if (url === "https://api.github.com/repos/ada/harbor/releases/tags/v2") return Promise.resolve(Response.json({ assets: [{ name: "notes.md", browser_download_url: "https://x/notes.md" }, { name: "harbor-gh.lwpack", browser_download_url: "https://dl.example.org/harbor-gh.lwpack" }] }));
    if (url === "https://dl.example.org/harbor-gh.lwpack") return Promise.resolve(new Response(second));
    return Promise.resolve(new Response("", { status: 404 }));
  };
  const b = setup(fetch);
  const root = b.join(KEYS.root);
  expect(await send(root, "u", ".pack install https://packs.example.org/harbor.lwpack")).toMatchObject({ ok: true, data: { id: "harbor", enabled: true } });
  expect(await send(root, "g", ".pack install gh:ada/harbor@v2")).toMatchObject({ ok: true, data: { id: "harbor-gh", enabled: true } });
  expect(asked).toEqual(["https://packs.example.org/harbor.lwpack", "https://api.github.com/repos/ada/harbor/releases/tags/v2", "https://dl.example.org/harbor-gh.lwpack"]);
  await b.settled();
  expect(b.store.stateGet(ROOM, ROOM_PACKS)).toEqual(["harbor", "harbor-gh"]);
  // The structured call reaches the same command.
  root.receive({ type: "call", rid: "c", method: "command.run", params: { id: "pack", args: { op: "install", ref: "https://packs.example.org/missing.lwpack" } } });
  expect(await root.until(isResult("c"))).toMatchObject({ ok: false, error: { code: "fetch_failed" } });
});

test("refusals: a player, an invalid pack, an http URL, a version already installed; an id clash is installed and named as left out", async () => {
  let fetched = 0;
  const b = setup(() => {
    fetched += 1;
    return Promise.reject(new Error("offline"));
  });
  const root = b.join(KEYS.root);
  const ada = b.join(KEYS.ada);
  // A player is refused before anything is fetched.
  expect(await send(ada, "p", ".pack install https://packs.example.org/harbor.lwpack")).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(fetched).toBe(0);
  expect(await send(root, "h", ".pack install http://packs.example.org/harbor.lwpack")).toMatchObject({ ok: false, error: { code: "not_https" } });
  expect(fetched).toBe(0);
  expect(await send(root, "n", `.pack install ${fresh("nowhere")}.lwpack`)).toMatchObject({ ok: false, error: { code: "source_not_found" } });
  const invalid = await send(root, "v", `.pack install ${archiveFile({}, manifestYaml().replace("manifest_version: 3", "manifest_version: 2"))}`);
  expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_pack" } });
  expect(invalid.ok ? "" : invalid.error.message).toContain("manifest_version_unsupported");
  const notZip = `${fresh("bad")}.lwpack`;
  writeFileSync(notZip, "not a zip");
  expect(await send(root, "z", `.pack install ${notZip}`)).toMatchObject({ ok: false, error: { code: "bad_archive" } });
  expect(await send(root, "u", ".pack install")).toMatchObject({ ok: false, error: { code: "usage" } });
  const file = archiveFile();
  expect(await send(root, "i1", `.pack install ${file}`)).toMatchObject({ ok: true });
  expect(await send(root, "i2", `.pack install ${file}`)).toMatchObject({ ok: false, error: { code: "already_installed" } });
  // Nothing refused reached the table or the room's settings.
  await b.settled();
  expect(events(ada.sent).filter((event) => event.kind === "narrative")).toHaveLength(1);

  // A second pack claiming the same rule system and skill ids: installed, its own parts left out and named.
  const clash = manifestYaml({ id: "harbor-two" }).replace("modules:\n  - { id: tally, entry: modules/tally.js }\n", "");
  const two = await send(root, "c", `.pack install ${archiveFile({ "modules/tally.js": null }, clash)}`);
  expect(two).toMatchObject({ ok: true, data: { id: "harbor-two", enabled: true, skillsEnabled: [], shadowed: { ruleSystems: ["harbor-rules"], skills: ["harbor-guide"] } } });
  expect(answerText(two)).toContain("left out, an earlier one keeps the id: harbor-rules, harbor-guide");
  // The earlier claimant keeps the rule system.
  expect(b.packs?.ruleSystemRegistry.get("harbor-rules")).toBe(b.packs?.get("harbor")?.pack.ruleSystems[0]?.compiled ?? null);
});

test("a module id already enabled here: installed on the server, not enabled in this room, and said so", async () => {
  const b = setup();
  const root = b.join(KEYS.root);
  expect(await send(root, "a", `.pack install ${archiveFile()}`)).toMatchObject({ ok: true });
  const other = await send(root, "b", `.pack install ${archiveFile({}, manifestYaml({ id: "quiet" }))}`);
  expect(other).toMatchObject({ ok: true, data: { id: "quiet", enabled: false } });
  expect(answerText(other)).toContain("It is not enabled in this room: A pack enabled here already has a module called tally.");
  await b.settled();
  expect(b.store.stateGet(ROOM, ROOM_PACKS)).toEqual(["harbor"]);
  const lines = events(root.sent).filter((event) => event.kind === "narrative").map((event) => (event.data as { text: string }).text);
  expect(lines).toEqual(["Pack installed and enabled: Harbor.", "Pack installed: Harbor."]);
});

test("an upgrade of an enabled pack: the rooms that enabled it reload with the new version", async () => {
  const b = setup();
  const root = b.join(KEYS.root);
  expect(await send(root, "a", `.pack install ${archiveFile()}`)).toMatchObject({ ok: true });
  await b.settled();
  expect((await turnStart(b)).injections).toEqual(["tally saw turn 1"]);
  const before = b.hub.moduleWorker(ROOM);
  const v2 = archiveFile({ "modules/tally.js": text(BUNDLED_MODULE.replace("tally saw turn", "tally v2 saw turn")) }, manifestYaml({ version: "1.1.0", panels: true }));
  const upgraded = await send(root, "b", `.pack install ${v2}`);
  expect(upgraded).toMatchObject({ ok: true, data: { id: "harbor", version: "1.1.0", replaced: "1.0.0", enabled: true } });
  expect(answerText(upgraded)).toContain("in place of 1.0.0");
  await b.settled();
  const after = b.hub.moduleWorker(ROOM);
  expect(after).not.toBe(before);
  // The code is the new version's.
  expect((await turnStart(b)).injections).toEqual(["tally v2 saw turn 1"]);
  expect(b.packs?.get("harbor")?.pack.manifest.version).toBe("1.1.0");
  expect(b.store.stateGet(ROOM, ROOM_PACKS)).toEqual(["harbor"]);
});

test("a slow fetch holds up nothing: the room goes on taking commands and speech meanwhile", async () => {
  const slow = gate();
  const bytes = archive();
  const b = setup(async () => {
    await slow.promise;
    return new Response(bytes);
  });
  const root = b.join(KEYS.root);
  const ada = b.join(KEYS.ada);
  root.receive({ type: "input", rid: "i", text: ".pack install https://packs.example.org/harbor.lwpack" });
  // A command and a line of speech, both answered while the fetch is still in flight.
  expect(await send(ada, "r", ".r 1d6")).toMatchObject({ ok: true });
  expect(await send(ada, "s", "I walk to the quay.")).toMatchObject({ ok: true });
  await b.settled();
  expect(b.keeper.calls).toHaveLength(1);
  expect(resultFor(root.sent, "i")).toBeUndefined();
  slow.open();
  expect(await root.until(isResult("i"))).toMatchObject({ ok: true, data: { id: "harbor", enabled: true } });
  await b.settled();
  expect((await turnStart(b)).injections).toEqual(["tally saw turn 1"]);
});
