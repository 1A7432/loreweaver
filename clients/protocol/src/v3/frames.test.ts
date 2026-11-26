import { expect, test } from "bun:test";

import { charCount, decodeClientFrame, MAX_INPUT_CHARS, protocolMajor } from "./frames";

const hello = { type: "hello", protocol: "3.0", key: "k", locale: "zh", client: { name: "t", version: "1" }, caps: [] };

test("a well-formed hello decodes and unknown fields are dropped", () => {
  const decoded = decodeClientFrame({ ...hello, extra: 1, resume: { epoch: 2, after: 9 } });
  expect(decoded).toEqual({ ok: true, frame: { ...hello, resume: { epoch: 2, after: 9 } } as never });
});

test("a hello with a wrong field type is a bad frame", () => {
  expect(decodeClientFrame({ ...hello, caps: [1] })).toEqual({ ok: false, code: "bad_frame" });
  expect(decodeClientFrame({ ...hello, resume: { epoch: 1.5, after: 0 } })).toEqual({ ok: false, code: "bad_frame" });
  expect(decodeClientFrame(null)).toEqual({ ok: false, code: "bad_frame" });
  expect(decodeClientFrame([hello])).toEqual({ ok: false, code: "bad_frame" });
});

test("input needs a request id, and its cap counts characters, not UTF-16 units", () => {
  expect(decodeClientFrame({ type: "input", text: "hi" })).toEqual({ ok: false, code: "bad_frame" });
  const astral = "𠀀".repeat(MAX_INPUT_CHARS);
  expect(astral.length).toBe(MAX_INPUT_CHARS * 2);
  expect(charCount(astral)).toBe(MAX_INPUT_CHARS);
  expect(decodeClientFrame({ type: "input", rid: "1", text: astral }).ok).toBe(true);
  expect(decodeClientFrame({ type: "input", rid: "1", text: `${astral}x` })).toEqual({
    ok: false,
    code: "input_too_long",
    rid: "1",
  });
});

test("a call's params default to an empty object and must be an object", () => {
  expect(decodeClientFrame({ type: "call", rid: "7", method: "log.page" })).toEqual({
    ok: true,
    frame: { type: "call", rid: "7", method: "log.page", params: {} },
  });
  expect(decodeClientFrame({ type: "call", rid: "7", method: "m", params: [] })).toEqual({
    ok: false,
    code: "invalid_params",
    rid: "7",
  });
});

test("protocolMajor reads major.minor and refuses anything else", () => {
  expect(protocolMajor("3.0")).toBe(3);
  expect(protocolMajor("2.6")).toBe(2);
  expect(protocolMajor("3")).toBeNull();
  expect(protocolMajor("v3.0")).toBeNull();
});
