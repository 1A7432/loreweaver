// The archive reader is the security boundary of installing a pack: a round trip, and a
// hand-built hostile archive for every rule.
import { describe, expect, test } from "bun:test";
import { crc32, deflateRawSync } from "node:zlib";

import { checkEntryPath, MAX_ENTRIES, MAX_ENTRY_BYTES, readZip, writeZip, type ZipEntry } from "../../src/infra/zip.ts";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

interface RawEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  readonly madeBy?: number;
  readonly external?: number;
  readonly crc?: number;
  /** Declared uncompressed size (default: the real one). */
  readonly size?: number;
  /** Bytes as stored in the archive (default: deflated when method 8). */
  readonly stored?: Uint8Array;
  readonly localName?: string;
  /** Point the central record at another entry's local header (by index). */
  readonly sharesLocalOf?: number;
}

interface RawOptions {
  readonly disk?: number;
  readonly totalOverride?: number;
  readonly centralOffsetOverride?: number;
  readonly zip64Locator?: boolean;
}

/** A zip built byte by byte, so every field can be made to lie. */
function rawZip(entries: readonly RawEntry[], options: RawOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const flags = entry.flags ?? 0x0800;
    const stored = entry.stored ?? (method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data);
    const name = text(entry.name);
    const localName = text(entry.localName ?? entry.name);
    const crc = entry.crc ?? crc32(entry.data) >>> 0;
    const size = entry.size ?? entry.data.length;
    const local = new Uint8Array(30 + localName.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, localName.length, true);
    local.set(localName, 30);
    offsets.push(offset);
    const localOffset = entry.sharesLocalOf === undefined ? offset : (offsets[entry.sharesLocalOf] as number);
    if (entry.sharesLocalOf === undefined) {
      parts.push(local, stored);
      offset += local.length + stored.length;
    }
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, entry.madeBy ?? (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, entry.external ?? (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, localOffset, true);
    central.set(name, 46);
    centrals.push(central);
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const tail: Uint8Array[] = [];
  if (options.zip64Locator === true) {
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    tail.push(locator);
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, options.disk ?? 0, true);
  ev.setUint16(8, options.totalOverride ?? entries.length, true);
  ev.setUint16(10, options.totalOverride ?? entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, options.centralOffsetOverride ?? centralStart, true);
  const all = [...parts, ...centrals, ...tail, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function refusal(bytes: Uint8Array): { code: string; path?: string; detail?: string } {
  const read = readZip(bytes);
  if (read.ok) throw new Error("expected a refusal");
  const { ok: _ok, ...rest } = read;
  return rest;
}

describe("round trip", () => {
  test("what is written reads back, in order, byte for byte", () => {
    const entries: ZipEntry[] = [
      { path: "pack.yaml", bytes: text("id: x\n") },
      { path: "art/面具.png", bytes: Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) % 251) },
      { path: "empty.txt", bytes: new Uint8Array() },
      { path: "notes/long.txt", bytes: text("a".repeat(10_000)) },
    ];
    const read = readZip(writeZip(entries));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path));
    for (const [index, entry] of read.entries.entries()) expect(Buffer.from(entry.bytes).equals(Buffer.from((entries[index] as ZipEntry).bytes))).toBe(true);
  });

  test("the same entries give the same bytes", () => {
    const entries: ZipEntry[] = [{ path: "a.txt", bytes: text("hello") }];
    expect(Buffer.from(writeZip(entries)).equals(Buffer.from(writeZip(entries)))).toBe(true);
  });

  test("the writer refuses an unsafe or repeated path", () => {
    expect(() => writeZip([{ path: "../x", bytes: text("") }])).toThrow();
    expect(() => writeZip([{ path: "a", bytes: text("") }, { path: "A", bytes: text("") }])).toThrow();
  });

  test("a stored entry and a directory entry read", () => {
    const read = readZip(rawZip([{ name: "dir/", data: new Uint8Array(), method: 0 }, { name: "dir/a.txt", data: text("plain"), method: 0 }]));
    expect(read.ok && read.entries.map((entry) => entry.path)).toEqual(["dir/a.txt"]);
  });
});

describe("path rules", () => {
  const cases: [string, string][] = [
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["a/../b", "dot_segment"],
    ["./a", "dot_segment"],
    ["a\\b", "backslash"],
    ["C:/x", "drive_letter"],
    ["c:x", "drive_letter"],
    ["a/b:stream", "colon"],
    ["a\u0000b", "control_character"],
    ["a\nb", "control_character"],
    ["a//b", "empty_segment"],
    ["a/ /b", "empty_segment"],
    ["dir./x", "trailing_dot_or_space"],
    ["x ", "trailing_dot_or_space"],
    ["aux.txt", "reserved_name"],
    ["x".repeat(256), "segment_too_long"],
    [`${"a/".repeat(300)}b`, "too_long"],
  ];
  for (const [path, problem] of cases) {
    test(`${JSON.stringify(path.slice(0, 20))} is refused as ${problem}`, () => {
      expect(checkEntryPath(path)).toBe(problem as never);
    });
  }

  test("ordinary paths pass, CJK included", () => {
    for (const path of ["pack.yaml", "skills/guide/SKILL.md", "art/面具.png", "a.b.c/d-e_f.txt"]) expect(checkEntryPath(path)).toBeNull();
  });

  test("each unsafe name refuses the archive with the entry's name", () => {
    for (const name of ["../evil.txt", "/abs.txt", "a\\b.txt", "C:/win.txt", "x\u0001.txt"]) {
      expect(refusal(rawZip([{ name, data: text("x") }]))).toMatchObject({ code: "bad_path", path: name });
    }
  });

  test("a name that is not UTF-8 is refused", () => {
    const bytes = rawZip([{ name: "abc", data: text("x") }]);
    // Overwrite the central name with an invalid UTF-8 byte.
    const central = Buffer.from(bytes).lastIndexOf(Buffer.from("abc"));
    bytes[central] = 0xff;
    expect(refusal(bytes)).toMatchObject({ code: "bad_path" });
  });

  test("names that merge on a case-insensitive filesystem or after NFC are duplicates", () => {
    expect(refusal(rawZip([{ name: "Readme.txt", data: text("1") }, { name: "README.TXT", data: text("2") }]))).toMatchObject({ code: "duplicate_path" });
    expect(refusal(rawZip([{ name: "caf\u00e9", data: text("1") }, { name: "cafe\u0301", data: text("2") }]))).toMatchObject({ code: "duplicate_path" });
  });
});

describe("hostile archives", () => {
  test("not a zip, truncated, too short", () => {
    expect(refusal(text("hello world, not a zip at all"))).toMatchObject({ code: "not_a_zip" });
    expect(refusal(new Uint8Array(3))).toMatchObject({ code: "not_a_zip" });
    const good = writeZip([{ path: "a.txt", bytes: text("abc") }]);
    expect(refusal(good.subarray(0, good.length - 5))).toMatchObject({ code: "not_a_zip" });
  });

  test("zip64 and multi-disk are refused", () => {
    expect(refusal(rawZip([{ name: "a", data: text("x") }], { zip64Locator: true }))).toMatchObject({ code: "zip64" });
    expect(refusal(rawZip([{ name: "a", data: text("x") }], { totalOverride: 0xffff }))).toMatchObject({ code: "zip64" });
    expect(refusal(rawZip([{ name: "a", data: text("x") }], { disk: 1 }))).toMatchObject({ code: "multi_disk" });
  });

  test("encryption is refused", () => {
    expect(refusal(rawZip([{ name: "secret.txt", data: text("x"), flags: 0x0801 }]))).toMatchObject({ code: "encrypted", path: "secret.txt" });
  });

  test("a method other than stored or deflate is refused", () => {
    expect(refusal(rawZip([{ name: "a.bz2", data: text("x"), method: 12, stored: text("x") }]))).toMatchObject({ code: "unsupported_method", path: "a.bz2" });
  });

  test("a symbolic link is refused", () => {
    expect(refusal(rawZip([{ name: "link", data: text("/etc/passwd"), method: 0, external: (0o120777 << 16) >>> 0 }]))).toMatchObject({ code: "symlink", path: "link" });
  });

  test("a CRC that does not match is refused", () => {
    expect(refusal(rawZip([{ name: "a.txt", data: text("hello"), crc: 1234 }]))).toMatchObject({ code: "crc_mismatch", path: "a.txt" });
  });

  test("an entry that inflates past its declared size stops at the declared size and is refused", () => {
    // A small header claim over a stream that really inflates to 2 MiB.
    const big = new Uint8Array(2 * 1024 * 1024);
    expect(refusal(rawZip([{ name: "bomb.bin", data: big, size: 100 }]))).toMatchObject({ code: "size_mismatch", path: "bomb.bin" });
  });

  test("an entry that inflates to less than it declared is refused", () => {
    expect(refusal(rawZip([{ name: "short.txt", data: text("abc"), size: 50 }]))).toMatchObject({ code: "size_mismatch" });
  });

  test("a stored entry whose sizes disagree is refused", () => {
    expect(refusal(rawZip([{ name: "a.txt", data: text("abcd"), method: 0, size: 3 }]))).toMatchObject({ code: "size_mismatch" });
  });

  test("an entry over the per-entry cap is refused from its declaration, before inflating", () => {
    expect(refusal(rawZip([{ name: "huge.bin", data: text("x"), size: MAX_ENTRY_BYTES + 1 }]))).toMatchObject({ code: "entry_too_large", path: "huge.bin" });
  });

  test("the total of all entries is capped", () => {
    const entries: RawEntry[] = Array.from({ length: 9 }, (_, index) => ({ name: `part${index}.bin`, data: text("x"), size: 120 * 1024 * 1024 }));
    expect(refusal(rawZip(entries))).toMatchObject({ code: "total_too_large" });
  });

  test("a ratio past the cap is refused", () => {
    // 4 MiB of zeros deflates to a few kilobytes: far past 100:1.
    expect(refusal(rawZip([{ name: "zeros.bin", data: new Uint8Array(4 * 1024 * 1024) }]))).toMatchObject({ code: "ratio_too_high", path: "zeros.bin" });
  });

  test("too many entries are refused", () => {
    const entries: RawEntry[] = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({ name: `f${index}`, data: new Uint8Array(), method: 0 }));
    expect(refusal(rawZip(entries))).toMatchObject({ code: "too_many_entries" });
  });

  test("two central records sharing one local record (overlapping files) are refused", () => {
    const data = text("shared bytes");
    expect(refusal(rawZip([{ name: "a.txt", data }, { name: "b.txt", data, sharesLocalOf: 0, localName: "a.txt" }]))).toMatchObject({ code: "header_mismatch" });
    expect(refusal(rawZip([{ name: "a.txt", data }, { name: "a.txt", data, sharesLocalOf: 0 }]))).toMatchObject({ code: "duplicate_path" });
  });

  test("a local name that differs from the central name is refused", () => {
    expect(refusal(rawZip([{ name: "safe.txt", data: text("x"), localName: "../evil.txt" }]))).toMatchObject({ code: "header_mismatch", path: "safe.txt" });
  });

  test("a central directory pointing outside the archive is refused", () => {
    expect(refusal(rawZip([{ name: "a", data: text("x") }], { centralOffsetOverride: 0x7fffffff }))).toMatchObject({ code: "corrupt" });
  });
});
