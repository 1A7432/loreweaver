import { expect, test } from "bun:test";

import { HashEmbeddings, hashTokens, RecallError } from "../../../src/infra/recall/index.ts";

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

async function embedOne(embeddings: HashEmbeddings, text: string): Promise<Float64Array> {
  const [vector] = await embeddings.embed([text]);
  if (!vector) throw new Error("no vector");
  return vector;
}

test("the default is 64 dimensions, any positive integer is accepted, nothing else", () => {
  expect(new HashEmbeddings().dimensions).toBe(64);
  expect(new HashEmbeddings(16).dimensions).toBe(16);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => new HashEmbeddings(bad)).toThrow(expect.objectContaining({ code: "invalid_settings" }));
  }
});

test("vectors are pinned: ASCII text gives exactly what the 2.6 embedder gave", async () => {
  // Produced by running 2.6's `FakeEmbeddings(dim=8)` / `FakeEmbeddings(dim=16)` on these texts.
  const eight = new HashEmbeddings(8);
  const s3 = 0.5773502691896258;
  const h = 0.7071067811865475;
  expect(await embedOne(eight, "the lighthouse keeper")).toEqual(Float64Array.of(0, 0, s3, 0, -s3, -s3, 0, 0));
  // Case and runs of whitespace do not matter, and one more word moves one bucket.
  expect(await embedOne(eight, "The Lighthouse KEEPER  hides")).toEqual(Float64Array.of(0, 0, 0.5, 0, -0.5, -0.5, 0.5, 0));
  expect(await embedOne(eight, "goblins raid the caravan at dawn")).toEqual(Float64Array.of(-0.5, 0, 0.5, -0.5, 0.5, 0, 0, 0));
  expect(await embedOne(eight, "a b")).toEqual(Float64Array.of(0, 0, h, 0, 0, 0, h, 0));
  const sixteen = new HashEmbeddings(16);
  expect(await embedOne(sixteen, "the lighthouse keeper")).toEqual(
    Float64Array.of(0, 0, s3, 0, -s3, 0, 0, 0, 0, 0, 0, 0, 0, -s3, 0, 0),
  );
});

test("an empty or blank text votes with the empty token, and is still a unit vector", async () => {
  const eight = new HashEmbeddings(8);
  const empty = await embedOne(eight, "");
  expect(empty).toEqual(Float64Array.of(0, 0, 1, 0, 0, 0, 0, 0));
  expect(await embedOne(eight, " \t\n ")).toEqual(empty);
});

test("votes that cancel give the unit vector on axis 0, never NaN", async () => {
  // "a" and "m" hash to the same bucket of 2 with opposite signs; so do "c" and "o".
  const two = new HashEmbeddings(2);
  expect(await embedOne(two, "a m")).toEqual(Float64Array.of(1, 0));
  expect(await embedOne(two, "c o")).toEqual(Float64Array.of(1, 0));
  expect(await embedOne(two, "a")).toEqual(Float64Array.of(1, 0));
  expect(await embedOne(two, "c")).toEqual(Float64Array.of(0, -1));
});

test("the same text gives the same vector, in one call, across calls and across instances", async () => {
  const text = "the lighthouse keeper hides a terrible secret";
  const [first, second] = await new HashEmbeddings(32).embed([text, text]);
  const [third] = await new HashEmbeddings(32).embed([text]);
  expect(first).toEqual(second);
  expect(first).toEqual(third);
});

test("each call returns fresh arrays, in the order of the texts, of the configured length", async () => {
  const embeddings = new HashEmbeddings(16);
  const [a] = await embeddings.embed(["alpha beta"]);
  const [b] = await embeddings.embed(["alpha beta"]);
  expect(a).not.toBe(b);
  a?.fill(9);
  expect(b?.[0]).not.toBe(9);
  const several = await embeddings.embed(["one", "two", "three"]);
  expect(several.map((vector) => vector.length)).toEqual([16, 16, 16]);
  expect(several[1]).toEqual(await embedOne(embeddings, "two"));
  expect(await embeddings.embed([])).toEqual([]);
});

test("vectors have length 1", async () => {
  const embeddings = new HashEmbeddings(32);
  for (const text of ["a fairly ordinary sentence about clues", "x", "魔王在城堡里", ""]) {
    expect(Math.hypot(...(await embedOne(embeddings, text)))).toBeCloseTo(1, 12);
  }
});

test("lower-casing is locale independent: I and i are one letter", async () => {
  const embeddings = new HashEmbeddings();
  expect(await embedOne(embeddings, "TITLE INDEX")).toEqual(await embedOne(embeddings, "title index"));
  // The dotted capital I lowers to i plus a combining dot, as it does in 2.6.
  expect(await embedOne(embeddings, "İSTANBUL")).toEqual(await embedOne(embeddings, "i̇stanbul"));
});

test("tokens split on every kind of Unicode whitespace", async () => {
  const embeddings = new HashEmbeddings();
  const plain = await embedOne(embeddings, "one two three");
  for (const separator of ["\t", "\n", "\r\n", " ", " ", "　", "  "]) {
    expect(await embedOne(embeddings, `one${separator}two${separator}three`)).toEqual(plain);
  }
});

test("texts sharing tokens are closer than texts sharing none", async () => {
  const embeddings = new HashEmbeddings(64);
  const [anchor, overlapping, disjoint] = await embeddings.embed([
    "the lighthouse keeper is hiding a terrible secret",
    "the lighthouse keeper hides a secret in the fog",
    "goblins raid the merchant caravan at dawn",
  ]);
  if (!anchor || !overlapping || !disjoint) throw new Error("missing vectors");
  expect(cosine(anchor, overlapping)).toBeGreaterThan(cosine(anchor, disjoint));
  expect(cosine(anchor, anchor)).toBeCloseTo(1, 12);
});

test("hashTokens: whitespace words, then every pair of adjacent CJK characters", () => {
  expect(hashTokens("Hello  World")).toEqual(["hello", "world"]);
  expect(hashTokens("你好世界")).toEqual(["你好世界", "你好", "好世", "世界"]);
  // Punctuation and spaces end a run; a lone character has no pair.
  expect(hashTokens("hello 你好，世界! 的")).toEqual(["hello", "你好，世界!", "的", "你好", "世界"]);
  // Kana and the prolonged-sound mark; characters outside the BMP count as one character.
  expect(hashTokens("コーヒー")).toEqual(["コーヒー", "コー", "ーヒ", "ヒー"]);
  expect(hashTokens("𠮷野家")).toEqual(["𠮷野家", "𠮷野", "野家"]);
  // Hangul is spaced, so words suffice; Latin letters next to CJK stay out of the pairs.
  expect(hashTokens("한국어 문장")).toEqual(["한국어", "문장"]);
  expect(hashTokens("abc你好def")).toEqual(["abc你好def", "你好"]);
  expect(hashTokens("")).toEqual([""]);
});

test("a Chinese vector is pinned (bigrams included)", async () => {
  const sixteen = new HashEmbeddings(16);
  // Computed by an independent implementation of the same rule, not by this code.
  expect(await embedOne(sixteen, "你好世界")).toEqual(Float64Array.of(0, 0, 0, 0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0, 0, 0, 0, 0, 0));
  expect(await embedOne(sixteen, "hello 你好，世界!")).toEqual(
    Float64Array.of(0, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0, -0.5, 0, -0.5, 0, 0, 0),
  );
});

test("Chinese sentences that share words are close; unrelated ones are not", async () => {
  const embeddings = new HashEmbeddings(256);
  const [castle, otherCastle, lighthouse] = await embeddings.embed(["魔王在城堡里", "魔王的城堡", "海边的灯塔守护者"]);
  if (!castle || !otherCastle || !lighthouse) throw new Error("missing vectors");
  // They share the pairs 魔王 and 城堡. Without bigrams each sentence is one token and
  // the first pair would score 0 exactly like the second.
  expect(cosine(castle, otherCastle)).toBeGreaterThan(0.3);
  expect(cosine(castle, lighthouse)).toBeLessThan(0.1);
});

test("an aborted signal stops the call before it does any work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(new HashEmbeddings().embed(["x"], { signal: controller.signal })).rejects.toBeInstanceOf(RecallError);
  await expect(new HashEmbeddings().embed(["x"], { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
});
