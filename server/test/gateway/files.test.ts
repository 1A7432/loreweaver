// Files at the room: a member's share reaching the table, the upload switch (command and
// view), and `import` — a card the caller uploaded, made the room's world (admin) or the
// caller's character — with the card file kept away from the table.
import { afterEach, describe, expect, test } from "bun:test";

import type { EventFrame, ServerFrame } from "loreweaver-protocol/v3";

import { LORE_ENTRY_TYPE } from "../../src/core/lore/index.ts";
import { COMMANDS_CATALOG } from "../../src/gateway/commands/index.ts";
import type { Member } from "../../src/gateway/room.ts";
import { type Embeddings, HashEmbeddings, VectorIndex } from "../../src/infra/recall/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { memberId } from "../../src/net/keystore.ts";
import type { Wire } from "../helpers.ts";
import { jsonFile, MK, plainCard, pngFile, sha256, upload, worldCard } from "./card_files.ts";
import { events, KEYS, resultFor, ROOM, RoomBench, type BenchOptions, views } from "./room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((b) => b.close()));
});

function setup(options: BenchOptions = {}): RoomBench {
  const b = new RoomBench({ media: true, ...options });
  benches.push(b);
  return b;
}

const ADA = { id: memberId(KEYS.ada), role: "player" as const };
const BAO = { id: memberId(KEYS.bao), role: "player" as const };
const ROOT = { id: memberId(KEYS.root), role: "admin" as const };

/** A PNG-signed picture, distinct per tag. */
function picture(tag: string): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(tag)]);
}

function member(key: keyof typeof KEYS, role: Member["role"]): Member {
  const name = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  return { connection: `${key}#test`, id: memberId(KEYS[key]), name, role, locale: "en", send: () => undefined };
}

async function say(b: RoomBench, wire: Wire, rid: string, text: string): Promise<ServerFrame | undefined> {
  wire.receive({ type: "input", rid, text });
  // A character import does not queue behind the room's lock (it may wait on the model): wait for its answer itself.
  await wire.until((frame) => frame.type === "result" && frame.rid === rid);
  await b.settled();
  return resultFor(wire.sent, rid);
}

function narratives(frames: readonly ServerFrame[]): string[] {
  return events(frames)
    .filter((frame): frame is Extract<EventFrame, { kind: "narrative" }> => frame.kind === "narrative")
    .map((frame) => frame.data.text);
}

function mediaEvents(frames: readonly ServerFrame[]): EventFrame[] {
  return events(frames).filter((frame) => frame.kind === "media");
}

function everything(b: RoomBench): string {
  return JSON.stringify([b.store.docList(ROOM), [...b.store.stateList(ROOM)]]);
}

describe("a share", () => {
  test("reaches every member as a turn-less media event from its uploader; the same bytes shared again are announced again", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const bao = b.join(KEYS.bao);
    const bytes = picture("map");
    ada.receive({ type: "call", rid: "offer", method: "media.offer", params: { name: "../secret/map.png", mime: "image/png", size: bytes.length, sha256: sha256(bytes) } });
    const offered = resultFor(ada.sent, "offer");
    // Read before matching: the matcher writes its placeholder into the object it matched.
    const uploadId = (offered as { data: { upload_id: string } }).data.upload_id;
    expect(typeof uploadId).toBe("string");
    expect(offered).toMatchObject({ ok: true });
    const stored = await b.hub.room(ROOM).receiveUpload(member("ada", "player"), uploadId, bytes);
    expect(stored).toMatchObject({ ok: true, record: { name: "map.png", audience: "room" } });
    const shared = mediaEvents(bao.sent);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ kind: "media", data: { hash: sha256(bytes), mime: "image/png", size: bytes.length, name: "map.png", from: ADA.id } });
    expect(shared[0]?.turn).toBeUndefined();
    expect(b.actions.at(-1)).toEqual({ actor: "Ada", action: "media", text: "map.png" });

    bao.receive({ type: "call", rid: "again", method: "media.offer", params: { name: "copy.png", mime: "image/png", size: bytes.length, sha256: sha256(bytes) } });
    expect(resultFor(bao.sent, "again")).toMatchObject({ ok: true, data: { existing: { hash: sha256(bytes), name: "map.png", from: ADA.id } } });
    expect(mediaEvents(ada.sent).map((frame) => frame.data)).toEqual([expect.objectContaining({ from: ADA.id }), expect.objectContaining({ from: BAO.id })]);
  });

  test("a server without a media store refuses every offer", async () => {
    const b = setup({ media: false });
    const ada = b.join(KEYS.ada, { locale: "zh" });
    ada.receive({ type: "call", rid: "o", method: "media.offer", params: { name: "a.png", mime: "image/png", size: 1, sha256: "a".repeat(64) } });
    expect(resultFor(ada.sent, "o")).toEqual({ type: "result", rid: "o", ok: false, error: { code: "media_unavailable", message: "本服务器不保存文件：无法上传。" } });
    expect(await say(b, ada, "u", ".uploads")).toMatchObject({ ok: false, error: { code: "no_media" } });
  });
});

describe("the upload switch", () => {
  test("anyone sees it, only the admin sets it; the table hears it, the room view shows it, offers obey it", async () => {
    const b = setup();
    const eve = b.join(KEYS.eve);
    const ada = b.join(KEYS.ada, { locale: "zh" });
    const root = b.join(KEYS.root);
    ada.receive({ type: "call", rid: "sub", method: "view.subscribe", params: { names: ["room"] } });
    await b.settled();
    expect(views(ada.sent, "room").at(-1)?.data).toMatchObject({ uploads: true });

    expect(await say(b, eve, "show", ".uploads")).toMatchObject({ ok: true, text: "Members may upload files to this room.", data: { on: true } });
    expect(await say(b, ada, "set", ".上传 off")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await say(b, eve, "eveset", ".uploads on")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await say(b, root, "off", ".uploads off")).toMatchObject({ ok: true, data: { on: false } });
    expect(narratives(ada.sent)).toEqual(["Uploads are closed for now."]);
    expect(views(ada.sent, "room").at(-1)?.data).toMatchObject({ uploads: false });
    expect(await say(b, ada, "zh", ".上传")).toMatchObject({ ok: true, text: "本房间已关闭上传。" });

    const bytes = picture("x");
    ada.receive({ type: "call", rid: "offer", method: "media.offer", params: { name: "x.png", mime: "image/png", size: bytes.length, sha256: sha256(bytes) } });
    expect(resultFor(ada.sent, "offer")).toMatchObject({ ok: false, error: { code: "media_disabled", message: "本房间已关闭上传。" } });

    root.receive({ type: "call", rid: "on", method: "command.run", params: { id: "uploads", args: { on: true } } });
    await b.settled();
    expect(resultFor(root.sent, "on")).toMatchObject({ ok: true });
    expect(views(ada.sent, "room").at(-1)?.data).toMatchObject({ uploads: true });
  });
});

describe("import", () => {
  test("a world card as PNG, by the admin: lore written, ONE table line, no media event, the file never a player's to fetch", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const root = b.join(KEYS.root);
    const card = pngFile(worldCard());
    const record = await upload(b.uploads!, ROOM, ROOT, card, "image/png", "import", "city.png");
    expect(record).toMatchObject({ audience: "admin" });
    const before = ada.sent.length;

    const answer = await say(b, root, "imp", `.import world ${sha256(card)}`);
    expect(answer).toMatchObject({ ok: true, data: { code: "world_imported", name: "Drowned City" } });
    const text = (answer as { text: string }).text;
    expect(text).toContain("Imported the world Drowned City: 2 lore entries (1 secret), 1 variable declarations, 1 openings.");
    expect(text).toContain("hook scripts ×1");
    expect(JSON.stringify((answer as { data: unknown }).data)).not.toContain(MK.plainLore);

    const table = ada.sent.slice(before);
    expect(narratives(table)).toEqual(["A world was imported: Drowned City."]);
    expect(events(table)).toHaveLength(1);
    expect(mediaEvents([...ada.sent, ...root.sent])).toEqual([]);
    for (const mark of Object.values(MK)) expect(JSON.stringify(ada.sent)).not.toContain(mark);
    expect(b.store.docList(ROOM, LORE_ENTRY_TYPE)).toHaveLength(2);

    expect(await b.uploads!.read(ROOM, "player", sha256(card))).toBeUndefined();
    expect(await b.uploads!.read(ROOM, "admin", sha256(card))).toBeDefined();
    expect(b.uploads!.media.list(ROOM)).toEqual([]);
  });

  test("a world card as JSON; refused to a player; the admin's result in the admin's language, the table's line in the room's", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const root = b.join(KEYS.root, { locale: "zh" });
    const card = jsonFile(worldCard("潮城"));
    await upload(b.uploads!, ROOM, ROOT, card, "application/json");
    await upload(b.uploads!, ROOM, ADA, card, "application/json");
    expect(await say(b, ada, "player", `.import world ${sha256(card)}`)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    ada.receive({ type: "call", rid: "run", method: "command.run", params: { id: "import", args: { file: sha256(card), as: "world" } } });
    await b.settled();
    expect(resultFor(ada.sent, "run")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(b.store.docList(ROOM, LORE_ENTRY_TYPE)).toEqual([]);

    const answer = await say(b, root, "imp", `.导入 世界 ${sha256(card)}`);
    expect((answer as { text: string }).text).toStartWith("已导入世界 潮城：2 条设定（1 条保密）");
    expect(narratives(ada.sent)).toEqual(["A world was imported: 潮城."]);

    // The same card again replaces itself.
    const again = await say(b, root, "again", `.import world ${sha256(card)}`);
    expect(again).toMatchObject({ ok: true, data: { code: "world_reimported", lore: { replaced: 2 } } });
  });

  test("a character card by a player seats them; a card stuffed with world machinery writes none of it", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const bao = b.join(KEYS.bao);
    const card = jsonFile(worldCard("Mira"));
    await upload(b.uploads!, ROOM, ADA, card, "application/json");
    const before = bao.sent.length;
    const answer = await say(b, ada, "pc", `.import character ${sha256(card)}`);
    expect(answer).toMatchObject({ ok: true, data: { code: "character_imported", name: "Mira", worldCard: true } });
    const text = (answer as { text: string }).text;
    expect(text).toContain("You now play Mira");
    expect(text).toContain("only its character came along");
    expect(text).toContain("Left behind:");
    expect(events(bao.sent.slice(before))).toEqual([]);
    const stored = everything(b);
    expect(stored).toContain("A city under the sea");
    for (const mark of Object.values(MK)) expect(stored).not.toContain(mark);
    expect(b.store.docList(ROOM, LORE_ENTRY_TYPE)).toEqual([]);
    // Ada plays Mira now.
    ada.receive({ type: "call", rid: "me", method: "view.get", params: { name: "me" } });
    await b.settled();
    expect(resultFor(ada.sent, "me")).toMatchObject({ ok: true, data: { data: { character: { name: "Mira" } } } });

    // A name given to it; and a player's PNG card works the same way.
    const png = pngFile(plainCard("Ned"));
    await upload(b.uploads!, ROOM, BAO, png, "image/png");
    expect(await say(b, bao, "ned", `.import character ${sha256(png)} Captain Ned`)).toMatchObject({ ok: true, data: { name: "Captain Ned" } });
  });

  test("refused: a file that is not a card, a hash the caller did not upload, a malformed hash, a card that is not JSON-shaped", async () => {
    const b = setup();
    const ada = b.join(KEYS.ada);
    const bao = b.join(KEYS.bao);
    const junk = picture("not a card");
    await upload(b.uploads!, ROOM, ADA, junk, "image/png");
    expect(await say(b, ada, "junk", `.import character ${sha256(junk)}`)).toMatchObject({ ok: false, error: { code: "not_a_card" } });

    const card = jsonFile(plainCard("Mira"));
    await upload(b.uploads!, ROOM, ADA, card, "application/json");
    const notYours = await say(b, bao, "steal", `.import character ${sha256(card)}`);
    const nowhere = await say(b, bao, "none", `.import character ${"b".repeat(64)}`);
    expect(notYours).toMatchObject({ ok: false, error: { code: "not_uploaded" } });
    expect((notYours as { error: unknown }).error).toEqual((nowhere as { error: unknown }).error);
    expect(await say(b, ada, "short", ".import character abc")).toMatchObject({ ok: false, error: { code: "invalid_arg" } });
    expect(await say(b, ada, "usage", ".import planet abc")).toMatchObject({ ok: false, error: { code: "usage" } });
    // A shared picture is room media, not an import file: the caller did not bring it for import.
    const shared = picture("shared");
    await upload(b.uploads!, ROOM, ADA, shared, "image/png", "share");
    expect(await say(b, bao, "shared", `.import character ${sha256(shared)}`)).toMatchObject({ ok: false, error: { code: "not_uploaded" } });
    // Only PNG and JSON are card files.
    expect(b.uploads!.offer(ROOM, ADA, { name: "c.gif", mime: "image/gif", size: 10, sha256: "c".repeat(64), purpose: "import" })).toEqual({ ok: false, code: "media_bad_mime" });

    // The same bytes brought by a second player are theirs to import as well.
    expect(await upload(b.uploads!, ROOM, BAO, card, "application/json")).toMatchObject({ uploader: ADA.id });
    expect(await say(b, bao, "mine", `.import character ${sha256(card)} Bao's Mira`)).toMatchObject({ ok: true });
  });

  test("the new lore is indexed for recall; a recall failure is reported, not a failed import", async () => {
    const embeddings = new HashEmbeddings();
    const index = new VectorIndex(embeddings.dimensions, openDatabase(":memory:"));
    const b = setup({ recall: { embeddings, index } });
    const root = b.join(KEYS.root);
    const card = jsonFile(worldCard());
    await upload(b.uploads!, ROOM, ROOT, card, "application/json");
    const answer = await say(b, root, "imp", `.import world ${sha256(card)}`);
    expect((answer as { text: string }).text).toEndWith("2 lore entries indexed for recall.");
    expect(index.count(ROOM)).toBe(2);

    const failing: Embeddings = { dimensions: embeddings.dimensions, embed: () => Promise.reject(new Error("offline")) };
    const broken = setup({ recall: { embeddings: failing, index: new VectorIndex(embeddings.dimensions, openDatabase(":memory:")) } });
    const admin = broken.join(KEYS.root);
    await upload(broken.uploads!, ROOM, ROOT, card, "application/json");
    const failed = await say(broken, admin, "imp", `.import world ${sha256(card)}`);
    expect(failed).toMatchObject({ ok: true, data: { code: "world_imported" } });
    expect((failed as { text: string }).text).toContain("Indexing the lore for recall failed (index_failed)");
    expect(broken.reports).toContain("import: recall indexing: index_failed");
    expect(broken.store.docList(ROOM, LORE_ENTRY_TYPE)).toHaveLength(2);
  });
});

test("every refusal an import can pass through, and every part it can leave behind, has its sentence in both languages", () => {
  const codes = ["too_many_entries", "lore_full", "entry_invalid", "name_too_long", "prose_too_long", "directive_too_long", "too_many_openings", "opening_too_long", "variables_too_large", "module_variables_full", "no_member", "no_rule_system", "card_bad_name", "name_taken", "persona_too_long", "sheet_refused", "seat_refused", "document_refused", "stale_generation", "not_uploaded", "not_a_card", "no_media"];
  const parts = ["variable_declarations", "templates", "secret_entries", "lore_entries", "hooks", "module_variables", "directives", "openings", "scenario", "pregens"];
  const keys = [...codes.map((code) => `error.${code}`), ...parts.map((part) => `import.part.${part}`), "reason.no_media"];
  for (const locale of ["en", "zh"] as const) {
    expect(keys.filter((key) => !Object.hasOwn(COMMANDS_CATALOG[locale] ?? {}, key))).toEqual([]);
  }
});
