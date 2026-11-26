import { expect, test } from "bun:test";

import { audiencesFor, safeName } from "../../../src/infra/media/policy.ts";
import { matchesSignature } from "../../../src/infra/media/signatures.ts";

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? Array.from(part, (c) => c.charCodeAt(0)) : part)));

test("image signatures are the fixed magic of each format", () => {
  expect(matchesSignature("image/png", bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
  expect(matchesSignature("image/png", bytes([0x89], "PNG"))).toBe(false);
  expect(matchesSignature("image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  expect(matchesSignature("image/jpeg", bytes([0xff, 0xd8]))).toBe(false);
  expect(matchesSignature("image/gif", bytes("GIF89a", [1]))).toBe(true);
  expect(matchesSignature("image/gif", bytes("GIF87a"))).toBe(true);
  expect(matchesSignature("image/gif", bytes("GIF88a"))).toBe(false);
  expect(matchesSignature("image/webp", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe(true);
  expect(matchesSignature("image/webp", bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBe(false);
  expect(matchesSignature("image/svg+xml", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
  // An SVG wearing a PNG label is refused by the PNG check.
  expect(matchesSignature("image/png", bytes("<svg/>"))).toBe(false);
});

test("audio signatures: fixed magic where the format has one, frame headers otherwise", () => {
  expect(matchesSignature("audio/wav", bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "))).toBe(true);
  expect(matchesSignature("audio/wav", bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBe(false);
  expect(matchesSignature("audio/flac", bytes("fLaC", [0]))).toBe(true);
  expect(matchesSignature("audio/ogg", bytes("OggS", [0]))).toBe(true);
  expect(matchesSignature("audio/mp4", bytes([0, 0, 0, 0x20], "ftypM4A "))).toBe(true);
  expect(matchesSignature("audio/mp4", bytes("ftypM4A "))).toBe(false);
  expect(matchesSignature("audio/mpeg", bytes("ID3", [4, 0]))).toBe(true);
  expect(matchesSignature("audio/mpeg", bytes([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
  // Layer 0 is the ADTS marker: that is AAC, not MP3.
  expect(matchesSignature("audio/mpeg", bytes([0xff, 0xf1, 0x50, 0x80]))).toBe(false);
  expect(matchesSignature("audio/aac", bytes([0xff, 0xf1, 0x50, 0x80]))).toBe(true);
  expect(matchesSignature("audio/aac", bytes("ADIF"))).toBe(true);
  expect(matchesSignature("audio/aac", bytes([0xff, 0xfb, 0x90, 0x00]))).toBe(false);
  expect(matchesSignature("audio/ogg", bytes("fLaC"))).toBe(false);
});

test("a client file name becomes a safe base name, counted in code points", () => {
  expect(safeName("map.png")).toBe("map.png");
  expect(safeName("../../etc/passwd")).toBe("passwd");
  expect(safeName("C:\\Users\\a\\map.png")).toBe("map.png");
  expect(safeName("dir/")).toBe("media");
  expect(safeName("..")).toBe("media");
  expect(safeName(".bashrc")).toBe("bashrc");
  expect(safeName("evil\u202egnp.exe")).toBe("evilgnp.exe");
  expect(safeName("a\u0000b\nc")).toBe("abc");
  expect(safeName(42)).toBe("media");
  expect(safeName("  ")).toBe("media");
  const long = "😀".repeat(300);
  expect(Array.from(safeName(long)).length).toBe(255);
});

test("audiences by role: admins see everything, other members the room and members editions", () => {
  expect(audiencesFor(undefined)).toEqual(["room"]);
  expect(audiencesFor("player")).toEqual(["room", "members"]);
  expect(audiencesFor("observer")).toEqual(["room", "members"]);
  expect(audiencesFor("admin")).toEqual(["room", "members", "admin"]);
});
