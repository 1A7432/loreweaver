import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Database, openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { type JsonObject, RecallError, type SearchHit, VectorIndex, type VectorPoint } from "../../../src/infra/recall/index.ts";

let dir = "";
const opened: Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loreweaver-recall-"));
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function open(file = "recall.db"): Database {
  const db = openDatabase(join(dir, file));
  opened.push(db);
  return db;
}

function point(id: string, vector: readonly number[], payload: JsonObject = {}): VectorPoint {
  return { id, vector, payload };
}

function ids(hits: readonly SearchHit[]): string[] {
  return hits.map((hit) => hit.id);
}

function refusal(body: () => unknown): RecallError {
  try {
    body();
  } catch (error) {
    if (error instanceof RecallError) return error;
    throw error;
  }
  throw new Error("expected a RecallError");
}

// Against the query [1, 0] every point has its own, well separated score.
const P1 = point("p1", [1, 0], { kind: "module", room: "r1" });
const P2 = point("p2", [0.9, 0.1], { kind: "module", room: "r1" });
const P3 = point("p3", [0, 1], { kind: "note", room: "r1" });
const P4 = point("p4", [-1, 0], { kind: "module", room: "r2" });
const QUERY = [1, 0];

function seeded(db: Database = open()): VectorIndex {
  const index = new VectorIndex(2, db);
  index.upsert("table", [P1, P2, P3, P4]);
  return index;
}

test("hits come best first with their cosine scores and payloads", () => {
  const hits = seeded().search("table", QUERY, { limit: 10 });
  expect(ids(hits)).toEqual(["p1", "p2", "p3", "p4"]);
  expect(hits.map((hit) => hit.score)).toEqual([1, expect.closeTo(0.9938837, 6), 0, -1]);
  expect(hits[0]?.payload).toEqual({ kind: "module", room: "r1" });
});

test("scores are cosine similarities: length does not matter, direction does", () => {
  const index = new VectorIndex(2, open());
  index.upsert("table", [point("short", [3, 4]), point("long", [30, 40]), point("other", [4, -3])]);
  expect(index.search("table", [6, 8], { limit: 3 }).map((hit) => hit.score)).toEqual([1, 1, 0]);
  // 3-4-5: the unit vectors are exactly (0.6, 0.8) and (0.8, -0.6); the equal scores keep arrival order.
  const hits = index.search("table", [1, 0], { limit: 3 });
  expect(ids(hits)).toEqual(["other", "short", "long"]);
  expect(hits.map((hit) => hit.score)).toEqual([0.8, 0.6, 0.6]);
});

test("limit cuts the list; zero gives none; anything but a non-negative integer is refused", () => {
  const index = seeded();
  expect(ids(index.search("table", QUERY, { limit: 2 }))).toEqual(["p1", "p2"]);
  expect(index.search("table", QUERY, { limit: 0 })).toEqual([]);
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(refusal(() => index.search("table", QUERY, { limit })).code).toBe("invalid_limit");
  }
});

test("an empty or unknown room has no hits and no count", () => {
  const index = seeded();
  expect(index.search("nowhere", QUERY, { limit: 5 })).toEqual([]);
  expect(index.count("nowhere")).toBe(0);
});

test("points round-trip through a database file reopened from disk", () => {
  const first = open();
  seeded(first).search("table", QUERY, { limit: 4 });
  const before = new VectorIndex(2, first).search("table", QUERY, { limit: 4 });
  first.close();
  const reopened = new VectorIndex(2, open());
  expect(reopened.count("table")).toBe(4);
  expect(reopened.search("table", QUERY, { limit: 4 })).toEqual(before);
});

test("the stored vector is a BLOB of little-endian float64, and the table is what the schema says", () => {
  const db = open();
  new VectorIndex(2, db).upsert("table", [point("a", [1.5, -2], { n: 1 })]);
  const row = db.prepare<{ vector: Uint8Array; payload: string; seq: number; type: string }>(
    "SELECT vector, payload, seq, typeof(vector) AS type FROM vectors WHERE room = ? AND id = ?",
  ).get("table", "a");
  expect(row?.type).toBe("blob");
  expect(Array.from(row?.vector ?? [])).toEqual([0, 0, 0, 0, 0, 0, 0xf8, 0x3f, 0, 0, 0, 0, 0, 0, 0, 0xc0]);
  expect(row?.payload).toBe('{"n":1}');
  expect(row?.seq).toBe(1);
  const columns = db.prepare<{ name: string; type: string; pk: number }>("SELECT name, type, pk FROM pragma_table_info('vectors')").all();
  expect(columns).toEqual([
    { name: "room", type: "TEXT", pk: 1 },
    { name: "id", type: "TEXT", pk: 2 },
    { name: "seq", type: "INTEGER", pk: 0 },
    { name: "vector", type: "BLOB", pk: 0 },
    { name: "payload", type: "TEXT", pk: 0 },
  ]);
});

test("upsert replaces a point's vector and payload", () => {
  const index = seeded();
  index.upsert("table", [point("p3", [1, 0], { kind: "module", room: "r9" })]);
  const hit = index.search("table", QUERY, { limit: 10 }).find((candidate) => candidate.id === "p3");
  expect(hit).toEqual({ id: "p3", score: 1, payload: { kind: "module", room: "r9" } });
  expect(index.count("table")).toBe(4);
});

test("a later duplicate in the same call wins", () => {
  const index = new VectorIndex(2, open());
  index.upsert("table", [point("a", [0, 1], { v: 1 }), point("a", [1, 0], { v: 2 })]);
  expect(index.search("table", [1, 0], { limit: 5 })).toEqual([{ id: "a", score: 1, payload: { v: 2 } }]);
  expect(index.count("table")).toBe(1);
});

// ---- filtering -------------------------------------------------------------------------

test("a filter keeps the points whose payload fields are equal; several fields all have to be", () => {
  const index = seeded();
  expect(ids(index.search("table", QUERY, { limit: 10, filter: { kind: "module" } }))).toEqual(["p1", "p2", "p4"]);
  expect(ids(index.search("table", QUERY, { limit: 10, filter: { kind: "module", room: "r1" } }))).toEqual(["p1", "p2"]);
  expect(index.search("table", QUERY, { limit: 10, filter: { room: "elsewhere" } })).toEqual([]);
  expect(ids(index.search("table", QUERY, { limit: 10, filter: {} }))).toEqual(["p1", "p2", "p3", "p4"]);
  // The limit applies after the filter.
  expect(ids(index.search("table", QUERY, { limit: 1, filter: { kind: "note" } }))).toEqual(["p3"]);
});

test("equality is strict about types and deep for arrays and objects", () => {
  const index = new VectorIndex(2, open());
  index.upsert("t", [
    point("a", [1, 0], { n: 1, flag: true, tags: ["x", "y"], meta: { a: 1, b: [2] }, none: null }),
    point("b", [1, 0], { n: "1", flag: 1, tags: ["x"], meta: { a: 1 }, none: 0 }),
  ]);
  const found = (filter: JsonObject) => ids(index.search("t", QUERY, { limit: 5, filter }));
  expect(found({ n: 1 })).toEqual(["a"]);
  expect(found({ n: "1" })).toEqual(["b"]);
  expect(found({ flag: true })).toEqual(["a"]);
  expect(found({ tags: ["x", "y"] })).toEqual(["a"]);
  expect(found({ tags: ["y", "x"] })).toEqual([]);
  expect(found({ meta: { b: [2], a: 1 } })).toEqual(["a"]);
  expect(found({ meta: { a: 1 } })).toEqual(["b"]);
  expect(found({ none: null })).toEqual(["a"]);
});

test("a missing field never equals null", () => {
  const index = new VectorIndex(2, open());
  index.upsert("t", [point("has", [1, 0], { owner: null }), point("lacks", [1, 0], {})]);
  expect(ids(index.search("t", QUERY, { limit: 5, filter: { owner: null } }))).toEqual(["has"]);
});

// ---- order -----------------------------------------------------------------------------

test("equal scores come in the order the points first arrived, not in id order", () => {
  const index = new VectorIndex(2, open());
  // Three vectors with exactly the same direction, so the same score; [2, 0] and [1, 0]
  // scale to the same unit vector bit for bit.
  index.upsert("t", [point("c", [1, 0]), point("a", [2, 0])]);
  index.upsert("t", [point("b", [4, 0]), point("worse", [0, 1])]);
  expect(ids(index.search("t", QUERY, { limit: 10 }))).toEqual(["c", "a", "b", "worse"]);
});

test("the tie order survives a reload, a replacement and a delete", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  index.upsert("t", [point("c", [1, 0]), point("a", [1, 0]), point("b", [1, 0])]);
  // Replacing a point keeps its place.
  index.upsert("t", [point("c", [3, 0], { again: true })]);
  expect(ids(index.search("t", QUERY, { limit: 10 }))).toEqual(["c", "a", "b"]);
  index.forget("t");
  expect(ids(index.search("t", QUERY, { limit: 10 }))).toEqual(["c", "a", "b"]);
  const fresh = new VectorIndex(2, db);
  expect(ids(fresh.search("t", QUERY, { limit: 10 }))).toEqual(["c", "a", "b"]);
  // Deleting and adding again puts it last, and new points are numbered after the old ones.
  fresh.delete("t", ["c"]);
  fresh.upsert("t", [point("c", [1, 0]), point("d", [1, 0])]);
  expect(ids(fresh.search("t", QUERY, { limit: 10 }))).toEqual(["a", "b", "c", "d"]);
  expect(ids(new VectorIndex(2, db).search("t", QUERY, { limit: 10 }))).toEqual(["a", "b", "c", "d"]);
});

test("a search is deterministic: the same data in the same order always ranks the same way", () => {
  const rows = randomPoints(300, 8, 7);
  const queries = randomPoints(5, 8, 99);
  const run = (file: string) => {
    const index = new VectorIndex(8, open(file));
    index.upsert("t", rows);
    return queries.map((query) => index.search("t", query.vector, { limit: 20 }));
  };
  expect(run("one.db")).toEqual(run("two.db"));
});

test("the ranking agrees with a plain cosine computed the long way", () => {
  const rows = randomPoints(500, 16, 3);
  const index = new VectorIndex(16, open());
  index.upsert("t", rows);
  for (const query of randomPoints(5, 16, 11)) {
    const expected = rows
      .map((row) => ({ id: row.id, score: plainCosine(row.vector, query.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    const hits = index.search("t", query.vector, { limit: 10 });
    expect(ids(hits)).toEqual(expected.map((hit) => hit.id));
    hits.forEach((hit, i) => expect(hit.score).toBeCloseTo(expected[i]?.score ?? Number.NaN, 12));
  }
});

// ---- the zero vector and bad vectors ---------------------------------------------------

test("a zero vector scores 0 against everything, and a zero query scores 0 against everything", () => {
  const index = new VectorIndex(2, open());
  index.upsert("t", [point("zero", [0, 0]), point("a", [1, 0]), point("b", [0, -1])]);
  const hits = index.search("t", QUERY, { limit: 5 });
  expect(hits).toEqual([
    { id: "a", score: 1, payload: {} },
    { id: "zero", score: 0, payload: {} },
    { id: "b", score: 0, payload: {} },
  ]);
  const none = index.search("t", [0, 0], { limit: 5 });
  expect(none.map((hit) => hit.score)).toEqual([0, 0, 0]);
  expect(ids(none)).toEqual(["zero", "a", "b"]);
  expect(Object.is(hits[2]?.score, 0)).toBe(true);
});

test("a vector of the wrong length is refused, in a point and as a query", () => {
  const index = seeded();
  expect(refusal(() => index.upsert("table", [point("x", [1, 0, 0])])).code).toBe("dimension_mismatch");
  expect(refusal(() => index.upsert("table", [point("x", [1])])).code).toBe("dimension_mismatch");
  expect(refusal(() => index.upsert("table", [point("x", [])])).code).toBe("dimension_mismatch");
  expect(refusal(() => index.search("table", [1, 0, 0], { limit: 5 })).detail).toEqual({ expected: 2, actual: 3 });
  expect(index.count("table")).toBe(4);
});

test("a vector with a number that is not finite is refused, in a point and as a query", () => {
  const index = seeded();
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(refusal(() => index.upsert("table", [point("x", [1, bad])])).code).toBe("non_finite");
    expect(refusal(() => index.search("table", [bad, 0], { limit: 5 })).code).toBe("non_finite");
  }
  // Finite numbers whose length overflows have no usable direction either.
  expect(refusal(() => index.upsert("table", [point("x", [1e200, 1e200])])).code).toBe("non_finite");
  // Not numbers at all: a hole and a string.
  expect(refusal(() => index.upsert("table", [point("x", [1, undefined as unknown as number])])).code).toBe("non_finite");
  expect(refusal(() => index.upsert("table", [point("x", [1, "2" as unknown as number])])).code).toBe("non_finite");
  expect(index.count("table")).toBe(4);
});

test("a refused call stores nothing, not even the good points before the bad one", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  expect(refusal(() => index.upsert("t", [point("good", [1, 0]), point("bad", [Number.NaN, 0])])).code).toBe("non_finite");
  expect(refusal(() => index.upsert("t", [point("good", [1, 0]), point("short", [1])])).code).toBe("dimension_mismatch");
  expect(refusal(() => index.upsert("t", [point("good", [1, 0]), { id: "p", vector: [1, 0], payload: [] as unknown as JsonObject }])).code).toBe(
    "invalid_payload",
  );
  expect(index.count("t")).toBe(0);
  expect(index.search("t", QUERY, { limit: 5 })).toEqual([]);
  expect(new VectorIndex(2, db).count("t")).toBe(0);
  // And the numbering did not move: the next point is the first.
  index.upsert("t", [point("first", [1, 0])]);
  expect(db.prepare<{ seq: number }>("SELECT seq FROM vectors WHERE id = 'first'").get()?.seq).toBe(1);
});

test("a payload that is not a JSON object is refused", () => {
  const index = new VectorIndex(2, open());
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const payload of [null, [], "text", 3, circular, { n: 1n }]) {
    const error = refusal(() => index.upsert("t", [{ id: "x", vector: [1, 0], payload: payload as JsonObject }]));
    expect(error.code).toBe("invalid_payload");
  }
  expect(index.count("t")).toBe(0);
});

test("a dimension count that is not a positive integer is refused", () => {
  for (const bad of [0, -2, 2.5, Number.NaN]) {
    expect(refusal(() => new VectorIndex(bad, open("bad.db"))).code).toBe("invalid_settings");
  }
});

test("typed arrays are accepted as vectors, and the index keeps its own copy", () => {
  const index = new VectorIndex(2, open());
  const vector = Float64Array.of(1, 0);
  const payload = { tags: ["a"] };
  index.upsert("t", [{ id: "a", vector, payload }]);
  vector[0] = 0;
  vector[1] = 1;
  payload.tags.push("b");
  expect(index.search("t", Float32Array.of(1, 0), { limit: 1 })).toEqual([{ id: "a", score: 1, payload: { tags: ["a"] } }]);
});

test("a hit's payload is a copy: changing it never changes the index", () => {
  const index = seeded();
  const [hit] = index.search("table", QUERY, { limit: 1 });
  (hit?.payload as Record<string, unknown>).kind = "changed";
  expect(index.search("table", QUERY, { limit: 1 })[0]?.payload.kind).toBe("module");
  expect(ids(index.search("table", QUERY, { limit: 5, filter: { kind: "changed" } }))).toEqual([]);
});

// ---- rooms -----------------------------------------------------------------------------

test("a search in one room never returns another room's point", () => {
  const index = new VectorIndex(2, open());
  index.upsert("one", [point("shared", [1, 0], { from: "one" }), point("only-one", [0.8, 0.2])]);
  index.upsert("two", [point("shared", [0, 1], { from: "two" }), point("only-two", [1, 0])]);
  expect(index.search("one", QUERY, { limit: 10 }).map((hit) => hit.id)).toEqual(["shared", "only-one"]);
  expect(index.search("two", QUERY, { limit: 10 }).map((hit) => hit.id)).toEqual(["only-two", "shared"]);
  expect(index.search("two", QUERY, { limit: 10 }).find((hit) => hit.id === "shared")?.payload).toEqual({ from: "two" });
  expect(index.count("one")).toBe(2);
  // A filter never reaches across rooms either.
  expect(index.search("one", QUERY, { limit: 10, filter: { from: "two" } })).toEqual([]);
  // The same on disk, loaded afresh.
  const fresh = new VectorIndex(2, opened[0] as Database);
  expect(fresh.search("one", QUERY, { limit: 10 }).map((hit) => hit.id)).toEqual(["shared", "only-one"]);
});

test("delete and deleteRoom touch one room only, in memory and on disk", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  index.upsert("one", [point("a", [1, 0]), point("b", [0, 1])]);
  index.upsert("two", [point("a", [1, 0]), point("b", [0, 1])]);
  index.delete("one", ["a", "missing"]);
  expect(ids(index.search("one", QUERY, { limit: 5 }))).toEqual(["b"]);
  expect(index.count("two")).toBe(2);
  expect(new VectorIndex(2, db).count("one")).toBe(1);
  index.deleteRoom("two");
  expect(index.count("two")).toBe(0);
  expect(index.search("two", QUERY, { limit: 5 })).toEqual([]);
  expect(index.count("one")).toBe(1);
  const fresh = new VectorIndex(2, db);
  expect(fresh.count("two")).toBe(0);
  expect(ids(fresh.search("one", QUERY, { limit: 5 }))).toEqual(["b"]);
  // A room can be filled again after it was deleted.
  index.upsert("two", [point("again", [1, 0])]);
  expect(ids(new VectorIndex(2, db).search("two", QUERY, { limit: 5 }))).toEqual(["again"]);
});

test("a room id is only ever a bound parameter, whatever it contains", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  const rooms = ["'; DROP TABLE vectors; --", "a%", "a_", "ab", '" OR "1"="1', "", "room\u0000nul", "名前", "x' OR room LIKE '%"];
  rooms.forEach((room, i) => index.upsert(room, [point(`p${i}`, [1, 0], { room })]));
  for (const [i, room] of rooms.entries()) {
    expect(index.count(room)).toBe(1);
    expect(ids(index.search(room, QUERY, { limit: 10 }))).toEqual([`p${i}`]);
  }
  const fresh = new VectorIndex(2, db);
  for (const [i, room] of rooms.entries()) expect(ids(fresh.search(room, QUERY, { limit: 10 }))).toEqual([`p${i}`]);
  fresh.deleteRoom("a%");
  expect(fresh.count("ab")).toBe(1);
  expect(fresh.count("a_")).toBe(1);
  expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM vectors").get()?.n).toBe(rooms.length - 1);
});

test("a room is read from the database when first used, and forget drops the copy in memory", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  // A second index over the same file writes before the first has looked at the room.
  const other = new VectorIndex(2, db);
  other.upsert("t", [point("early", [1, 0])]);
  expect(ids(index.search("t", QUERY, { limit: 5 }))).toEqual(["early"]);
  // Now the room is cached; a write the first index did not make is not seen until it forgets.
  other.upsert("t", [point("late", [1, 0])]);
  expect(ids(index.search("t", QUERY, { limit: 5 }))).toEqual(["early"]);
  index.forget("t");
  expect(ids(index.search("t", QUERY, { limit: 5 }))).toEqual(["early", "late"]);
  index.forget("never-loaded");
});

test("rows of another dimension count refuse the room, name the problem, and load nothing half way", () => {
  const db = open();
  new VectorIndex(3, db).upsert("old", [point("a", [1, 0, 0]), point("b", [0, 1, 0])]);
  const index = new VectorIndex(2, db);
  index.upsert("healthy", [point("ok", [1, 0])]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const error = refusal(() => index.search("old", QUERY, { limit: 5 }));
    expect(error.code).toBe("store_mismatch");
    expect(error.detail).toEqual({ expected: 16, actual: 24 });
  }
  expect(refusal(() => index.upsert("old", [point("c", [1, 0])])).code).toBe("store_mismatch");
  expect(ids(index.search("healthy", QUERY, { limit: 5 }))).toEqual(["ok"]);
  // The way out is to clear the room and embed it again.
  index.deleteRoom("old");
  index.upsert("old", [point("c", [1, 0])]);
  expect(ids(index.search("old", QUERY, { limit: 5 }))).toEqual(["c"]);
});

test("a stored row that cannot be read refuses the room", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  index.upsert("t", [point("a", [1, 0])]);
  db.prepare("UPDATE vectors SET payload = ? WHERE id = ?").run("{not json", "a");
  expect(refusal(() => new VectorIndex(2, db).search("t", QUERY, { limit: 5 })).code).toBe("store_mismatch");
  db.prepare("UPDATE vectors SET payload = ?, vector = ? WHERE id = ?").run("{}", new Uint8Array(16).fill(0xff), "a");
  expect(refusal(() => new VectorIndex(2, db).search("t", QUERY, { limit: 5 })).code).toBe("store_mismatch");
});

// ---- names that are also prototype members ---------------------------------------------

test("payload fields named like prototype members round-trip, and only own fields are matched", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  const nasty = JSON.parse('{"__proto__":"evil","constructor":"c","toString":"t","hasOwnProperty":"h","valueOf":null}') as JsonObject;
  index.upsert("t", [point("nasty", [1, 0], nasty), point("plain", [1, 0], { kind: "plain" })]);
  const check = (reader: VectorIndex) => {
    const hits = reader.search("t", QUERY, { limit: 10 });
    const hit = hits.find((candidate) => candidate.id === "nasty");
    expect(hit?.payload).toEqual(nasty);
    expect(Object.hasOwn(hit?.payload ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(hit?.payload)).toBe(Object.prototype);
    expect(ids(reader.search("t", QUERY, { limit: 10, filter: JSON.parse('{"__proto__":"evil"}') as JsonObject }))).toEqual(["nasty"]);
    expect(ids(reader.search("t", QUERY, { limit: 10, filter: { constructor: "c" } }))).toEqual(["nasty"]);
    expect(ids(reader.search("t", QUERY, { limit: 10, filter: { toString: "t", hasOwnProperty: "h" } }))).toEqual(["nasty"]);
    expect(ids(reader.search("t", QUERY, { limit: 10, filter: { valueOf: null } }))).toEqual(["nasty"]);
  };
  check(index);
  check(new VectorIndex(2, db));
  // The plain point has no such own fields, so a filter on them never finds the prototype's.
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    // `{}` is what a bare read of `__proto__` would be deeply equal to.
    for (const wanted of ["null", "{}", '"plain"']) {
      const filter = JSON.parse(`{${JSON.stringify(name)}:${wanted}}`) as JsonObject;
      expect(ids(index.search("t", QUERY, { limit: 10, filter }))).not.toContain("plain");
    }
  }
  expect(({} as Record<string, unknown>).evil).toBeUndefined();
  expect(Object.keys(Object.prototype)).toEqual([]);
});

test("point ids and room ids named like prototype members are ordinary ids", () => {
  const db = open();
  const index = new VectorIndex(2, db);
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    index.upsert(name, [point(name, [1, 0], { name }), point("other", [0, 1])]);
  }
  for (const reader of [index, new VectorIndex(2, db)]) {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(reader.search(name, QUERY, { limit: 5 })).toEqual([
        { id: name, score: 1, payload: { name } },
        { id: "other", score: 0, payload: {} },
      ]);
      expect(reader.count(name)).toBe(2);
    }
    expect(reader.search("valueOf", QUERY, { limit: 5 })).toEqual([]);
  }
  index.delete("__proto__", ["__proto__"]);
  expect(ids(index.search("__proto__", QUERY, { limit: 5 }))).toEqual(["other"]);
  expect(index.count("constructor")).toBe(2);
});

// ---- helpers ---------------------------------------------------------------------------

/** A small deterministic generator (mulberry32), so these tests need no seeded global. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPoints(count: number, dimensions: number, seed: number): VectorPoint[] {
  const next = prng(seed);
  return Array.from({ length: count }, (_, i) =>
    point(`r${seed}-${i}`, Array.from({ length: dimensions }, () => next() * 2 - 1), { i, parity: i % 2 }),
  );
}

function plainCosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
