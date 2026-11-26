import { expect, test } from "bun:test";

import { actorViewer, DocumentTypes, DocumentViews, KEEPER, playerViewer, type Document, type DocumentType, type Viewer } from "../../../src/core/documents/index.ts";
import { DocumentRefused, RawDocuments } from "../../../src/core/documents/raw.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { Store } from "../../../src/infra/store.ts";

// A type with a split payload, as lore and NPC records have: a part for the table and
// a part only the Keeper (and the NPC itself) may see.
const npc: DocumentType<{ name: string; secret?: string }> = {
  name: "npc",
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
  version: 1,
  project: (document, viewer) => (viewer.grade === "keeper" ? { text: String(document.data.text ?? "") } : null),
};

function setup() {
  const store = new Store(openDatabase(":memory:"));
  const types = new DocumentTypes().register(npc).register(note);
  return { store, raw: new RawDocuments(store, types), views: new DocumentViews(store, types) };
}

const PLAYER = playerViewer("en");

test("a viewer gets their own part of a document, and nothing of one that is not theirs", () => {
  const { raw, views } = setup();
  raw.put("r", "npc", "mayor", { name: "The Mayor", secret: "embezzles" });
  raw.put("r", "keeper_note", "n1", { text: "the mayor did it" });

  expect(views.view("r", "npc", "mayor", KEEPER)).toEqual({ name: "The Mayor", secret: "embezzles" });
  expect(views.view("r", "npc", "mayor", PLAYER)).toEqual({ name: "The Mayor" });
  expect(views.view("r", "npc", "mayor", { grade: "admin", locale: "en" })).toEqual({ name: "The Mayor" });
  expect(views.view("r", "npc", "mayor", { grade: "observer", locale: "en" })).toEqual({ name: "The Mayor" });
  expect(views.view("r", "keeper_note", "n1", PLAYER)).toBeNull();
  expect(views.views("r", "keeper_note", PLAYER)).toEqual([]);
  expect(views.views("r", "keeper_note", KEEPER)).toHaveLength(1);
});

test("an NPC actor sees its own record whole and every other at player grade", () => {
  const { raw, views } = setup();
  raw.put("r", "npc", "mayor", { name: "The Mayor", secret: "embezzles" });
  raw.put("r", "npc", "clerk", { name: "The Clerk", secret: "knows" });
  const clerk = actorViewer("clerk", "en");
  expect(views.view("r", "npc", "clerk", clerk)).toEqual({ name: "The Clerk", secret: "knows" });
  expect(views.view("r", "npc", "mayor", clerk)).toEqual({ name: "The Mayor" });
});

test("documents list in the order they were first written, and a rewrite keeps its place", () => {
  const { raw, views } = setup();
  for (const id of ["10", "2", "constructor", "b"]) raw.put("r", "npc", id, { name: id });
  raw.put("r", "npc", "2", { name: "two" });
  expect(views.views("r", "npc", PLAYER).map((entry) => entry.id)).toEqual(["10", "2", "constructor", "b"]);
  expect(raw.list("other", "npc")).toEqual([]);
});

test("a write the type refuses stores nothing", () => {
  const { raw } = setup();
  expect(() => raw.put("r", "npc", "x", { name: "" })).toThrow(DocumentRefused);
  expect(raw.get("r", "npc", "x")).toBeNull();
  expect(() => raw.put("r", "no_such_type", "x", {})).toThrow("unknown document type");
});

test("a payload that cannot be read is flagged, and has no view for anyone", () => {
  const { store, raw, views } = setup();
  store.docPut("r", "npc", "broken", 2, "{not json", "{}");
  store.docPut("r", "npc", "array", 2, "[1,2]", "{}");
  expect(raw.get("r", "npc", "broken")).toMatchObject({ corrupt: true, data: {} });
  expect(raw.get("r", "npc", "array")?.corrupt).toBe(true);
  expect(views.view("r", "npc", "broken", KEEPER)).toBeNull();
  expect(views.views("r", "npc", PLAYER)).toEqual([]);
});

test("a payload written by an older version is brought up to date when read", () => {
  const { store, raw } = setup();
  store.docPut("r", "npc", "old", 1, JSON.stringify({ title: "Old Tom" }), "{}");
  expect(raw.get("r", "npc", "old")).toMatchObject({ version: 2, data: { title: "Old Tom", name: "Old Tom" } });
});

test("deleting a type or a room leaves the rest alone", () => {
  const { raw } = setup();
  raw.put("a", "npc", "x", { name: "x" });
  raw.put("a", "keeper_note", "n", { text: "t" });
  raw.put("b", "npc", "y", { name: "y" });
  raw.deleteType("a", "npc");
  expect(raw.all("a").map((document) => document.type)).toEqual(["keeper_note"]);
  raw.deleteRoom("a");
  expect(raw.all("a")).toEqual([]);
  expect(raw.all("b")).toHaveLength(1);
});

test("room state is small text values by key, per room", () => {
  const { store } = setup();
  store.statePut("a", "turn", "3");
  store.statePut("a", "turn", "4");
  store.statePut("a", "constructor", "x");
  expect(store.stateGet("a", "turn")).toBe("4");
  expect(store.stateGet("b", "turn")).toBeNull();
  expect(store.stateList("a")).toEqual(new Map([["constructor", "x"], ["turn", "4"]]));
  store.stateDeleteRoom("a");
  expect(store.stateList("a").size).toBe(0);
});
