// Undo, reset and the export → import round trip (the save as a file of the room, the upload
// it is restored from), driving the store, and what each tells the gateway to announce.
import { describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";

import { AUDIO_LIBRARY, AUDIO_PLAYING } from "../../../src/core/audio/index.ts";
import { CHARACTER_TYPE } from "../../../src/core/characters/index.ts";
import { CHRONICLE_RECORD_TYPE } from "../../../src/core/chronicle/index.ts";
import { LORE_ENTRY_TYPE } from "../../../src/core/lore/index.ts";
import { REPORT_PAGES } from "../../../src/gateway/commands/engine/report.ts";
import { SAVE_EXPORT } from "../../../src/gateway/commands/engine/save.ts";
import type { CommandOutcome } from "../../../src/gateway/commands/index.ts";
import type { RoomBundle } from "../../../src/infra/lifecycle/bundle.ts";
import { DEFAULT_MEDIA_LIMITS } from "../../../src/infra/media/index.ts";
import { ADA, ADMIN, bench, type Bench, code, EVE, type Member, ok, ROOM } from "./bench.ts";
import { seedChronicle, seedLore } from "./seed.ts";

describe("undo", () => {
  test("rewinds the room's documents, moves the generation, and announces a rewind", async () => {
    const b = bench();
    const before = b.store.room(ROOM);
    const draft = b.context(ADA);
    draft.writer.appendEvent({ id: "e1", ts: 1, kind: "narrative", turn: draft.turn, data: { speaker: "player", text: "hello", format: "plain" } });
    await b.input(ADA, ".coc Alice");
    expect(b.store.docList(ROOM, CHARACTER_TYPE)).toHaveLength(1);
    const undone = ok(await b.run(ADMIN, "undo", {}));
    expect(b.store.docList(ROOM, CHARACTER_TYPE)).toHaveLength(0);
    expect(b.context(ADA).who.character).toBeNull();
    const meta = b.store.room(ROOM);
    expect(meta.epoch).toBe(before.epoch + 1);
    expect(undone.lifecycle).toEqual({ kind: "rewind", epoch: meta.epoch, turn: draft.turn, modulesChanged: [] });
    // Nothing of the undone turn was in the log past its first event: a plain cut, nothing kept.
    expect(undone.events).toEqual([{ kind: "rewind", data: { from: 2, kept: [], epoch: meta.epoch } }]);
    expect(undone.text).toContain(`turn ${draft.turn}`);
  });

  test("refuses a rewind past the start or past the undo window", async () => {
    const b = bench();
    expect(code(await b.run(ADMIN, "undo", {}))).toBe("undo_out_of_range");
    for (let index = 0; index < 6; index++) b.context(ADA);
    expect(code(await b.run(ADMIN, "undo", { turns: 5 }))).toBe("undo_beyond_depth");
  });
});

describe("reset", () => {
  test("arms, then clears its scope on confirmation and announces the reset", async () => {
    const b = bench();
    seedChronicle(b);
    seedLore(b);
    await b.input(ADA, ".coc Alice");
    const armed = ok(await b.run(ADMIN, "reset", {}));
    expect(armed.data).toEqual({ armed: "story", expiresInMs: 60_000 });
    expect(armed.events).toEqual([]);
    expect(b.store.docList(ROOM, CHRONICLE_RECORD_TYPE)).toHaveLength(2);
    const done = ok(await b.run(ADMIN, "reset", { confirm: true }));
    expect(b.store.docList(ROOM, CHRONICLE_RECORD_TYPE)).toHaveLength(0);
    expect(b.store.docList(ROOM, CHARACTER_TYPE)).toHaveLength(1);
    const epoch = b.store.room(ROOM).epoch;
    expect(done.lifecycle).toEqual({ kind: "reset", epoch, scope: "story" });
    expect(done.events).toEqual([{ kind: "reset", data: { scope: "story", epoch } }]);

    ok(await b.run(ADMIN, "reset", { scope: "all" }));
    ok(await b.run(ADMIN, "reset", { confirm: true, scope: "all" }));
    expect(b.store.docList(ROOM, CHARACTER_TYPE)).toHaveLength(0);
    expect(b.store.docList(ROOM, LORE_ENTRY_TYPE)).toHaveLength(0);
  });

  test("confirmation needs an armed reset, of the same scope, in time", async () => {
    const b = bench();
    expect(code(await b.run(ADMIN, "reset", { confirm: true }))).toBe("reset_not_armed");
    ok(await b.run(ADMIN, "reset", { scope: "chars" }));
    expect(code(await b.run(ADMIN, "reset", { confirm: true, scope: "all" }))).toBe("reset_scope_mismatch");
    // The mismatch disarmed it.
    expect(code(await b.run(ADMIN, "reset", { confirm: true }))).toBe("reset_not_armed");
    const late = bench({ resetConfirmMs: 0 });
    ok(await late.run(ADMIN, "reset", {}));
    expect(code(await late.run(ADMIN, "reset", { confirm: true }))).toBe("reset_not_armed");
  });
});

describe("save", () => {
  const ADMIN_TWO: Member = { id: "m-root-2", name: "Root Two", role: "admin" };

  interface Exported {
    readonly documents: number;
    readonly events: number;
    readonly media: { readonly hash: string; readonly mime: string; readonly size: number; readonly name: string };
  }

  async function exportOf(b: Bench): Promise<{ readonly data: Exported; readonly bytes: Uint8Array; readonly bundle: RoomBundle }> {
    const outcome = ok(await b.run(ADMIN, "save", { op: "export" }));
    const data = outcome.data as Exported;
    const file = await b.uploads?.media.read(ROOM, data.media.hash, "admin");
    if (file === undefined) throw new Error("the export is not stored");
    return { data, bytes: file.bytes, bundle: JSON.parse(new TextDecoder().decode(file.bytes)) as RoomBundle };
  }

  /** `member` uploads `bytes` as a save (`media.offer {purpose: "save"}` and the PUT); the hash. */
  async function uploadSave(b: Bench, member: Member, bytes: Uint8Array): Promise<string> {
    const uploads = b.uploads;
    if (uploads === null) throw new Error("no media");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const offered = uploads.offer(ROOM, member, { name: "room.json", mime: "application/json", size: bytes.length, sha256, purpose: "save" });
    if (!offered.ok) throw new Error(offered.code);
    if (offered.kind === "existing") return offered.record.hash;
    const received = await uploads.receive(ROOM, member, offered.uploadId, bytes);
    if (!received.ok) throw new Error(received.code);
    return received.record.hash;
  }

  test("export stores the room as an admins-only file and answers with its reference; import from an upload reproduces the room", async () => {
    const from = bench({ media: true });
    seedLore(from);
    await from.input(ADA, ".coc Alice");
    ok(await from.run(ADA, "sheet", { op: "set", writes: [{ name: "力量", op: "=", value: "70" }] }));
    const outcome = ok(await from.run(ADMIN, "save", { op: "export" }));
    expect(outcome.events).toEqual([]);
    const { data, bundle, bytes } = await exportOf(from);
    expect(data.media).toMatchObject({ mime: "application/json", size: bytes.length });
    expect(data.media.name.endsWith(".json")).toBe(true);
    expect(data.documents).toBe(bundle.documents.length);
    expect(data.events).toBe(bundle.events.length);
    expect(Object.keys(outcome.data as object).sort()).toEqual(["documents", "events", "media"]);
    // Never room media: no listing names it.
    expect(from.uploads?.media.list(ROOM)).toEqual([]);

    const to = bench({ media: true });
    const hash = await uploadSave(to, ADMIN, bytes);
    const imported = ok(await to.run(ADMIN, "save", { op: "import", file: hash }));
    expect(imported.lifecycle).toMatchObject({ kind: "import", turn: bundle.turn });
    // The upload was read and is gone.
    expect(to.uploads?.media.find(ROOM, hash, "admin")).toBeUndefined();
    const again = (await exportOf(to)).bundle;
    expect(again.documents).toEqual(bundle.documents);
    expect(again.state).toEqual(bundle.state);
    const shown = ok(await to.run(ADA, "sheet", { op: "show" }));
    expect(shown.text).toContain("STR 70");
  });

  test("the text forms: `save` and `save export` export, `save import <hash>` imports; anything else is refused", async () => {
    const b = bench({ media: true });
    const typed = async (line: string): Promise<CommandOutcome> => {
      const outcome = await b.input(ADMIN, line);
      if (outcome.kind !== "command") throw new Error(`${line} was speech`);
      return outcome.outcome;
    };
    expect((ok(await typed(".save")).data as Exported).media.mime).toBe("application/json");
    expect((ok(await typed(".save export")).data as Exported).media.mime).toBe("application/json");
    expect(code(await typed(".save import"))).toBe("missing_arg");
    expect(code(await typed(".save import not-a-hash"))).toBe("invalid_arg");
    expect(code(await typed(".save import {\"format\":\"loreweaver-room\"}"))).toBe("invalid_arg");
    expect(code(await typed(".save export now"))).toBe("usage");
    expect(code(await typed(".save load"))).toBe("usage");
    const hash = await uploadSave(b, ADMIN, (await exportOf(b)).bytes);
    expect(ok(await typed(`.save import ${hash}`)).lifecycle).toMatchObject({ kind: "import" });
    // The old argument is no longer one.
    expect(code(await b.run(ADMIN, "save", { op: "import", bundle: {} }))).toBe("unknown_arg");
  });

  test("the room keeps only its latest export", async () => {
    const b = bench({ media: true });
    const first = (await exportOf(b)).data.media.hash;
    // The same room, the same bytes: the same file, kept.
    expect((await exportOf(b)).data.media.hash).toBe(first);
    await b.input(ADA, ".coc Alice");
    const second = (await exportOf(b)).data.media.hash;
    expect(second).not.toBe(first);
    expect(b.uploads?.media.find(ROOM, first, "admin")).toBeUndefined();
    expect(b.uploads?.media.find(ROOM, second, "admin")?.family).toBe("save");
    expect(b.store.stateGet(ROOM, SAVE_EXPORT)).toBe(second);
    expect(b.uploads?.media.usage(ROOM).save).toBe(b.uploads?.media.find(ROOM, second, "admin")?.size);
  });

  test("a bundle carries no key naming a file of the room (the latest export, the report pages), and an import drops one a bundle has", async () => {
    const b = bench({ media: true });
    await b.input(ADA, ".coc Alice");
    ok(await b.run(ADA, "report", { format: "html" }));
    await exportOf(b);
    const { bundle } = await exportOf(b);
    expect(b.store.stateGet(ROOM, SAVE_EXPORT)).not.toBeNull();
    expect(b.store.stateGet(ROOM, REPORT_PAGES)).not.toBeNull();
    expect(bundle.state.map((entry) => entry.key)).not.toContain(SAVE_EXPORT.name);
    expect(bundle.state.map((entry) => entry.key)).not.toContain(REPORT_PAGES.name);

    // A bundle made by hand with both keys: loaded without them.
    const ghost = "f".repeat(64);
    // The audio library and what is playing name uploaded sounds, files of the room too: the same rule.
    const forged = {
      ...bundle,
      state: [
        ...bundle.state,
        { key: SAVE_EXPORT.name, value: JSON.stringify(ghost) },
        { key: REPORT_PAGES.name, value: JSON.stringify({ player: ghost }) },
        { key: AUDIO_LIBRARY.name, value: "[]" },
        { key: AUDIO_PLAYING.name, value: "{}" },
      ],
    };
    const to = bench({ media: true });
    const hash = await uploadSave(to, ADMIN, new TextEncoder().encode(JSON.stringify(forged)));
    ok(await to.run(ADMIN, "save", { op: "import", file: hash }));
    expect(to.store.stateGet(ROOM, SAVE_EXPORT)).toBeNull();
    expect(to.store.stateGet(ROOM, REPORT_PAGES)).toBeNull();
    expect(to.store.stateGet(ROOM, AUDIO_LIBRARY)).toBeNull();
    expect(to.store.stateGet(ROOM, AUDIO_PLAYING)).toBeNull();
    for (const key of [AUDIO_LIBRARY, AUDIO_PLAYING]) expect(typeof key.outsideBundle).toBe("string");
  });

  test("a save the store cannot load is refused, changes nothing, and its upload is removed; the room's own export stays", async () => {
    const b = bench({ media: true });
    await b.input(ADA, ".coc Alice");
    const wrong = await uploadSave(b, ADMIN, new TextEncoder().encode(JSON.stringify({ format: "something-else" })));
    expect(code(await b.run(ADMIN, "save", { op: "import", file: wrong }))).toBe("bad_bundle");
    expect(b.store.docList(ROOM, CHARACTER_TYPE)).toHaveLength(1);
    expect(b.uploads?.media.find(ROOM, wrong, "admin")).toBeUndefined();
    // Starts like a JSON object (the store's signature check), but is not JSON.
    const broken = await uploadSave(b, ADMIN, new TextEncoder().encode("{not json"));
    expect(code(await b.run(ADMIN, "save", { op: "import", file: broken }))).toBe("bad_bundle");
    expect(b.uploads?.media.find(ROOM, broken, "admin")).toBeUndefined();
    // Gone means gone: the same hash again is not an upload of this member any more.
    expect(code(await b.run(ADMIN, "save", { op: "import", file: broken }))).toBe("save_not_uploaded");

    // The room's latest export offered back and refused (a document type this room does not
    // know): the export is the room's, and stays.
    const { data, bundle } = await exportOf(b);
    const unknown = { ...bundle, documents: [...bundle.documents, { type: "no_such_type", id: "x", version: 1, data: "{}", meta: "{}" }] };
    const refused = await uploadSave(b, ADMIN, new TextEncoder().encode(JSON.stringify(unknown)));
    expect(code(await b.run(ADMIN, "save", { op: "import", file: refused }))).toBe("undeclared_document_type");
    expect(b.uploads?.media.find(ROOM, refused, "admin")).toBeUndefined();
    const own = await uploadSave(b, ADMIN, (await b.uploads!.media.read(ROOM, data.media.hash, "admin"))!.bytes);
    expect(own).toBe(data.media.hash);
    expect(b.uploads?.media.find(ROOM, own, "admin")).toBeDefined();
  });

  test("no player or observer can reach a save: not by its hash, not by offering one, not by importing one; an admin imports only what they uploaded", async () => {
    const b = bench({ media: true });
    seedLore(b);
    const { data, bytes } = await exportOf(b);
    const uploads = b.uploads!;
    // The export's hash is no use to a player or an observer: the same answer as a hash nobody holds.
    expect(await uploads.read(ROOM, "player", data.media.hash)).toBeUndefined();
    expect(await uploads.read(ROOM, "observer", data.media.hash)).toBeUndefined();
    expect(await uploads.read(ROOM, "admin", data.media.hash)).toBeDefined();
    // Offering a save: forbidden to a player (whatever the bytes — even the export's own, which
    // would otherwise be confirmed by an `existing`), refused to an observer.
    const offer = { name: "room.json", mime: "application/json", size: bytes.length, sha256: data.media.hash, purpose: "save" as const };
    expect(uploads.offer(ROOM, ADA, offer)).toEqual({ ok: false, code: "forbidden" });
    expect(uploads.offer(ROOM, EVE, offer)).toEqual({ ok: false, code: "observer_upload" });
    expect(uploads.offer(ROOM, ADMIN, { ...offer, mime: "image/png" })).toEqual({ ok: false, code: "media_bad_mime" });
    // Nor as a card file: a player's `import` offer of the export's hash is not confirmed.
    expect(uploads.offer(ROOM, ADA, { ...offer, purpose: "import" })).toMatchObject({ ok: true, kind: "upload" });
    expect(code(await b.run(ADA, "import", { file: data.media.hash, as: "character" }))).toBe("not_uploaded");

    const hash = await uploadSave(b, ADMIN_TWO, new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), turn: 0 })));
    expect(await uploads.read(ROOM, "player", hash)).toBeUndefined();
    expect(code(await b.run(ADA, "save", { op: "import", file: hash }))).toBe("forbidden");
    expect(code(await b.run(EVE, "save", { op: "export" }))).toBe("forbidden");
    // Another admin's upload: not this admin's to import, as with a card.
    expect(code(await b.run(ADMIN, "save", { op: "import", file: hash }))).toBe("save_not_uploaded");
    expect(uploads.media.find(ROOM, hash, "admin")).toBeDefined();
    // A card file is not a save, and a save is not a card file.
    const card = new TextEncoder().encode(JSON.stringify({ spec: "chara_card_v2", data: { name: "Mirabel" } }));
    const cardHash = createHash("sha256").update(card).digest("hex");
    const offered = uploads.offer(ROOM, ADMIN, { name: "card.json", mime: "application/json", size: card.length, sha256: cardHash, purpose: "import" });
    if (!offered.ok || offered.kind !== "upload") throw new Error("not offered");
    expect((await uploads.receive(ROOM, ADMIN, offered.uploadId, card)).ok).toBe(true);
    expect(code(await b.run(ADMIN, "save", { op: "import", file: cardHash }))).toBe("save_not_uploaded");
    expect(code(await b.run(ADMIN_TWO, "import", { file: hash, as: "world" }))).toBe("not_uploaded");
  });

  test("a save is held to its own limits: over the file cap it is refused, never cut", async () => {
    const small = { ...DEFAULT_MEDIA_LIMITS, save: { maxFileBytes: 64, roomQuotaBytes: 1024 } };
    const b = bench({ media: small });
    seedLore(b);
    const refused = await b.run(ADMIN, "save", { op: "export" });
    expect(code(refused)).toBe("save_not_stored");
    expect(refused.ok ? "" : refused.message).toContain("media_too_large");
    expect(b.store.stateGet(ROOM, SAVE_EXPORT)).toBeNull();
    const uploads = b.uploads!;
    expect(uploads.offer(ROOM, ADMIN, { name: "room.json", mime: "application/json", size: 65, sha256: "a".repeat(64), purpose: "save" })).toEqual({ ok: false, code: "media_too_large" });
    // A save counts against its own budget, not the pictures': a card file of the same size is fine.
    expect(uploads.offer(ROOM, ADMIN, { name: "card.json", mime: "application/json", size: 65, sha256: "b".repeat(64), purpose: "import" })).toMatchObject({ ok: true, kind: "upload" });
  });

  test("a server without a media store refuses save, as it does the other commands that need files", async () => {
    const b = bench();
    expect(code(await b.run(ADMIN, "save", { op: "export" }))).toBe("no_media");
    expect(code(await b.run(ADMIN, "save", { op: "import", file: "a".repeat(64) }))).toBe("no_media");
    const typed = await b.input(ADMIN, ".save");
    expect(typed.kind === "command" && !typed.outcome.ok ? typed.outcome.code : null).toBe("no_media");
  });
});
