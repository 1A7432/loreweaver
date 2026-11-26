import { describe, expect, test } from "bun:test";

import { parseBundle, ROOM_BUNDLE_FORMAT, ROOM_BUNDLE_VERSION, type RoomBundle } from "../../../src/infra/lifecycle/bundle.ts";
import { covers, MODULE_STATE_LIFECYCLE, type Lifecycle, type ResetScope } from "../../../src/infra/lifecycle/declarations.ts";
import { LifecycleError } from "../../../src/infra/lifecycle/errors.ts";
import { RoomStorages, type RoomStorageEvent } from "../../../src/infra/lifecycle/storages.ts";
import type { Store } from "../../../src/infra/store.ts";
import { ALL_KEY, CATALOG, CHARS_KEY, dump, memoryStore, NEVER_KEY, STORY_KEY } from "./support.ts";

function code(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof Error && "code" in error) return String((error as { code: unknown }).code);
    throw error;
  }
  return "no error";
}

/** A room with data of every lifecycle, two turns of play and a log. */
function populate(store: Store, room: string): void {
  const setup = store.writer(room);
  setup.docPut("lore", "world", 1, '{"world":true}', '{"source":"pack"}');
  setup.docPut("habit", "pace", 1, '{"pace":"slow"}', "{}");
  setup.statePut(ALL_KEY, "installed");
  setup.statePut(NEVER_KEY, "table");
  setup.setModuleState("clock", { day: 1 });
  setup.appendEvent({ id: "intro", ts: 1, kind: "narrative", data: { text: "welcome" } });
  const one = store.beginTurn(room);
  one.docPut("sheet", "ada", 1, '{"hp":10}', "{}");
  one.docPut("note", "n1", 1, '{"text":"a clue"}', "{}");
  one.statePut(STORY_KEY, "scene 1");
  one.statePut(CHARS_KEY, "ada");
  one.appendEvent({ id: "t1", ts: 2, kind: "narrative", turn: 1, data: { text: "one" } });
  const two = store.beginTurn(room);
  two.setModuleState("clock", { day: 2 });
  two.statePut(STORY_KEY, "scene 2");
  two.appendEvent({ id: "t2", ts: 3, kind: "narrative", turn: 2, data: { text: "two" } });
}

function docIds(store: Store, room: string): string[] {
  return store.docList(room).map((row) => `${row.type}:${row.id}`);
}

describe("declarations", () => {
  test("the scopes nest, and `never` survives every one", () => {
    const cases: [ResetScope, Lifecycle, boolean][] = [
      ["story", { reset: "story" }, true],
      ["story", { reset: "chars" }, false],
      ["chars", { reset: "story" }, true],
      ["chars", { reset: "chars" }, true],
      ["chars", { reset: "all" }, false],
      ["all", { reset: "all" }, true],
      ["all", { reset: "never", because: "x" }, false],
    ];
    for (const [scope, lifecycle, expected] of cases) expect(covers(scope, lifecycle)).toBe(expected);
    expect(MODULE_STATE_LIFECYCLE).toEqual({ reset: "all" });
  });
});

describe("reset", () => {
  test("story: what play produced goes; characters, world, modules and `never` data stay", () => {
    const { store } = memoryStore();
    populate(store, "a");
    const before = store.room("a");
    const result = store.reset("a", "story", CATALOG);
    expect(result).toEqual({ epoch: before.epoch + 1, head: before.head, turn: 0, storages: { cleared: [], failed: [] } });
    expect(docIds(store, "a")).toEqual(["habit:pace", "lore:world", "sheet:ada"]);
    expect([...store.stateList("a").keys()]).toEqual([ALL_KEY.name, CHARS_KEY.name, NEVER_KEY.name].sort());
    expect(store.moduleStates("a")).toEqual(new Map([["clock", { day: 2 }]]));
    expect(store.eventsAfter("a", 0, 10)).toEqual([]);
    expect(store.room("a")).toEqual({ epoch: before.epoch + 1, head: before.head, turn: 0 });
    // Nothing to undo across a reset, and the log continues past the old numbers.
    expect(code(() => store.undoTo("a", 0))).toBe("undo_out_of_range");
    const next = store.beginTurn("a");
    expect(next.turn).toBe(1);
    expect(next.appendEvent({ id: "x", ts: 4, kind: "narrative", turn: 1, data: {} }).seq).toBe(before.head + 1);
    expect(store.undoTo("a", 0).turn).toBe(0);
    expect(docIds(store, "a")).toEqual(["habit:pace", "lore:world", "sheet:ada"]);
  });

  test("chars: characters go too", () => {
    const { store } = memoryStore();
    populate(store, "a");
    store.reset("a", "chars", CATALOG);
    expect(docIds(store, "a")).toEqual(["habit:pace", "lore:world"]);
    expect([...store.stateList("a").keys()]).toEqual([ALL_KEY.name, NEVER_KEY.name].sort());
    expect(store.moduleStates("a").size).toBe(1);
  });

  test("all: the installed world and module checkpoints go; only `never` data survives", () => {
    const { store } = memoryStore();
    populate(store, "a");
    populate(store, "b");
    const other = dump(store, "b");
    store.reset("a", "all", CATALOG);
    expect(docIds(store, "a")).toEqual(["habit:pace"]);
    expect([...store.stateList("a").keys()]).toEqual([NEVER_KEY.name]);
    expect(store.moduleStates("a").size).toBe(0);
    expect(dump(store, "b")).toEqual(other);
  });

  test("a reset is driven by the declarations alone: a newly declared type needs no list edited", () => {
    const { store } = memoryStore();
    const catalog = { lifecycleOf: (type: string) => (type === "brand_new" ? ({ reset: "story" } as const) : CATALOG.lifecycleOf(type)) };
    store.writer("a").docPut("brand_new", "x", 1, "{}", "{}");
    store.reset("a", "story", catalog);
    expect(store.docList("a")).toEqual([]);
  });

  test("data no declaration covers refuses the reset and changes nothing", () => {
    const { store, db } = memoryStore();
    populate(store, "a");
    store.writer("a").docPut("mystery", "x", 1, "{}", "{}");
    const before = dump(store, "a");
    const meta = store.room("a");
    expect(code(() => store.reset("a", "all", CATALOG))).toBe("undeclared_document_type");
    store.writer("a").docDelete("mystery", "x");
    // A state row no code declares (an older build's leftover) is refused the same way.
    db.prepare("INSERT INTO room_state (room, key, value) VALUES (?, ?, ?)").run("a", "lc_test.forgotten", "x");
    expect(code(() => store.reset("a", "story", CATALOG))).toBe("undeclared_state_key");
    expect(code(() => store.reset("a", "everything" as ResetScope, CATALOG))).toBe("invalid_scope");
    expect(dump(store, "a").documents).toEqual(before.documents.filter((row) => row[1] !== "x"));
    expect(store.room("a").epoch).toBe(meta.epoch);
  });
});

describe("delete", () => {
  test("everything of the room goes; the record stays so generations and numbers never repeat", () => {
    const { store, db } = memoryStore();
    populate(store, "a");
    populate(store, "b");
    const other = dump(store, "b");
    const before = store.room("a");
    const stale = store.writer("a");
    expect(store.deleteRoom("a")).toMatchObject({ epoch: before.epoch + 1, head: before.head, turn: 0 });
    expect(dump(store, "a")).toEqual({ documents: [], state: [], modules: [], events: [] });
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE room = ?").get("a")?.n).toBe(0);
    expect(code(() => stale.docPut("note", "late", 1, "{}", "{}"))).toBe("stale_generation");
    expect(store.writer("a").appendEvent({ id: "new", ts: 9, kind: "narrative", data: {} }).seq).toBe(before.head + 1);
    expect(dump(store, "b")).toEqual(other);
  });
});

describe("export and import", () => {
  test("a round trip into another room reproduces the room, renumbered, with nothing to undo", () => {
    const { store } = memoryStore();
    populate(store, "a");
    store.writer("a").docPut("note", "broken", 1, "{not json", "{}");
    const bundle = store.exportRoom("a");
    expect(bundle.format).toBe(ROOM_BUNDLE_FORMAT);
    expect(bundle.version).toBe(ROOM_BUNDLE_VERSION);
    expect(bundle.turn).toBe(2);
    expect(JSON.stringify(bundle)).not.toContain("journal");
    const wire = JSON.parse(JSON.stringify(bundle)) as unknown;

    // The target has a life of its own first: more events, other content, an undo window.
    const target = store.writer("b");
    for (let n = 0; n < 10; n++) target.appendEvent({ id: `old${n}`, ts: n, kind: "narrative", data: {} });
    store.beginTurn("b").docPut("note", "left-over", 1, "{}", "{}");
    const before = store.room("b");

    const result = store.importRoom("b", wire, CATALOG);
    expect(result).toMatchObject({ epoch: before.epoch + 1, head: before.head + bundle.events.length, turn: 2 });
    expect(dump(store, "b")).toEqual(dump(store, "a"));
    expect(store.eventsAfter("b", 0, 10).map((event) => event.seq)).toEqual([11, 12, 13]);
    // The import is a full replacement: the target's own rows are gone, not merged.
    expect(store.docGet("b", "note", "left-over")).toBeNull();
    // The undo ring does not survive an import: no `.undo` back into the pre-import room.
    expect(store.undoFloor("b")).toBe(2);
    expect(code(() => store.undoTo("b", 1))).toBe("undo_beyond_depth");
    // Play continues from the bundle's turn, and can be undone back to the import point.
    store.beginTurn("b").statePut(STORY_KEY, "scene 3");
    store.undoTo("b", 2);
    expect(store.stateGet("b", STORY_KEY)).toBe("scene 2");
    expect(store.exportRoom("b")).toEqual(bundle);
  });

  test("a bundle that fails validation changes nothing at all", () => {
    const { store } = memoryStore();
    populate(store, "a");
    const good = store.exportRoom("a");
    populate(store, "b");
    const before = dump(store, "b");
    const meta = store.room("b");
    const bad: [unknown, string][] = [
      [null, "invalid_bundle"],
      [{ ...good, format: "other" }, "invalid_bundle"],
      [{ ...good, version: 2 }, "invalid_bundle"],
      [{ ...good, turn: -1 }, "invalid_bundle"],
      [{ ...good, documents: "x" }, "invalid_bundle"],
      [{ ...good, documents: [...good.documents, { type: "mystery", id: "x", version: 1, data: "{}", meta: "{}" }] }, "undeclared_document_type"],
      [{ ...good, documents: [...good.documents, good.documents[0]] }, "invalid_bundle"],
      [{ ...good, documents: [...good.documents, { type: "note", id: "", version: 1, data: "{}", meta: "{}" }] }, "invalid_bundle"],
      [{ ...good, documents: [...good.documents, { type: "note", id: "v", version: 0, data: "{}", meta: "{}" }] }, "invalid_bundle"],
      [{ ...good, state: [...good.state, { key: "lc_test.nobody", value: "x" }] }, "undeclared_state_key"],
      [{ ...good, state: [...good.state, good.state[0]] }, "invalid_bundle"],
      [{ ...good, modules: [{ module: "clock", snapshot: "{not json" }] }, "invalid_bundle"],
      [{ ...good, events: [...good.events, { id: "e", ts: 1, kind: "narrative", turn: 3, data: {} }] }, "invalid_bundle"],
      [{ ...good, events: [...good.events, { id: "e", ts: 1, kind: "narrative", data: Number.NaN }] }, "invalid_bundle"],
      [{ ...good, events: [...good.events, { id: "e", ts: 1, kind: "narrative" }] }, "invalid_bundle"],
    ];
    for (const [bundle, expected] of bad) {
      expect(code(() => store.importRoom("b", bundle, CATALOG))).toBe(expected);
      expect(dump(store, "b")).toEqual(before);
      expect(store.room("b")).toEqual(meta);
    }
  });

  test("validation names the place of the problem, and a type's own check can refuse a payload", () => {
    const { store } = memoryStore();
    populate(store, "a");
    const good = store.exportRoom("a");
    let caught: unknown = null;
    try {
      parseBundle({ ...good, events: [{ id: "e", ts: 1, kind: "narrative", turn: 9, data: {} }] }, CATALOG);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LifecycleError);
    expect(caught).toMatchObject({ code: "invalid_bundle", path: "events[0].turn" });
    const strict = { ...CATALOG, check: (type: string) => (type === "sheet" ? "hp_required" : null) };
    expect(code(() => store.importRoom("b", good, strict))).toBe("invalid_bundle");
    expect(store.docList("b")).toEqual([]);
  });
});

describe("the storages outside the store", () => {
  function recorder() {
    const calls: string[] = [];
    const storages = new RoomStorages();
    const add = (name: string, lifecycle: Lifecycle, fail = false) =>
      storages.register({
        name,
        lifecycle,
        clear: (room: string, event: RoomStorageEvent) => {
          if (fail) throw new Error("disk full");
          calls.push(`${name}:${room}:${event.kind}:${event.epoch}`);
        },
      });
    add("vectors", { reset: "story" });
    add("portraits", { reset: "chars" });
    add("media", { reset: "all" });
    add("keys", { reset: "never", because: "wiring, not campaign content" });
    return { calls, storages, add };
  }

  test("each operation tells exactly the storages its declarations cover, after committing", () => {
    const { calls, storages } = recorder();
    const { store } = memoryStore({ storages });
    populate(store, "a");
    expect(store.reset("a", "story", CATALOG).storages.cleared).toEqual(["vectors"]);
    expect(store.reset("a", "chars", CATALOG).storages.cleared).toEqual(["vectors", "portraits"]);
    expect(store.reset("a", "all", CATALOG).storages.cleared).toEqual(["vectors", "portraits", "media"]);
    expect(store.importRoom("a", store.exportRoom("x"), CATALOG).storages.cleared).toEqual(["vectors", "portraits", "media"]);
    expect(store.deleteRoom("a").storages.cleared).toEqual(["vectors", "portraits", "media", "keys"]);
    // Each was told the room's new generation.
    expect(calls.slice(0, 1)).toEqual(["vectors:a:reset:2"]);
    expect(calls.at(-1)).toBe("keys:a:delete:6");
    // Undo is not a storage event: it returns what changed, and the caller reconciles.
    calls.length = 0;
    store.beginTurn("a");
    store.undoTo("a", 0);
    expect(calls).toEqual([]);
  });

  test("a storage that fails is reported, the others are still told, and the room change stands", () => {
    const { storages, add } = recorder();
    add("broken", { reset: "story" }, true);
    const { store } = memoryStore({ storages });
    populate(store, "a");
    const result = store.reset("a", "story", CATALOG);
    expect(result.storages.cleared).toEqual(["vectors"]);
    expect(result.storages.failed.map((failure) => failure.name)).toEqual(["broken"]);
    expect(store.eventsAfter("a", 0, 10)).toEqual([]);
  });

  test("a storage is registered once, with a well-formed lifecycle", () => {
    const { add } = recorder();
    expect(code(() => add("vectors", { reset: "story" }))).toBe("storage_conflict");
    expect(code(() => add("nameless-reason", { reset: "never", because: "" }))).toBe("invalid_lifecycle");
  });
});

test("an exported bundle is a plain value the parser accepts as it is", () => {
  const { store } = memoryStore();
  populate(store, "a");
  const bundle: RoomBundle = store.exportRoom("a");
  expect(parseBundle(JSON.parse(JSON.stringify(bundle)), CATALOG)).toEqual(bundle);
});
