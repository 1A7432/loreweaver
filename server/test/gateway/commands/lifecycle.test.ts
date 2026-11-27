// Undo, reset and the export → import round trip, driving the store, and what each tells
// the gateway to announce.
import { describe, expect, test } from "bun:test";

import { CHARACTER_TYPE } from "../../../src/core/characters/index.ts";
import { CHRONICLE_RECORD_TYPE } from "../../../src/core/chronicle/index.ts";
import { LORE_ENTRY_TYPE } from "../../../src/core/lore/index.ts";
import type { RoomBundle } from "../../../src/infra/lifecycle/bundle.ts";
import { ADA, ADMIN, bench, code, ok, ROOM } from "./bench.ts";
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
  test("export → import through the commands reproduces the room", async () => {
    const from = bench();
    seedLore(from);
    await from.input(ADA, ".coc Alice");
    ok(await from.run(ADA, "sheet", { op: "set", writes: [{ name: "力量", op: "=", value: "70" }] }));
    const exported = ok(await from.run(ADMIN, "save", { op: "export" }));
    expect(exported.events).toEqual([]);
    const bundle = exported.data as RoomBundle;

    const to = bench();
    const imported = ok(await to.run(ADMIN, "save", { op: "import", bundle: JSON.parse(JSON.stringify(bundle)) as unknown }));
    expect(imported.lifecycle).toMatchObject({ kind: "import", turn: bundle.turn });
    const again = ok(await to.run(ADMIN, "save", { op: "export" })).data as RoomBundle;
    expect(again.documents).toEqual(bundle.documents);
    expect(again.state).toEqual(bundle.state);
    const shown = ok(await to.run(ADA, "sheet", { op: "show" }));
    expect(shown.text).toContain("STR 70");
  });

  test("a bundle the store cannot load is refused and changes nothing", async () => {
    const b = bench();
    await b.input(ADA, ".coc Alice");
    expect(code(await b.run(ADMIN, "save", { op: "import", bundle: { format: "something-else" } }))).toBe("bad_bundle");
    expect(b.store.docList(ROOM, CHARACTER_TYPE)).toHaveLength(1);
    const typed = await b.input(ADMIN, ".save import {not json");
    expect(typed.kind === "command" && !typed.outcome.ok ? typed.outcome.code : null).toBe("bad_bundle");
  });
});
