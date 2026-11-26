import { describe, expect, test } from "bun:test";

import { actorViewer, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import {
  adjustRelationship,
  changedRelationships,
  MAX_RELATIONSHIP_ROWS,
  NO_RELATIONSHIPS,
  readRelationships,
  relationshipsData,
  relationshipsDocumentType,
  relationshipValue,
  setRelationship,
  validateRelationships,
  type RelationshipChange,
  type Relationships,
} from "../../../src/core/relationships/index.ts";

function state(change: RelationshipChange): Relationships {
  if (!change.ok) throw new Error(`refused: ${change.code}`);
  return change.data;
}

function doc(data: JsonObject): Document {
  return { type: relationshipsDocumentType.name, id: "relationships", version: 1, data, meta: {}, corrupt: false };
}

describe("relationship tracks", () => {
  test("adjust and set are deterministic, held within the track's bounds, and never mutate", () => {
    const first = adjustRelationship(NO_RELATIONSHIPS, " Ada ", "Bo", "affection", 30);
    expect(first).toEqual({ ok: true, data: { tracks: [{ subject: "Ada", target: "Bo", track: "affection", value: 30 }] }, old: 0, value: 30 });
    const s1 = state(first);
    const capped = adjustRelationship(s1, "Ada", "Bo", "affection", 500);
    expect(capped.ok && [capped.old, capped.value]).toEqual([30, 100]);
    expect(relationshipValue(s1, "Ada", "Bo", "affection")).toBe(30);
    const floor = setRelationship(s1, "Ada", "Bo", "desire", -40);
    expect(floor.ok && floor.value).toBe(0);
    expect(relationshipValue(s1, "Bo", "Ada", "affection")).toBe(0);
    const low = setRelationship(s1, "Ada", "Bo", "affection", -1000);
    expect(low.ok && low.value).toBe(-100);
  });

  test("refusals are coded", () => {
    expect(adjustRelationship(NO_RELATIONSHIPS, "A", "B", "loyalty", 1)).toEqual({ ok: false, code: "unknown_track", path: "track" });
    expect(adjustRelationship(NO_RELATIONSHIPS, "A", "B", "affection", 1.5)).toEqual({ ok: false, code: "not_an_integer", path: "delta" });
    expect(setRelationship(NO_RELATIONSHIPS, "A", "B", "affection", Number.POSITIVE_INFINITY)).toEqual({ ok: false, code: "not_an_integer", path: "value" });
    expect(adjustRelationship(NO_RELATIONSHIPS, " ", "B", "affection", 1)).toEqual({ ok: false, code: "empty", path: "subject" });
    expect(adjustRelationship(NO_RELATIONSHIPS, "A", "名".repeat(101), "affection", 1)).toEqual({ ok: false, code: "too_long", path: "target" });
    const full: Relationships = { tracks: Array.from({ length: MAX_RELATIONSHIP_ROWS }, (_, i) => ({ subject: `s${i}`, target: "t", track: "affection", value: 1 })) };
    expect(adjustRelationship(full, "new", "t", "affection", 1)).toEqual({ ok: false, code: "limit_reached", path: "tracks" });
    expect(adjustRelationship(full, "s0", "t", "affection", 1).ok).toBe(true);
  });

  test("hostile names stay ordinary, and the stored form round-trips", () => {
    let s = state(adjustRelationship(NO_RELATIONSHIPS, "__proto__", "constructor", "affection", 5));
    s = state(adjustRelationship(s, "10", "2", "desire", 7));
    const data = relationshipsData(s);
    expect(validateRelationships(data)).toEqual([]);
    expect(readRelationships(JSON.parse(JSON.stringify(data)) as JsonObject)).toEqual(s);
    expect(({} as Record<string, unknown>).affection).toBeUndefined();
  });

  test("validation refuses duplicates, unknown tracks and out-of-range values; an invalid store reads as empty", () => {
    const row = { subject: "A", target: "B", track: "affection", value: 1 };
    expect(validateRelationships({ tracks: [row, row] }).map((v) => v.code)).toEqual(["duplicate"]);
    expect(validateRelationships({ tracks: [{ ...row, track: "loyalty" }] }).map((v) => v.code)).toEqual(["unknown_track"]);
    expect(validateRelationships({ tracks: [{ ...row, track: "desire", value: -1 }] }).map((v) => v.code)).toEqual(["bad_field"]);
    expect(validateRelationships({ tracks: [{ ...row, subject: " A" }] }).map((v) => v.path)).toEqual(["tracks.0.subject"]);
    expect(readRelationships({ tracks: [row, row] })).toEqual(NO_RELATIONSHIPS);
  });

  test("changed rows read the same way every time, filtered by entity", () => {
    let s = NO_RELATIONSHIPS;
    s = state(setRelationship(s, "Zed", "Ada", "affection", 10));
    s = state(setRelationship(s, "Ada", "Zed", "desire", 20));
    s = state(setRelationship(s, "Ada", "Bo", "affection", 0));
    s = state(setRelationship(s, "Ada", "Bo", "desire", 5));
    expect(changedRelationships(s).map((row) => `${row.subject}>${row.target}:${row.track}=${row.value}`)).toEqual([
      "Ada>Bo:desire=5",
      "Ada>Zed:desire=20",
      "Zed>Ada:affection=10",
    ]);
    expect(changedRelationships(s, "Bo").length).toBe(1);
  });
});

describe("who sees relationships", () => {
  const MARK = "LEAKMARK";
  const data = relationshipsData({
    tracks: [
      { subject: "npc-1", target: "Ada", track: "affection", value: -80 },
      { subject: `${MARK}-patron`, target: "npc-1", track: "affection", value: 90 },
    ],
  });

  test("the Keeper sees every row", () => {
    expect(JSON.stringify(relationshipsDocumentType.project(doc(data), KEEPER))).toContain(MARK);
  });

  test("an NPC actor sees only its own feelings", () => {
    const view = relationshipsDocumentType.project(doc(data), actorViewer("npc-1", "en"));
    expect(view).toEqual({ tracks: [{ subject: "npc-1", target: "Ada", track: "affection", value: -80 }] });
    expect(JSON.stringify(view)).not.toContain(MARK);
    expect(relationshipsDocumentType.project(doc(data), actorViewer("npc-2", "en"))).toEqual({ tracks: [] });
  });

  test("the admin and the table see nothing: an NPC's true feeling is discovered in play", () => {
    const viewers: Viewer[] = [{ grade: "admin", locale: "en" }, playerViewer("en", "m"), { grade: "observer", locale: "en" }];
    for (const viewer of viewers) expect(relationshipsDocumentType.project(doc(data), viewer)).toBeNull();
  });

  test("lifecycle: produced by play", () => {
    expect(relationshipsDocumentType.lifecycle).toEqual({ reset: "story" });
  });
});
