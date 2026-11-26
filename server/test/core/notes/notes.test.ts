import { describe, expect, test } from "bun:test";

import { actorViewer, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import {
  addNote,
  dropCategory,
  EMPTY_INTENTS,
  EMPTY_NOTES,
  EMPTY_SCENE,
  establishFact,
  intentLogData,
  intentsOf,
  type IntentLog,
  type KeeperNotes,
  keeperNotesData,
  keeperNotesDocument,
  MAX_ESTABLISHED_FACTS,
  MAX_INTENT_LOG,
  MAX_NOTE_CATEGORIES,
  MAX_NOTES_PER_CATEGORY,
  notesIn,
  npcIntentsDocument,
  readIntentLog,
  readKeeperNotes,
  readScene,
  recordIntent,
  retractFact,
  reviseLastNote,
  type Scene,
  sceneData,
  sceneDocument,
  setNote,
  setSceneFocus,
  setSceneName,
} from "../../../src/core/notes/index.ts";

function ok<T>(result: { ok: true; data: T } | { ok: false; code: string }): T {
  if (!result.ok) throw new Error(result.code);
  return result.data;
}

function doc(type: string, data: JsonObject): Document {
  return { type, id: "only", version: 1, data, meta: {}, corrupt: false };
}

const nonKeepers: readonly Viewer[] = [
  { grade: "admin", memberId: "m-admin", locale: "en" },
  playerViewer("en", "m1"),
  { grade: "observer", locale: "en" },
  actorViewer("hale", "en"),
];

describe("the Keeper's notebook", () => {
  test("add, set, revise, drop, by category in first-written order", () => {
    let notes: KeeperNotes = EMPTY_NOTES;
    notes = ok(addNote(notes, "npc_status", "Hale is wounded", "D2 10:00"));
    notes = ok(addNote(notes, "world_changes", "the bridge is out", null));
    notes = ok(addNote(notes, "npc_status", "Tom fled", null));
    expect(notes.categories.map((c) => c.name)).toEqual(["npc_status", "world_changes"]);
    expect(notesIn(notes, "npc_status").map((n) => n.text)).toEqual(["Hale is wounded", "Tom fled"]);
    const set = ok(setNote(notes, "npc_status", "everyone fled", null));
    expect(notesIn(set, "npc_status").map((n) => n.text)).toEqual(["everyone fled"]);
    const revised = ok(reviseLastNote(notes, "npc_status", "Tom fled north"));
    expect(notesIn(revised, "npc_status")).toEqual([
      { text: "Hale is wounded", at: "D2 10:00" },
      { text: "Tom fled north", at: null },
    ]);
    expect(notesIn(notes, "npc_status")[1]?.text).toBe("Tom fled");
    expect(reviseLastNote(notes, "nope", "x")).toEqual({ ok: false, code: "unknown_category" });
    const dropped = ok(dropCategory(notes, "npc_status"));
    expect(dropped.categories.map((c) => c.name)).toEqual(["world_changes"]);
    expect(dropCategory(notes, "nope")).toEqual({ ok: false, code: "unknown_category" });
  });

  test("hostile category names are ordinary and keep their order", () => {
    let notes = EMPTY_NOTES;
    for (const name of ["__proto__", "10", "constructor", "2"]) notes = ok(addNote(notes, name, `note in ${name}`, null));
    const back = readKeeperNotes(keeperNotesData(notes));
    expect(back?.categories.map((c) => c.name)).toEqual(["__proto__", "10", "constructor", "2"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("caps refuse rather than truncate", () => {
    expect(addNote(EMPTY_NOTES, "", "x", null)).toEqual({ ok: false, code: "bad_category" });
    expect(addNote(EMPTY_NOTES, "c".repeat(49), "x", null)).toEqual({ ok: false, code: "bad_category" });
    expect(addNote(EMPTY_NOTES, "c", "n".repeat(1001), null)).toEqual({ ok: false, code: "bad_note" });
    expect(addNote(EMPTY_NOTES, "c", "x", " padded ")).toEqual({ ok: false, code: "bad_at" });
    let full = EMPTY_NOTES;
    for (let i = 0; i < MAX_NOTES_PER_CATEGORY; i++) full = ok(addNote(full, "c", `n${i}`, null));
    expect(addNote(full, "c", "late", null)).toEqual({ ok: false, code: "category_full" });
    let many = EMPTY_NOTES;
    for (let i = 0; i < MAX_NOTE_CATEGORIES; i++) many = ok(addNote(many, `c${i}`, "n", null));
    expect(addNote(many, "late", "n", null)).toEqual({ ok: false, code: "too_many_categories" });
  });

  test("it exists for the Keeper alone (sentinel)", () => {
    const notes = ok(addNote(EMPTY_NOTES, "reasoning", "NOTE-SECRET-MARKER", null));
    const document = doc("keeper_notes", keeperNotesData(notes));
    expect(JSON.stringify(keeperNotesDocument.project(document, KEEPER))).toContain("NOTE-SECRET-MARKER");
    for (const viewer of nonKeepers) expect(keeperNotesDocument.project(document, viewer)).toBeNull();
  });

  test("validation and lifecycle", () => {
    const notes = ok(addNote(EMPTY_NOTES, "c", "n", null));
    const codes = (data: JsonObject) => (keeperNotesDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(keeperNotesData(notes))).toEqual([]);
    expect(codes({ categories: [{ name: "c", entries: [] }] })).toEqual(["bad_entries"]);
    expect(codes({ categories: [{ name: "c", entries: [{ text: "a", at: null }] }, { name: "c", entries: [{ text: "b", at: null }] }] })).toEqual(["duplicate_category"]);
    expect(codes({ categories: [{ name: "c", entries: [{ text: " a ", at: null }] }] })).toEqual(["bad_note"]);
    expect(keeperNotesDocument.lifecycle).toEqual({ reset: "story" });
  });
});

describe("the scene card", () => {
  test("name, focus and established facts", () => {
    let scene: Scene = EMPTY_SCENE;
    scene = ok(setSceneName(scene, "The Mill"));
    scene = ok(setSceneFocus(scene, "searching the cellar"));
    scene = ok(establishFact(scene, "the mill burned on the 3rd", "D3 22:00"));
    expect(ok(establishFact(scene, "the mill burned on the 3rd", null))).toBe(scene);
    expect(scene).toEqual({ name: "The Mill", focus: "searching the cellar", established: [{ text: "the mill burned on the 3rd", at: "D3 22:00" }] });
    expect(ok(setSceneName(scene, "")).name).toBe("");
    expect(ok(retractFact(scene, "the mill burned on the 3rd")).established).toEqual([]);
    expect(retractFact(scene, "nope")).toEqual({ ok: false, code: "unknown_fact" });
    expect(setSceneName(scene, "n".repeat(121))).toEqual({ ok: false, code: "bad_name" });
    let full = EMPTY_SCENE;
    for (let i = 0; i < MAX_ESTABLISHED_FACTS; i++) full = ok(establishFact(full, `fact ${i}`, null));
    expect(establishFact(full, "late", null)).toEqual({ ok: false, code: "facts_full" });
    expect(readScene(sceneData(scene))).toEqual(scene);
  });

  test("every viewer sees the scene — and only its named fields", () => {
    const scene = ok(establishFact(ok(setSceneName(EMPTY_SCENE, "The Mill")), "fact", null));
    const document = doc("scene", { ...sceneData(scene), keeperAside: "LATER-SECRET-MARKER" });
    const expected = { name: "The Mill", focus: "", established: [{ text: "fact", at: null }] };
    for (const viewer of [KEEPER, ...nonKeepers]) {
      expect(sceneDocument.project(document, viewer)).toEqual(expected);
      expect(JSON.stringify(sceneDocument.project(document, viewer))).not.toContain("LATER-SECRET-MARKER");
    }
    const codes = (data: JsonObject) => (sceneDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(sceneData(scene))).toEqual([]);
    expect(codes({ ...sceneData(scene), keeperAside: "x" })).toEqual(["unknown_field"]);
    expect(sceneDocument.lifecycle).toEqual({ reset: "story" });
  });
});

describe("NPC intent notes", () => {
  test("recorded per NPC, rolling at the cap, single intents capped", () => {
    let log: IntentLog = EMPTY_INTENTS;
    log = ok(recordIntent(log, "hale", "slip out the back", "D1 09:00"));
    log = ok(recordIntent(log, "tom", "warn the mayor", null));
    expect(intentsOf(log, "hale").map((i) => i.intent)).toEqual(["slip out the back"]);
    for (let i = 0; i < MAX_INTENT_LOG; i++) log = ok(recordIntent(log, "tom", `step ${i}`, null));
    expect(log.intents.length).toBe(MAX_INTENT_LOG);
    expect(log.intents.at(-1)?.intent).toBe(`step ${MAX_INTENT_LOG - 1}`);
    expect(intentsOf(log, "hale")).toEqual([]);
    expect(recordIntent(log, "hale", "i".repeat(501), null)).toEqual({ ok: false, code: "bad_intent" });
    expect(recordIntent(log, "", "x", null)).toEqual({ ok: false, code: "bad_npc" });
    expect(readIntentLog(intentLogData(log))).toEqual(log);
  });

  test("Keeper only — the NPC that stated it included (sentinel)", () => {
    const log = ok(recordIntent(EMPTY_INTENTS, "hale", "INTENT-SECRET-MARKER", null));
    const document = doc("npc_intents", intentLogData(log));
    expect(JSON.stringify(npcIntentsDocument.project(document, KEEPER))).toContain("INTENT-SECRET-MARKER");
    for (const viewer of nonKeepers) expect(npcIntentsDocument.project(document, viewer)).toBeNull();
    const codes = (data: JsonObject) => (npcIntentsDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(intentLogData(log))).toEqual([]);
    expect(codes({ intents: Array.from({ length: MAX_INTENT_LOG + 1 }, () => ({ npc: "a", intent: "b", at: null })) })).toEqual(["too_many_intents"]);
    expect(npcIntentsDocument.lifecycle).toEqual({ reset: "story" });
  });
});
