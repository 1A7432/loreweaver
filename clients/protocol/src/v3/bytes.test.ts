import { expect, test } from "bun:test";

import {
  decodeByteReply,
  decodeByteRequest,
  decodeMediaOfferResult,
  encodeByteLine,
  HeaderReader,
  isContentHash,
  MAX_BYTE_HEADER_BYTES,
  MAX_UPLOAD_ID_CHARS,
} from "./bytes";

const HASH = "a".repeat(64);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("requests decode exactly: a get needs a content hash, a put an upload id within its cap", () => {
  expect(decodeByteRequest({ op: "get", hash: HASH, extra: 1 })).toEqual({ ok: true, request: { op: "get", hash: HASH } });
  expect(decodeByteRequest({ op: "put", upload_id: "u-1" })).toEqual({ ok: true, request: { op: "put", upload_id: "u-1" } });
  for (const bad of [null, [], { op: "get", hash: HASH.toUpperCase() }, { op: "get", hash: "abc" }, { op: "put", upload_id: "" }, { op: "put", upload_id: "x".repeat(MAX_UPLOAD_ID_CHARS + 1) }, { op: "delete", hash: HASH }]) {
    expect(decodeByteRequest(bad)).toEqual({ ok: false, code: "bad_request" });
  }
  expect(isContentHash(HASH)).toBe(true);
  expect(isContentHash(`${HASH}0`)).toBe(false);
});

test("replies decode to their shape or to null", () => {
  const file = { hash: HASH, size: 3, mime: "image/png", name: "a.png" };
  expect(decodeByteReply({ op: "get", ok: true, ...file })).toEqual({ op: "get", ok: true, ...file });
  expect(decodeByteReply({ op: "put", ok: true, ...file })).toEqual({ op: "put", ok: true, ...file });
  expect(decodeByteReply({ ok: false, code: "media_not_found", message: "no" })).toEqual({ ok: false, code: "media_not_found", message: "no" });
  expect(decodeByteReply({ op: "get", ok: true, ...file, size: -1 })).toBeNull();
  expect(decodeByteReply({ ok: false, code: 1, message: "no" })).toBeNull();
  expect(decodeByteReply("x")).toBeNull();
});

test("an offer's result is an upload id or an existing file", () => {
  expect(decodeMediaOfferResult({ upload_id: "u" })).toEqual({ upload_id: "u" });
  const existing = { hash: HASH, size: 1, mime: "image/png", name: "n", from: "m" };
  expect(decodeMediaOfferResult({ existing })).toEqual({ existing });
  expect(decodeMediaOfferResult({ existing: { ...existing, from: 1 } })).toBeNull();
  expect(decodeMediaOfferResult({})).toBeNull();
});

test("a header line is read across chunks, and what follows it is the body's start", () => {
  const line = encodeByteLine({ op: "put", upload_id: "u-9" });
  const reader = new HeaderReader();
  expect(reader.push(line.subarray(0, 5))).toEqual({ state: "more" });
  const step = reader.push(new Uint8Array([...line.subarray(5), 1, 2, 3]));
  expect(step).toEqual({ state: "line", value: { op: "put", upload_id: "u-9" }, rest: new Uint8Array([1, 2, 3]) });
  expect(() => reader.push(new Uint8Array(1))).toThrow();
});

test("a header that is not JSON reads as undefined; one with no newline in time is too long", () => {
  expect(new HeaderReader().push(bytes("nope\n"))).toEqual({ state: "line", value: undefined, rest: new Uint8Array(0) });
  const long = new HeaderReader();
  expect(long.push(bytes("x".repeat(MAX_BYTE_HEADER_BYTES - 1)))).toEqual({ state: "more" });
  expect(long.push(bytes("x"))).toEqual({ state: "too_long" });
  // A newline past the limit is too long as well, even when it arrives in the same chunk.
  expect(new HeaderReader().push(bytes(`${"x".repeat(MAX_BYTE_HEADER_BYTES)}\n`))).toEqual({ state: "too_long" });
});
