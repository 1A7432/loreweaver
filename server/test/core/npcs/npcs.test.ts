import { describe, expect, test } from "bun:test";

import { actorViewer, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import {
  createNpc,
  learn,
  MAX_FACT_CHARS,
  MAX_KNOWLEDGE_FACTS,
  moveNpc,
  type Npc,
  npcData,
  npcDocument,
  npcSlug,
  readNpc,
  reviseNpc,
  setDisposition,
  setKnowledge,
  sketchNpc,
} from "../../../src/core/npcs/index.ts";

function ok(result: { ok: true; data: Npc } | { ok: false; code: string }): Npc {
  if (!result.ok) throw new Error(result.code);
  return result.data;
}

function doc(data: JsonObject, id: string): Document {
  return { type: "npc", id, version: 1, data, meta: {}, corrupt: false };
}

const SECRET_MARKERS = ["PERSONA-SECRET-MARKER", "STYLE-SECRET-MARKER", "AGENDA-SECRET-MARKER", "FACT-SECRET-MARKER", "DISPOSITION-SECRET-MARKER", "LOCATION-SECRET-MARKER"];

const villain = ok(
  createNpc({
    name: "Mr. Hale",
    publicDescription: "A tall man in a grey coat.",
    persona: "PERSONA-SECRET-MARKER",
    style: "STYLE-SECRET-MARKER",
    secretAgenda: "AGENDA-SECRET-MARKER",
    knowledge: ["FACT-SECRET-MARKER"],
    disposition: "DISPOSITION-SECRET-MARKER",
    location: "LOCATION-SECRET-MARKER",
  }),
);
const villainDoc = doc(npcData(villain), "hale");

const others: readonly [string, Viewer][] = [
  ["admin", { grade: "admin", memberId: "m-admin", locale: "en" }],
  ["player", playerViewer("en", "m1")],
  ["anonymous player", playerViewer("en")],
  ["observer", { grade: "observer", locale: "en" }],
  ["another NPC actor", actorViewer("maid", "en")],
  ["an admin-grade actor of another NPC", { grade: "admin", actorId: "maid", locale: "en" }],
];

describe("who sees what of an NPC (sentinels)", () => {
  test("the Keeper and the NPC itself see the whole record", () => {
    for (const viewer of [KEEPER, actorViewer("hale", "en")]) {
      const text = JSON.stringify(npcDocument.project(villainDoc, viewer));
      for (const marker of SECRET_MARKERS) expect(text).toContain(marker);
    }
  });

  test("the table and every other actor see only what is public", () => {
    for (const [label, viewer] of others) {
      const view = npcDocument.project(villainDoc, viewer);
      const text = JSON.stringify(view);
      for (const marker of SECRET_MARKERS) expect(text, `${label} saw ${marker}`).not.toContain(marker);
      expect(view).toEqual({ name: "Mr. Hale", publicDescription: "A tall man in a grey coat.", location: null });
    }
  });

  test("a location the table knows is public; an unknown one is not", () => {
    const seen = ok(moveNpc(villain, "the docks", true));
    expect(npcDocument.project(doc(npcData(seen), "hale"), playerViewer("en"))).toMatchObject({ location: "the docks" });
    const hidden = ok(moveNpc(seen, "LOCATION-SECRET-MARKER", false));
    expect(JSON.stringify(npcDocument.project(doc(npcData(hidden), "hale"), playerViewer("en")))).not.toContain("LOCATION-SECRET-MARKER");
  });

  test("an actor with the same id as another type's document gains nothing here", () => {
    // Only the NPC whose document id IS the actor id opens up; a near miss does not.
    for (const id of ["Hale", "hale ", "hal"]) {
      expect(JSON.stringify(npcDocument.project(villainDoc, actorViewer(id, "en")))).not.toContain("AGENDA-SECRET-MARKER");
    }
  });

  test("a field added to the payload later stays private", () => {
    const later = doc({ ...npcData(villain), relationships: "LATER-SECRET-MARKER" }, "hale");
    for (const [, viewer] of others) expect(JSON.stringify(npcDocument.project(later, viewer))).not.toContain("LATER-SECRET-MARKER");
  });

  test("a malformed payload shows nothing to anyone", () => {
    const broken = doc({ ...npcData(villain), knowledge: "FACT-SECRET-MARKER" }, "hale");
    for (const viewer of [KEEPER, ...others.map(([, v]) => v)]) expect(npcDocument.project(broken, viewer)).toBeNull();
  });
});

describe("the Keeper's NPC changes", () => {
  test("create fills defaults; sketch makes a major NPC from one line", () => {
    const npc = ok(createNpc({ name: "  Old Tom  " }));
    expect(npc).toEqual({
      name: "Old Tom",
      publicDescription: "",
      persona: "",
      style: "",
      secretAgenda: "",
      knowledge: [],
      disposition: "",
      location: "",
      locationKnown: false,
      major: true,
    });
    const sketch = ok(sketchNpc("Shopkeeper", "nervous, owes the docks money"));
    expect([sketch.persona, sketch.major]).toEqual(["nervous, owes the docks money", true]);
    expect(createNpc({ name: "" })).toEqual({ ok: false, code: "bad_name" });
    expect(createNpc({ name: "x", persona: "p".repeat(2001) })).toEqual({ ok: false, code: "bad_persona" });
  });

  test("learning: one fact, repeats ignored, capped, never mutating", () => {
    const npc = ok(createNpc({ name: "Tom" }));
    const learned = ok(learn(npc, " the key is under the mat "));
    expect(learned.knowledge).toEqual(["the key is under the mat"]);
    expect(npc.knowledge).toEqual([]);
    expect(learn(learned, "the key is under the mat")).toEqual({ ok: true, data: learned });
    expect(learn(npc, "")).toEqual({ ok: false, code: "bad_fact" });
    expect(learn(npc, "字".repeat(MAX_FACT_CHARS + 1))).toEqual({ ok: false, code: "bad_fact" });
    expect(learn(npc, "字".repeat(MAX_FACT_CHARS)).ok).toBe(true);
    const full = ok(setKnowledge(npc, Array.from({ length: MAX_KNOWLEDGE_FACTS }, (_, i) => `fact ${i}`)));
    expect(learn(full, "one more")).toEqual({ ok: false, code: "knowledge_full" });
    expect(setKnowledge(npc, Array.from({ length: MAX_KNOWLEDGE_FACTS + 1 }, (_, i) => `fact ${i}`))).toEqual({ ok: false, code: "knowledge_full" });
  });

  test("move, disposition and revise keep the name and the rest", () => {
    const npc = ok(createNpc({ name: "Tom", secretAgenda: "keep the ledger hidden" }));
    const moved = ok(moveNpc(npc, "the mill", true));
    expect([moved.location, moved.locationKnown, moved.secretAgenda]).toEqual(["the mill", true, "keep the ledger hidden"]);
    expect(moveNpc(npc, "l".repeat(121), true)).toEqual({ ok: false, code: "bad_location" });
    expect(ok(setDisposition(npc, "wary")).disposition).toBe("wary");
    expect(setDisposition(npc, "d".repeat(81))).toEqual({ ok: false, code: "bad_disposition" });
    const revised = ok(reviseNpc(npc, { major: false, style: "clipped" }));
    expect([revised.name, revised.major, revised.style]).toEqual(["Tom", false, "clipped"]);
  });

  test("slugs keep letters of every script and drop the rest", () => {
    expect(npcSlug("Mr. Hale")).toBe("mr-hale");
    expect(npcSlug("织田 信长")).toBe("织田-信长");
    expect(npcSlug("__proto__")).toBe("proto");
    expect(npcSlug("!!!")).toBeNull();
  });

  test("the payload reads back; the stored record validates; lifecycle is story", () => {
    expect(readNpc(npcData(villain))).toEqual(villain);
    expect(npcDocument.validate?.(npcData(villain))).toEqual([]);
    const codes = (data: JsonObject) => (npcDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes({ ...npcData(villain), extra: 1 })).toEqual(["unknown_field"]);
    expect(codes({ ...npcData(villain), name: " Mr. Hale " })).toEqual(["not_normalized"]);
    expect(codes({ ...npcData(villain), knowledge: ["a", "a"] })).toEqual(["not_normalized"]);
    expect(codes({ ...npcData(villain), major: "yes" })).toEqual(["malformed"]);
    expect(codes({ ...npcData(villain), secretAgenda: "s".repeat(2001) })).toEqual(["bad_secret_agenda"]);
    expect(npcDocument.lifecycle).toEqual({ reset: "story" });
  });
});
