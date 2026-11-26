import { expect, test } from "bun:test";

import { actorViewer, DocumentTypes, DocumentViews, KEEPER, playerViewer, type Document, type DocumentType, type Viewer } from "../../../src/core/documents/index.ts";
import { documentCatalog, DocumentRefused, RawDocuments } from "../../../src/core/documents/raw.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { textStateKey } from "../../../src/infra/lifecycle/declarations.ts";
import { StaleGeneration } from "../../../src/infra/lifecycle/errors.ts";
import { Store } from "../../../src/infra/store.ts";

// A type with a split payload, as lore and NPC records have: a part for the table and
// a part only the Keeper (and the NPC itself) may see.
const npc: DocumentType<{ name: string; secret?: string }> = {
  name: "npc",
  lifecycle: { reset: "story" },
  version: 2,
  project(document: Document, viewer: Viewer) {
    const name = String(document.data.name ?? "");
    const whole = viewer.grade === "keeper" || viewer.actorId === document.id;
    return whole ? { name, secret: String(document.data.secret ?? "") } : { name };
  },
  validate(data) {
    return typeof data.name === "string" && data.name.length > 0 ? [] : [{ code: "name_required", path: "name" }];
  },
  migrate(data, from) {
    return from < 2 ? { ...data, name: String(data.title ?? "") } : data;
  },
};

// A type that simply does not exist for the table.
const note: DocumentType<{ text: string }> = {
  name: "keeper_note",
  lifecycle: { reset: "story" },
  version: 1,
  project: (document, viewer) => (viewer.grade === "keeper" ? { text: String(document.data.text ?? "") } : null),
};

function setup() {
  const store = new Store(openDatabase(":memory:"));
  const types = new DocumentTypes().register(npc).register(note);
  const w = (room: string) => store.writer(room);
  return { store, w, raw: new RawDocuments(store, types), views: new DocumentViews(store, types) };
}

const PLAYER = playerViewer("en");

test("a viewer gets their own part of a document, and nothing of one that is not theirs", () => {
  const { raw, views, w } = setup();
  raw.put(w("r"), "npc", "mayor", { name: "The Mayor", secret: "embezzles" });
  raw.put(w("r"), "keeper_note", "n1", { text: "the mayor did it" });

  expect(views.view("r", "npc", "mayor", KEEPER)).toEqual({ name: "The Mayor", secret: "embezzles" });
  expect(views.view("r", "npc", "mayor", PLAYER)).toEqual({ name: "The Mayor" });
  expect(views.view("r", "npc", "mayor", { grade: "admin", locale: "en" })).toEqual({ name: "The Mayor" });
  expect(views.view("r", "npc", "mayor", { grade: "observer", locale: "en" })).toEqual({ name: "The Mayor" });
  expect(views.view("r", "keeper_note", "n1", PLAYER)).toBeNull();
  expect(views.views("r", "keeper_note", PLAYER)).toEqual([]);
  expect(views.views("r", "keeper_note", KEEPER)).toHaveLength(1);
});

test("an NPC actor sees its own record whole and every other at player grade", () => {
  const { raw, views, w } = setup();
  raw.put(w("r"), "npc", "mayor", { name: "The Mayor", secret: "embezzles" });
  raw.put(w("r"), "npc", "clerk", { name: "The Clerk", secret: "knows" });
  const clerk = actorViewer("clerk", "en");
  expect(views.view("r", "npc", "clerk", clerk)).toEqual({ name: "The Clerk", secret: "knows" });
  expect(views.view("r", "npc", "mayor", clerk)).toEqual({ name: "The Mayor" });
});

test("documents list in the order they were first written, and a rewrite keeps its place", () => {
  const { raw, views, w } = setup();
  for (const id of ["10", "2", "constructor", "b"]) raw.put(w("r"), "npc", id, { name: id });
  raw.put(w("r"), "npc", "2", { name: "two" });
  expect(views.views("r", "npc", PLAYER).map((entry) => entry.id)).toEqual(["10", "2", "constructor", "b"]);
  expect(raw.list("other", "npc")).toEqual([]);
});

test("a write the type refuses stores nothing", () => {
  const { raw, w } = setup();
  expect(() => raw.put(w("r"), "npc", "x", { name: "" })).toThrow(DocumentRefused);
  expect(raw.get("r", "npc", "x")).toBeNull();
  expect(() => raw.put(w("r"), "no_such_type", "x", {})).toThrow("unknown document type");
});

test("a payload that cannot be read is flagged, and has no view for anyone", () => {
  const { raw, views, w } = setup();
  w("r").docPut("npc", "broken", 2, "{not json", "{}");
  w("r").docPut("npc", "array", 2, "[1,2]", "{}");
  expect(raw.get("r", "npc", "broken")).toMatchObject({ corrupt: true, data: {} });
  expect(raw.get("r", "npc", "array")?.corrupt).toBe(true);
  expect(views.view("r", "npc", "broken", KEEPER)).toBeNull();
  expect(views.views("r", "npc", PLAYER)).toEqual([]);
});

test("a payload written by an older version is brought up to date when read", () => {
  const { raw, w } = setup();
  w("r").docPut("npc", "old", 1, JSON.stringify({ title: "Old Tom" }), "{}");
  expect(raw.get("r", "npc", "old")).toMatchObject({ version: 2, data: { title: "Old Tom", name: "Old Tom" } });
});

test("deleting a type or a room leaves the rest alone", () => {
  const { store, raw, w } = setup();
  raw.put(w("a"), "npc", "x", { name: "x" });
  raw.put(w("a"), "keeper_note", "n", { text: "t" });
  raw.put(w("b"), "npc", "y", { name: "y" });
  raw.deleteType(w("a"), "npc");
  expect(raw.all("a").map((document) => document.type)).toEqual(["keeper_note"]);
  store.deleteRoom("a");
  expect(raw.all("a")).toEqual([]);
  expect(raw.all("b")).toHaveLength(1);
});

const TURN_KEY = textStateKey("documents_test.turn", { reset: "story" });
const PROTO_KEY = textStateKey("constructor", { reset: "story" });

test("room state is small text values by declared key, per room", () => {
  const { store, w } = setup();
  w("a").statePut(TURN_KEY, "3");
  w("a").statePut(TURN_KEY, "4");
  w("a").statePut(PROTO_KEY, "x");
  expect(store.stateGet("a", TURN_KEY)).toBe("4");
  expect(store.stateGet("b", TURN_KEY)).toBeNull();
  expect(store.stateList("a")).toEqual(new Map([["constructor", "x"], ["documents_test.turn", "4"]]));
  store.deleteRoom("a");
  expect(store.stateList("a").size).toBe(0);
});

test("a document write from a past generation is refused, and the catalog carries each type's lifecycle and check", () => {
  const { store, raw, w } = setup();
  const lane = store.beginTurn("r");
  raw.put(lane, "npc", "mayor", { name: "The Mayor" });
  store.undoTo("r", 0);
  expect(() => raw.put(lane, "npc", "mayor", { name: "Late" })).toThrow(StaleGeneration);
  expect(raw.get("r", "npc", "mayor")).toBeNull();

  const catalog = documentCatalog(new DocumentTypes().register(npc).register(note));
  expect(catalog.lifecycleOf("npc")).toEqual({ reset: "story" });
  expect(catalog.lifecycleOf("no_such_type")).toBeUndefined();
  expect(catalog.check?.("npc", 2, JSON.stringify({ name: "ok" }))).toBeNull();
  expect(catalog.check?.("npc", 2, JSON.stringify({ name: "" }))).toBe("name_required");
  expect(catalog.check?.("npc", 1, JSON.stringify({ title: "Old Tom" }))).toBeNull();
  expect(catalog.check?.("npc", 3, "{}")).toBe("version_ahead");
  expect(catalog.check?.("npc", 2, "{not json")).toBeNull();

  raw.put(w("r"), "npc", "clerk", { name: "The Clerk" });
  store.reset("r", "story", catalog);
  expect(raw.all("r")).toEqual([]);
});
