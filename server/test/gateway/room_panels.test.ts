// Panels in a room: a pack with template and page panels built, installed and enabled; the
// `panels` view per role; each page's HTML served over the byte channel to that room's members
// (an admin-only page to its admins) and to nobody else; the per-panel switch, a room setting
// that survives `reset all`.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeByteReply, encodeByteLine, PANELS_VIEW_SCHEMA, type PanelsView } from "loreweaver-protocol/v3";

import { buildPack, installPack, loadInstalledPacks } from "../../src/cli/packs.ts";
import { ROOM_PANELS_OFF } from "../../src/gateway/commands/index.ts";
import { assemblePacks, type LoadedPack, RoomPacks } from "../../src/gateway/packs.ts";
import { ByteChannel, type ByteSink, type ByteSource } from "../../src/net/bytes.ts";
import { manifestYaml, NOTES_HTML, PAGE_HTML, writeSourceTree } from "../packs/fixture.ts";
import { KEYS, resultFor, RoomBench, ROOM, views } from "./room_bench.ts";
import { schemaProblems } from "./views/schema_check.ts";

const dir = mkdtempSync(join(tmpdir(), "loreweaver-room-panels-"));
let installed: readonly LoadedPack[] = [];

beforeAll(async () => {
  // Built from a source tree, as an author would, then installed.
  const source = join(dir, "source");
  writeSourceTree(source, { manifest: manifestYaml({ entry: "src/tally.ts", panels: true }) });
  const built = await buildPack(source, { out: join(dir, "harbor.lwpack") });
  if (!built.ok) throw new Error(JSON.stringify(built));
  const dataDir = join(dir, "data");
  const outcome = await installPack(dataDir, built.out, { yes: true, fetch: () => Promise.reject(new Error("offline")) });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  installed = loadInstalledPacks(dataDir).packs;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

function setup(): RoomBench {
  const bench = new RoomBench({ media: true, packs: (media) => new RoomPacks({ packs: installed, skills: assemblePacks(installed).skills, media }) });
  benches.push(bench);
  return bench;
}

async function say(b: RoomBench, key: string, rid: string, text: string): Promise<Record<string, unknown>> {
  const wire = b.join(key);
  wire.receive({ type: "input", rid, text });
  await b.settled();
  return (resultFor(wire.sent, rid) ?? {}) as Record<string, unknown>;
}

/** The `panels` view as the member `key` connects to it. */
async function panelsOf(b: RoomBench, key: string): Promise<PanelsView> {
  const wire = b.join(key);
  wire.receive({ type: "call", rid: "sub", method: "view.subscribe", params: { names: ["panels"] } });
  await b.settled();
  const value = views(wire.sent, "panels").at(-1)?.data as PanelsView;
  expect(schemaProblems(PANELS_VIEW_SCHEMA, value)).toEqual([]);
  return value;
}

/** Ask for `hash` over the byte channel as the member `key` connects as. */
async function get(b: RoomBench, key: string, hash: string): Promise<{ reply: Record<string, unknown>; body: Buffer }> {
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
  return { reply: decodeByteReply(JSON.parse(all.subarray(0, newline).toString("utf8"))) as unknown as Record<string, unknown>, body: all.subarray(newline + 1) };
}

const ids = (view: PanelsView): string[] => view.panels.map((panel) => panel.id);

test("no panels until the pack is enabled; then each role is listed what it may see", async () => {
  const b = setup();
  expect(await panelsOf(b, KEYS.ada)).toEqual({ panels: [] });
  await say(b, KEYS.root, "e", ".pack enable harbor");
  expect(ids(await panelsOf(b, KEYS.ada))).toEqual(["harbor/tide", "harbor/chart"]);
  expect(ids(await panelsOf(b, KEYS.eve))).toEqual(["harbor/tide", "harbor/chart"]);
  const admin = await panelsOf(b, KEYS.root);
  expect(ids(admin)).toEqual(["harbor/tide", "harbor/ledger", "harbor/chart", "harbor/notes"]);
  const [tide, ledger, chart, notes] = admin.panels;
  expect(tide).toMatchObject({ title: "The tide", slot: "sidebar", kind: "template", source: { kind: "pack", id: "harbor" }, views: [{ as: "me", view: "me" }, { as: "tide", view: "tally/tide" }] });
  expect(tide?.blocks?.[1]).toMatchObject({ kind: "image", mime: "image/png" });
  expect(ledger).toMatchObject({ slot: "tray", views: [{ as: "vars", view: "variables" }] });
  expect(chart).toMatchObject({ kind: "page", page: { mime: "text/html", size: PAGE_HTML.length }, fallback: [{ kind: "text", text: { $view: "tide.level" } }] });
  expect(notes).toMatchObject({ kind: "page", fallback: null, page: { size: NOTES_HTML.length } });
});

test("a page's HTML and a panel's picture are served to the room's members, an admin page to its admins, nothing elsewhere", async () => {
  const b = setup();
  b.keystore.add("elsewhere-key", { room: "elsewhere", name: "Zed", role: "admin" });
  await say(b, KEYS.root, "e", ".pack enable harbor");
  const admin = await panelsOf(b, KEYS.root);
  const chart = admin.panels.find((panel) => panel.id === "harbor/chart")?.page?.hash ?? "";
  const notes = admin.panels.find((panel) => panel.id === "harbor/notes")?.page?.hash ?? "";
  const picture = (admin.panels[0]?.blocks?.[1] as { hash: string }).hash;
  // Unlisted: in nobody's media listing.
  expect(b.media?.list(ROOM)).toEqual([]);
  const page = await get(b, KEYS.ada, chart);
  expect(page.reply).toMatchObject({ ok: true, hash: chart, mime: "text/html", name: "chart.html" });
  expect(page.body.toString("utf8")).toBe(PAGE_HTML);
  expect((await get(b, KEYS.eve, picture)).reply).toMatchObject({ ok: true, mime: "image/png" });
  // The admin-only page: its admins fetch it; to a player it is a hash the room does not hold.
  expect((await get(b, KEYS.root, notes)).reply).toMatchObject({ ok: true, mime: "text/html" });
  const refused = (await get(b, KEYS.ada, notes)).reply;
  expect(refused).toMatchObject({ ok: false, code: "media_not_found" });
  expect(refused).toEqual((await get(b, KEYS.ada, "f".repeat(64))).reply);
  // Another room: the same answer as a hash nobody holds.
  expect((await get(b, "elsewhere-key", chart)).reply).toMatchObject({ ok: false, code: "media_not_found" });
});

test("the per-panel switch: the admin's, refused for an unknown panel, and the view follows it", async () => {
  const b = setup();
  expect(await say(b, KEYS.root, "x0", ".panels disable harbor/tide")).toMatchObject({ ok: false, error: { code: "panel_not_available" } });
  await say(b, KEYS.root, "e", ".pack enable harbor");
  expect(await say(b, KEYS.ada, "p", ".panels disable harbor/tide")).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await say(b, KEYS.root, "d", ".panels disable harbor/tide")).toMatchObject({ ok: true, data: { id: "harbor/tide", on: false, changed: true } });
  expect(await say(b, KEYS.root, "d2", ".面板 关闭 harbor/tide")).toMatchObject({ ok: true, data: { changed: false } });
  expect(b.store.stateGet(ROOM, ROOM_PANELS_OFF)).toEqual(["harbor/tide"]);
  expect(ids(await panelsOf(b, KEYS.ada))).toEqual(["harbor/chart"]);
  // A player's list is what the view lists them; the admin's has every panel and its switch.
  expect(await say(b, KEYS.ada, "l", ".panels")).toMatchObject({ ok: true, data: { panels: [{ id: "harbor/chart", kind: "page" }] } });
  const listed = await say(b, KEYS.root, "l2", ".panels list");
  expect((listed.data as { panels: { id: string; on: boolean; adminOnly: boolean }[] }).panels.map((panel) => [panel.id, panel.on, panel.adminOnly])).toEqual([
    ["harbor/tide", false, false],
    ["harbor/ledger", true, true],
    ["harbor/chart", true, false],
    ["harbor/notes", true, true],
  ]);
  expect(listed.text).toContain("The tide (harbor/tide) — off");
  expect(await say(b, KEYS.root, "x1", ".panels enable harbor/nothing")).toMatchObject({ ok: false, error: { code: "panel_not_available" } });
  expect(await say(b, KEYS.root, "on", ".panels enable harbor/tide")).toMatchObject({ ok: true, data: { on: true, changed: true } });
  expect(b.store.stateGet(ROOM, ROOM_PANELS_OFF)).toBeNull();
  expect(ids(await panelsOf(b, KEYS.ada))).toEqual(["harbor/tide", "harbor/chart"]);
});

test("the switch is a room setting: it survives `reset all`, and the pages are served again after it", async () => {
  const b = setup();
  await say(b, KEYS.root, "e", ".pack enable harbor");
  await say(b, KEYS.root, "d", ".panels disable harbor/ledger");
  expect(await say(b, KEYS.root, "r1", ".reset all")).toMatchObject({ ok: true });
  expect(await say(b, KEYS.root, "r2", ".reset all confirm")).toMatchObject({ ok: true });
  await b.settled();
  expect(b.store.stateGet(ROOM, ROOM_PANELS_OFF)).toEqual(["harbor/ledger"]);
  const admin = await panelsOf(b, KEYS.root);
  expect(ids(admin)).toEqual(["harbor/tide", "harbor/chart", "harbor/notes"]);
  const chart = admin.panels.find((panel) => panel.id === "harbor/chart")?.page?.hash ?? "";
  expect((await get(b, KEYS.ada, chart)).reply).toMatchObject({ ok: true });
});
