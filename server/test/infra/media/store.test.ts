import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { BlobDir } from "../../../src/infra/media/blobs.ts";
import { DEFAULT_MEDIA_LIMITS, type MediaLimits } from "../../../src/infra/media/policy.ts";
import { MediaStore, type BeginResult, type MediaOffer, type StoreResult } from "../../../src/infra/media/store.ts";
import { openDatabase, type Database } from "../../../src/infra/runtime/sqlite.ts";

interface TestClock {
  now(): number;
  id(): string;
  advance(ms: number): void;
}

function clock(): TestClock {
  let ids = 0;
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    id: () => `id-${++ids}`,
    advance: (ms) => {
      now += ms;
    },
  };
}

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lw-media-"));
  dataDir = join(root, "data");
});

afterEach(() => {
  // A test may have left a directory read-only on purpose.
  try {
    chmodSync(join(dataDir, "media", "blobs"), 0o700);
  } catch {
    // Not created.
  }
  rmSync(root, { recursive: true, force: true });
});

interface Bench {
  readonly media: MediaStore;
  readonly db: Database;
  readonly clock: TestClock;
  readonly blobDir: string;
}

function bench(limits: Partial<MediaLimits> = {}): Bench {
  const db = openDatabase(":memory:");
  const c = clock();
  const media = new MediaStore(dataDir, db, { clock: c, limits: { ...DEFAULT_MEDIA_LIMITS, ...limits } });
  return { media, db, clock: c, blobDir: join(dataDir, "media", "blobs") };
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A PNG-signed blob, distinct per `tag`. */
function png(tag: string, padding = 0): Uint8Array {
  const body = new TextEncoder().encode(tag + "#".repeat(padding));
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...body]);
}

function ogg(tag: string): Uint8Array {
  return new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new TextEncoder().encode(tag)]);
}

function offer(bytes: Uint8Array, over: Partial<MediaOffer> = {}): MediaOffer {
  return { room: "table", uploader: "m:ada", name: "map.png", mime: "image/png", size: bytes.length, sha256: sha(bytes), ...over };
}

function uploadId(result: BeginResult): string {
  if (!result.ok || result.kind !== "upload") throw new Error(`expected an upload, got ${JSON.stringify(result)}`);
  return result.uploadId;
}

async function upload(media: MediaStore, bytes: Uint8Array, over: Partial<MediaOffer> = {}): Promise<StoreResult> {
  const o = offer(bytes, over);
  return media.completeUpload(uploadId(media.beginUpload(o)), o.uploader, bytes);
}

function code(result: BeginResult | StoreResult): string {
  return result.ok ? "ok" : result.code;
}

/** Every path under `dir`, relative, with `/` separators. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => relative(dir, join(dir, entry)).split(sep).join("/"))
    .sort();
}

test("an upload is checked, stored once under its hash, and readable by the room", async () => {
  const { media, blobDir } = bench();
  const bytes = png("map");
  const result = await upload(media, bytes, { name: "../../maps/lower hall.png" });
  expect(result).toEqual({
    ok: true,
    created: true,
    record: {
      room: "table",
      hash: sha(bytes),
      mime: "image/png",
      size: bytes.length,
      name: "lower hall.png",
      uploader: "m:ada",
      createdAt: 1_700_000_000_000,
      audience: "room",
    },
  });
  expect(media.find("table", sha(bytes))?.name).toBe("lower hall.png");
  expect((await media.read("table", sha(bytes), "player"))?.bytes).toEqual(bytes);
  expect(media.list("table").map((record) => record.hash)).toEqual([sha(bytes)]);
  expect(media.usage("table")).toEqual({ image: bytes.length, audio: 0 });
  expect(tree(blobDir)).toEqual([sha(bytes)]);
  if (process.platform !== "win32") {
    expect(statSync(join(blobDir, sha(bytes))).mode & 0o777).toBe(0o600);
    expect(statSync(blobDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "media")).mode & 0o777).toBe(0o700);
  }
  // Another room does not hold it, whoever asks.
  expect(media.find("other", sha(bytes), "admin")).toBeUndefined();
  expect(await media.read("other", sha(bytes), "admin")).toBeUndefined();
});

test("offers are refused with a stable code for every check the protocol lists", () => {
  const { media } = bench({ image: { maxFileBytes: 100, roomQuotaBytes: 150 } });
  const bytes = png("x");
  const refused = (over: Partial<MediaOffer>): string => code(media.beginUpload(offer(bytes, over)));
  expect(refused({ room: "../etc" })).toBe("media_bad_offer");
  expect(refused({ room: "" })).toBe("media_bad_offer");
  expect(refused({ room: "a/b" })).toBe("media_bad_offer");
  expect(refused({ uploader: "" })).toBe("media_bad_offer");
  expect(refused({ mime: "IMAGE/PNG" })).toBe("media_bad_mime");
  expect(refused({ mime: "text/html" })).toBe("media_bad_mime");
  expect(refused({ mime: "image/bmp" })).toBe("media_bad_mime");
  expect(refused({ size: 0 })).toBe("media_bad_offer");
  expect(refused({ size: 1.5, uploader: "m:b" })).toBe("media_bad_offer");
  expect(refused({ size: Number.NaN, uploader: "m:b" })).toBe("media_bad_offer");
  expect(refused({ size: 101, uploader: "m:b" })).toBe("media_too_large");
  expect(refused({ sha256: sha(bytes).toUpperCase(), uploader: "m:b" })).toBe("media_bad_hash");
  expect(refused({ sha256: "abc", uploader: "m:b" })).toBe("media_bad_hash");
  expect(refused({ size: 100, uploader: "m:c" })).toBe("ok");
});

test("image and audio have their own file limits and room budgets; reports share the image budget", async () => {
  const { media } = bench({
    image: { maxFileBytes: 64, roomQuotaBytes: 64 },
    audio: { maxFileBytes: 1000, roomQuotaBytes: 64 },
    uploadsPerMinute: 100,
  });
  expect(code(media.beginUpload(offer(png("a"), { mime: "audio/ogg", size: 900 })))).toBe("media_quota_exceeded");
  expect(code(media.beginUpload(offer(png("a"), { size: 900 })))).toBe("media_too_large");
  expect(code(await upload(media, png("image", 40)))).toBe("ok");
  expect(code(await upload(media, ogg("audio".repeat(10)), { mime: "audio/ogg", name: "a.ogg" }))).toBe("ok");
  expect(code(media.beginUpload(offer(png("more", 10))))).toBe("media_quota_exceeded");
  const report = new TextEncoder().encode("<html>report</html>");
  expect(code(await media.registerServerBlob({ room: "table", bytes: report, mime: "text/html", name: "r.html", audience: "members" }))).toBe(
    "media_quota_exceeded",
  );
  const small = bench({ image: { maxFileBytes: 64, roomQuotaBytes: 30 } }).media;
  expect(code(await small.registerServerBlob({ room: "table", bytes: report, mime: "text/html", name: "r.html", audience: "members" }))).toBe("ok");
  expect(code(small.beginUpload(offer(png("x", 10))))).toBe("media_quota_exceeded");
});

test("the rate limit is per member per room and refills over a minute", () => {
  const { media, clock: c } = bench({ uploadsPerMinute: 3 });
  const ask = (uploader: string, room = "table"): string => code(media.beginUpload(offer(png(`${uploader}${room}`), { uploader, room })));
  expect([ask("m:a"), ask("m:a"), ask("m:a"), ask("m:a")]).toEqual(["ok", "ok", "ok", "media_rate_limited"]);
  expect(ask("m:b")).toBe("ok");
  expect(ask("m:a", "other")).toBe("ok");
  // A refused offer spends a token too, so probing costs what uploading costs.
  expect(code(media.beginUpload(offer(png("z"), { uploader: "m:c", mime: "bad/mime" })))).toBe("media_bad_mime");
  c.advance(19_999);
  expect(ask("m:a")).toBe("media_rate_limited");
  c.advance(1);
  expect(ask("m:a")).toBe("ok");
  expect(ask("m:a")).toBe("media_rate_limited");
});

test("the room's upload switch refuses offers, and an upload already accepted", async () => {
  const { media } = bench();
  media.setUploadsEnabled("table", false);
  expect(media.uploadsEnabled("table")).toBe(false);
  expect(code(media.beginUpload(offer(png("a"))))).toBe("media_disabled");
  media.setUploadsEnabled("table", true);
  const bytes = png("b");
  const id = uploadId(media.beginUpload(offer(bytes)));
  media.setUploadsEnabled("table", false);
  expect(code(await media.completeUpload(id, "m:ada", bytes))).toBe("media_disabled");
  expect(media.find("table", sha(bytes))).toBeUndefined();
  expect(() => media.setUploadsEnabled("../x", false)).toThrow(RangeError);
});

test("a room that already holds the hash says so; another room must send the bytes", async () => {
  const { media, blobDir } = bench();
  const bytes = png("shared");
  await upload(media, bytes);
  const again = media.beginUpload(offer(bytes, { uploader: "m:bao" }));
  expect(again.ok && again.kind).toBe("existing");
  // Knowing a hash is not owning the bytes: no cross-room shortcut.
  expect(code(media.beginUpload(offer(bytes, { room: "other" })))).toBe("ok");
  expect(code(await upload(media, bytes, { room: "other", uploader: "m:bao" }))).toBe("ok");
  expect(tree(blobDir)).toEqual([sha(bytes)]);
  expect(media.deleteRoom("table")).toBe(1);
  expect(tree(blobDir)).toEqual([sha(bytes)]);
  expect((await media.read("other", sha(bytes)))?.bytes).toEqual(bytes);
  expect(media.deleteRoom("other")).toBe(1);
  expect(tree(blobDir)).toEqual([]);
});

test("completion checks exact size, sha256, signature and the SVG subset before writing", async () => {
  const { media, blobDir } = bench({ uploadsPerMinute: 100 });
  const bytes = png("real");
  const tryWith = async (over: Partial<MediaOffer>, sent: Uint8Array): Promise<string> => {
    const o = offer(bytes, over);
    return code(await media.completeUpload(uploadId(media.beginUpload(o)), o.uploader, sent));
  };
  expect(await tryWith({}, png("real!"))).toBe("media_size_mismatch");
  expect(await tryWith({}, png("fake"))).toBe("media_hash_mismatch");
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  expect(await tryWith({ size: svg.length, sha256: sha(svg) }, svg)).toBe("media_bad_signature");
  const evil = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>');
  expect(await tryWith({ mime: "image/svg+xml", size: evil.length, sha256: sha(evil) }, evil)).toBe("media_bad_svg");
  expect(await tryWith({ mime: "image/svg+xml", size: svg.length, sha256: sha(svg) }, svg)).toBe("ok");
  expect(await tryWith({ mime: "audio/ogg" }, bytes)).toBe("media_bad_signature");
  expect(tree(blobDir)).toEqual([sha(svg)]);
});

test("an upload id is single-use, bound to its uploader, and expires", async () => {
  const { media, clock: c } = bench({ pendingUploadTtlMs: 1000 });
  const bytes = png("once");
  const id = uploadId(media.beginUpload(offer(bytes)));
  expect(code(await media.completeUpload("nope", "m:ada", bytes))).toBe("media_unknown_upload");
  expect(code(await media.completeUpload(id, "m:bao", bytes))).toBe("media_unknown_upload");
  expect(code(await media.completeUpload(id, "m:ada", png("wrong")))).toBe("media_size_mismatch");
  expect(code(await media.completeUpload(id, "m:ada", bytes))).toBe("media_unknown_upload");
  const late = uploadId(media.beginUpload(offer(bytes)));
  c.advance(1000);
  expect(code(await media.completeUpload(late, "m:ada", bytes))).toBe("media_unknown_upload");
});

test("the room budget is checked again at completion: two pending offers cannot both overrun it", async () => {
  const { media, blobDir } = bench({ image: { maxFileBytes: 100, roomQuotaBytes: 100 } });
  const a = png("a", 50);
  const b = png("b", 50);
  const idA = uploadId(media.beginUpload(offer(a)));
  const idB = uploadId(media.beginUpload(offer(b, { uploader: "m:bao" })));
  expect(code(await media.completeUpload(idA, "m:ada", a))).toBe("ok");
  expect(code(await media.completeUpload(idB, "m:bao", b))).toBe("media_quota_exceeded");
  expect(tree(blobDir)).toEqual([sha(a)]);
});

test("two concurrent uploads of the same bytes into one room record it once", async () => {
  const { media, blobDir } = bench();
  const bytes = png("twice");
  const idA = uploadId(media.beginUpload(offer(bytes)));
  const idB = uploadId(media.beginUpload(offer(bytes, { uploader: "m:bao" })));
  const [ra, rb] = await Promise.all([media.completeUpload(idA, "m:ada", bytes), media.completeUpload(idB, "m:bao", bytes)]);
  expect([ra.ok && ra.created, rb.ok && rb.created].sort()).toEqual([false, true]);
  expect(tree(blobDir)).toEqual([sha(bytes)]);
});

test("clearing a room voids its pending offers and uploads still writing", async () => {
  const { media, blobDir } = bench();
  const bytes = png("in flight");
  const pendingId = uploadId(media.beginUpload(offer(bytes)));
  const writing = png("writing");
  const writingId = uploadId(media.beginUpload(offer(writing, { uploader: "m:bao" })));
  const inFlight = media.completeUpload(writingId, "m:bao", writing);
  const generated = png("generated");
  const making = media.registerServerBlob({ room: "table", bytes: generated, mime: "image/png", name: "g.png", audience: "room" });
  media.deleteRoom("table");
  expect(code(await inFlight)).toBe("media_unknown_upload");
  expect(code(await making)).toBe("media_unknown_upload");
  expect(code(await media.completeUpload(pendingId, "m:ada", bytes))).toBe("media_unknown_upload");
  expect(media.list("table")).toEqual([]);
  expect(tree(blobDir)).toEqual([]);
});

test("unlisted blobs: never listed, visible only to their audience, never republished", async () => {
  const { media } = bench();
  const player = new TextEncoder().encode("<html>player edition</html>");
  const reveal = new TextEncoder().encode("<html>reveal edition</html>");
  const members = await media.registerServerBlob({ room: "table", bytes: player, mime: "text/html", name: "report.html", audience: "members" });
  const admin = await media.registerServerBlob({ room: "table", bytes: reveal, mime: "text/html", name: "reveal.html", audience: "admin" });
  expect(members.ok && members.record.uploader).toBe("server");
  expect(admin.ok).toBe(true);
  expect(media.list("table")).toEqual([]);
  expect(media.find("table", sha(player))).toBeUndefined();
  expect(media.find("table", sha(player), "observer")?.audience).toBe("members");
  expect(media.find("table", sha(reveal), "player")).toBeUndefined();
  expect(await media.read("table", sha(reveal), "player")).toBeUndefined();
  expect((await media.read("table", sha(reveal), "admin"))?.bytes).toEqual(reveal);
  // HTML never becomes listed room media.
  expect(code(await media.registerServerBlob({ room: "table", bytes: player, mime: "text/html", name: "x", audience: "room" }))).toBe("media_bad_mime");
  // The same bytes under another audience are refused, not answered with the unlisted record.
  expect(code(await media.registerServerBlob({ room: "table", bytes: player, mime: "text/html", name: "x", audience: "admin" }))).toBe(
    "media_bad_upload",
  );
  expect(code(await media.registerServerBlob({ room: "table", bytes: player, mime: "text/html", name: "x", audience: "members" }))).toBe("ok");
  // A generated picture is ordinary room media, still signature-checked.
  const picture = png("generated");
  const made = await media.registerServerBlob({ room: "table", bytes: picture, mime: "image/png", name: "scene.png", audience: "room" });
  expect(made.ok && made.record.audience).toBe("room");
  expect(media.list("table").map((record) => record.hash)).toEqual([sha(picture)]);
  expect(code(await media.registerServerBlob({ room: "table", bytes: player, mime: "image/png", name: "x", audience: "room" }))).toBe(
    "media_bad_signature",
  );
  expect(code(await media.registerServerBlob({ room: "table", bytes: ogg("a"), mime: "audio/ogg", name: "x", audience: "room" }))).toBe(
    "media_bad_mime",
  );
  // A member offering an unlisted blob's hash is not told it exists; completing is refused.
  const imageUnlisted = png("private");
  await media.registerServerBlob({ room: "table", bytes: imageUnlisted, mime: "image/png", name: "p.png", audience: "admin" });
  expect(code(media.beginUpload(offer(imageUnlisted)))).toBe("ok");
  expect(code(await upload(media, imageUnlisted, { uploader: "m:bao" }))).toBe("media_bad_upload");
  // Deleting the room takes unlisted blobs too.
  expect(media.deleteRoom("table")).toBe(4);
  expect(media.find("table", sha(reveal), "admin")).toBeUndefined();
});

test("server blobs ignore the members' switch and rate limit", async () => {
  const { media } = bench({ uploadsPerMinute: 1 });
  media.setUploadsEnabled("table", false);
  for (const tag of ["a", "b", "c"]) {
    expect(code(await media.registerServerBlob({ room: "table", bytes: png(tag), mime: "image/png", name: "g.png", audience: "room" }))).toBe("ok");
  }
});

test("no input reaches outside the data directory", async () => {
  const { media } = bench({ uploadsPerMinute: 1000 });
  const bytes = png("contained");
  const hostileRooms = ["..", "../..", "/etc", "a/../../b", "a\\..\\b", "a\u0000b", ".hidden", "x".repeat(200), "日本", "a b"];
  for (const room of hostileRooms) {
    expect(code(media.beginUpload(offer(bytes, { room })))).toBe("media_bad_offer");
    expect(code(await media.registerServerBlob({ room, bytes, mime: "image/png", name: "x", audience: "room" }))).toBe("media_bad_offer");
    expect(media.find(room, sha(bytes), "admin")).toBeUndefined();
    expect(media.list(room)).toEqual([]);
    expect(media.deleteRoom(room)).toBe(0);
  }
  for (const hash of ["../../../../etc/passwd", `../${sha(bytes)}`, `${sha(bytes)}/..`, sha(bytes).toUpperCase(), ""]) {
    expect(code(media.beginUpload(offer(bytes, { sha256: hash })))).toBe("media_bad_hash");
    expect(await media.read("table", hash, "admin")).toBeUndefined();
  }
  expect(code(await upload(media, bytes, { name: "../../../outside.png" }))).toBe("ok");
  expect(code(await upload(media, png("abs"), { name: "/tmp/abs.png" }))).toBe("ok");
  // Only blob files, named by their hash, exist — and only under the data directory.
  expect(tree(root)).toEqual(["data", "data/media", "data/media/blobs", `data/media/blobs/${sha(bytes)}`, `data/media/blobs/${sha(png("abs"))}`].sort());
  const blobs = new BlobDir(dataDir);
  for (const hash of ["..", "../x", `${"a".repeat(63)}/`, `${"a".repeat(64)}\u0000`]) expect(() => blobs.pathOf(hash)).toThrow(RangeError);
});

test("an index write that fails after the file is published removes the new file", async () => {
  const { media, db, blobDir } = bench();
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  const bytes = png("doomed");
  expect(code(await upload(media, bytes))).toBe("media_storage_failed");
  expect(media.find("table", sha(bytes), "admin")).toBeUndefined();
  expect(tree(blobDir)).toEqual([]);
});

test("a failed index write never removes a file another room's row names", async () => {
  const { media, db, blobDir } = bench();
  const bytes = png("shared");
  await upload(media, bytes, { room: "other" });
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  expect(code(await upload(media, bytes))).toBe("media_storage_failed");
  expect(tree(blobDir)).toEqual([sha(bytes)]);
  expect((await media.read("other", sha(bytes)))?.bytes).toEqual(bytes);
});

const posixModes = process.platform !== "win32" && process.getuid?.() !== 0;

test.skipIf(!posixModes)("a file write that fails records nothing", async () => {
  const { media, blobDir } = bench();
  chmodSync(blobDir, 0o500);
  const bytes = png("unwritable");
  expect(code(await upload(media, bytes))).toBe("media_storage_failed");
  chmodSync(blobDir, 0o700);
  expect(media.find("table", sha(bytes), "admin")).toBeUndefined();
  expect(tree(blobDir)).toEqual([]);
});

test("a delete whose index write fails changes nothing", async () => {
  const { media, db, blobDir } = bench();
  const bytes = png("kept");
  await upload(media, bytes);
  db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON media BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  expect(() => media.deleteRoom("table")).toThrow();
  expect((await media.read("table", sha(bytes)))?.bytes).toEqual(bytes);
  expect(tree(blobDir)).toEqual([sha(bytes)]);
});

test.skipIf(!posixModes)("a file that cannot be removed after a delete is left for the sweep, never a row without its file", async () => {
  const { media, blobDir } = bench();
  const bytes = png("stuck");
  await upload(media, bytes);
  chmodSync(blobDir, 0o500);
  expect(media.deleteRoom("table")).toBe(1);
  expect(media.find("table", sha(bytes), "admin")).toBeUndefined();
  expect(tree(blobDir)).toEqual([sha(bytes)]);
  chmodSync(blobDir, 0o700);
  expect(media.sweep()).toBe(1);
  expect(tree(blobDir)).toEqual([]);
});

test("the sweep removes unreferenced blobs and stale temporary files, and keeps the rest", async () => {
  const { media, blobDir } = bench();
  const kept = png("kept");
  await upload(media, kept);
  const orphan = png("orphan");
  writeFileSync(join(blobDir, sha(orphan)), orphan);
  const temp = `.${sha(orphan)}.id-9-1.tmp`;
  writeFileSync(join(blobDir, temp), orphan);
  writeFileSync(join(blobDir, "README"), "not ours");
  expect(media.sweep()).toBe(2);
  expect(tree(blobDir)).toEqual(["README", sha(kept)].sort());
});

test("a damaged or missing file reads as not found", async () => {
  const { media, blobDir } = bench();
  const bytes = png("fragile");
  await upload(media, bytes);
  writeFileSync(join(blobDir, sha(bytes)), png("tampered"));
  expect(await media.read("table", sha(bytes))).toBeUndefined();
  rmSync(join(blobDir, sha(bytes)));
  expect(await media.read("table", sha(bytes))).toBeUndefined();
  // Uploading the bytes again into another room repairs the shared file.
  expect(code(await upload(media, bytes, { room: "other" }))).toBe("ok");
  expect((await media.read("table", sha(bytes)))?.bytes).toEqual(bytes);
});

test("the index survives a new store on the same database and directory", async () => {
  const dbPath = join(root, "media.db");
  const first = new MediaStore(dataDir, openDatabase(dbPath), { clock: clock() });
  const bytes = png("persist");
  await upload(first, bytes);
  first.setUploadsEnabled("table", false);
  const second = new MediaStore(dataDir, openDatabase(dbPath), { clock: clock() });
  expect((await second.read("table", sha(bytes)))?.bytes).toEqual(bytes);
  expect(second.uploadsEnabled("table")).toBe(false);
});

test("limits a store could not enforce are refused at construction", () => {
  const db = openDatabase(":memory:");
  expect(() => new MediaStore(dataDir, db, { clock: clock(), limits: { ...DEFAULT_MEDIA_LIMITS, uploadsPerMinute: 0 } })).toThrow(RangeError);
  expect(
    () => new MediaStore(dataDir, db, { clock: clock(), limits: { ...DEFAULT_MEDIA_LIMITS, image: { maxFileBytes: 1.5, roomQuotaBytes: 10 } } }),
  ).toThrow(RangeError);
});
