// The room's audio at the room: an admin's audio-library upload (and every refusal of
// one), the `audio` view per role, a pack's cues coming and going with the pack, and the
// Stage Director's cue landing in the same state the admin's commands move.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUDIO_VIEW_SCHEMA, type AudioView, type ServerFrame } from "loreweaver-protocol/v3";

import { installPack, loadInstalledPacks } from "../../src/cli/packs.ts";
import { AUDIO_LIBRARY, MAX_AUDIO_LIBRARY, readPlaying } from "../../src/core/audio/index.ts";
import { assemblePacks, type LoadedPack, RoomPacks } from "../../src/gateway/packs.ts";
import type { Member } from "../../src/gateway/room.ts";
import { DEFAULT_MEDIA_LIMITS, type MediaLimits } from "../../src/infra/media/index.ts";
import { writeZip } from "../../src/infra/zip.ts";
import { memberId } from "../../src/net/keystore.ts";
import { manifestYaml, packEntries, PNG_BYTES } from "../packs/fixture.ts";
import { sha256 } from "./card_files.ts";
import { oggFile } from "./commands/seed.ts";
import { KEYS, LANES_ON, resultFor, ROOM, RoomBench, scribeReply, signals, views, type BenchOptions } from "./room_bench.ts";
import { schemaProblems } from "./views/schema_check.ts";

const dir = mkdtempSync(join(tmpdir(), "loreweaver-room-audio-"));
let installed: readonly LoadedPack[] = [];

beforeAll(async () => {
  const dataDir = join(dir, "data");
  const file = join(dir, "harbor.lwpack");
  const entries = packEntries({}, manifestYaml());
  writeFileSync(file, writeZip(entries.sort((a, b) => (a.path === "pack.yaml" ? -1 : b.path === "pack.yaml" ? 1 : a.path < b.path ? -1 : 1))));
  const outcome = await installPack(dataDir, file, { yes: true, fetch: () => Promise.reject(new Error("offline")) });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  installed = loadInstalledPacks(dataDir).packs;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

const LIMITS: Partial<MediaLimits> = { audio: { maxFileBytes: 4096, roomQuotaBytes: 16_384 }, uploadsPerMinute: 10_000 };

function setup(options: BenchOptions = {}): RoomBench {
  const bench = new RoomBench({ media: LIMITS, packs: (media) => new RoomPacks({ packs: installed, skills: assemblePacks(installed).skills, media }), ...options });
  benches.push(bench);
  return bench;
}

function member(key: keyof typeof KEYS, role: Member["role"]): Member {
  return { connection: `${key}#test`, id: memberId(KEYS[key]), name: key, role, locale: "en", send: () => undefined };
}

const ROOT = member("root", "admin");
const ADA = member("ada", "player");

/** Offer `bytes` as `who` with `purpose` and send them; the PUT's outcome, or the offer's refusal code. */
async function upload(b: RoomBench, who: Member, bytes: Uint8Array, options: { readonly name?: string; readonly mime?: string; readonly purpose?: "audio" | "share" } = {}): Promise<string> {
  const room = b.hub.room(ROOM);
  const answer = room.offerUpload(who, { name: options.name ?? "sound.ogg", mime: options.mime ?? "audio/ogg", size: bytes.length, sha256: sha256(bytes), purpose: options.purpose ?? "audio" });
  if (!answer.ok) return answer.code;
  const data = answer.data as { upload_id?: string };
  if (data.upload_id === undefined) return "existing";
  const stored = await room.receiveUpload(who, data.upload_id, bytes);
  await b.settled();
  return stored.ok ? "stored" : stored.code;
}

function audioOf(frames: readonly ServerFrame[]): AudioView {
  return views(frames, "audio").at(-1)?.data as AudioView;
}

function subscribe(b: RoomBench, key: string): ReturnType<RoomBench["join"]> {
  const wire = b.join(key);
  wire.receive({ type: "call", rid: "sub", method: "view.subscribe", params: { names: ["audio"] } });
  return wire;
}

async function say(b: RoomBench, wire: ReturnType<RoomBench["join"]>, rid: string, text: string): Promise<ServerFrame | undefined> {
  wire.receive({ type: "input", rid, text });
  await b.settled();
  return resultFor(wire.sent, rid);
}

describe("an audio-library upload", () => {
  test("an admin's goes into the library, fetchable by every member and announced by no event; the view shows it", async () => {
    const b = setup();
    const ada = subscribe(b, KEYS.ada);
    const root = subscribe(b, KEYS.root);
    await b.settled();
    expect(audioOf(ada.sent)).toEqual({ library: [], playing: {} });
    const bytes = oggFile("night rain");
    expect(await upload(b, ROOT, bytes, { name: "Night Rain.ogg" })).toBe("stored");
    expect(b.media?.find(ROOM, sha256(bytes), "player")).toMatchObject({ audience: "members" });
    expect(b.media?.list(ROOM)).toEqual([]);
    expect(ada.sent.some((frame) => frame.type === "event")).toBe(false);
    expect(audioOf(root.sent).library).toEqual([{ hash: sha256(bytes), mime: "audio/ogg", size: bytes.length, id: sha256(bytes), title: "Night Rain", layer: null, tags: [], source: { kind: "upload", id: null } }]);
    expect(audioOf(ada.sent).library).toEqual([{ hash: sha256(bytes), mime: "audio/ogg", size: bytes.length }]);
    // The same bytes offered again: nothing travels, nothing is added twice.
    expect(await upload(b, ROOT, bytes, { name: "again.ogg" })).toBe("existing");
    expect(b.store.stateGet(ROOM, AUDIO_LIBRARY)).toHaveLength(1);
  });

  test("a player, an observer and a non-sound are refused; the file limit and the room's quota hold", async () => {
    const b = setup();
    expect(await upload(b, ADA, oggFile("mine"))).toBe("forbidden");
    expect(await upload(b, member("eve", "observer"), oggFile("watch"))).toBe("observer_upload");
    expect(await upload(b, ROOT, PNG_BYTES, { mime: "image/png", name: "map.png" })).toBe("media_bad_mime");
    expect(await upload(b, ROOT, oggFile("x".repeat(5000)))).toBe("media_too_large");
    for (let n = 0; n < 4; n++) expect(await upload(b, ROOT, oggFile(`${n}`.repeat(4000)))).toBe("stored");
    expect(await upload(b, ROOT, oggFile("5".repeat(1000)))).toBe("media_quota_exceeded");
    expect(b.store.stateGet(ROOM, AUDIO_LIBRARY)).toHaveLength(4);
  });

  test("a full library refuses before any bytes travel", async () => {
    const b = setup({ media: { audio: { maxFileBytes: 4096, roomQuotaBytes: 1 << 24 }, uploadsPerMinute: 10_000 } });
    for (let n = 0; n < MAX_AUDIO_LIBRARY; n++) expect(await upload(b, ROOT, oggFile(`sound ${n}`))).toBe("stored");
    expect(await upload(b, ROOT, oggFile("one too many"))).toBe("audio_library_full");
    // One already there still answers as held.
    expect(await upload(b, ROOT, oggFile("sound 3"))).toBe("existing");
  });

  test("the offer goes over the session with purpose audio; a player's is refused there too", async () => {
    const b = setup();
    const bytes = oggFile("over the wire");
    const root = b.join(KEYS.root);
    const ada = b.join(KEYS.ada);
    const params = { name: "wire.ogg", mime: "audio/ogg", size: bytes.length, sha256: sha256(bytes), purpose: "audio" };
    root.receive({ type: "call", rid: "o", method: "media.offer", params });
    ada.receive({ type: "call", rid: "o", method: "media.offer", params });
    expect(resultFor(root.sent, "o")).toMatchObject({ ok: true, data: { upload_id: expect.any(String) } });
    expect(resultFor(ada.sent, "o")).toMatchObject({ ok: false, error: { code: "forbidden", message: "You are not allowed to do that." } });
  });
});

describe("the audio view and the commands", () => {
  test("what plays reaches every member's view; a later member's first value already says so", async () => {
    const b = setup();
    const root = subscribe(b, KEYS.root);
    await upload(b, ROOT, oggFile("tavern"), { name: "Tavern.ogg" });
    const said = await say(b, root, "p", ".bgm tavern --volume 0.5");
    expect(said).toMatchObject({ ok: true, text: "BGM: playing Tavern." });
    expect(signals(root.sent, "audio").at(-1)?.data).toMatchObject({ action: "play", layer: "bgm", title: "Tavern", volume: 0.5 });
    const late = subscribe(b, KEYS.bao);
    await b.settled();
    expect(signals(late.sent, "audio")).toEqual([]);
    expect(audioOf(late.sent).playing).toEqual({ bgm: { id: sha256(oggFile("tavern")), title: "Tavern", hash: sha256(oggFile("tavern")), mime: "audio/ogg", size: oggFile("tavern").length, loop: true, volume: 0.5, paused: false } });
    await say(b, root, "s", ".bgm pause");
    expect(audioOf(late.sent).playing.bgm?.paused).toBe(true);
    expect(schemaProblems(AUDIO_VIEW_SCHEMA, audioOf(late.sent))).toEqual([]);
    expect(schemaProblems(AUDIO_VIEW_SCHEMA, audioOf(root.sent))).toEqual([]);
  });

  test("a player's library names nothing the table has not heard: no ids, titles, tags or packs", async () => {
    const b = setup();
    const root = subscribe(b, KEYS.root);
    const ada = subscribe(b, KEYS.ada);
    const eve = subscribe(b, KEYS.eve);
    await say(b, root, "e", ".pack enable harbor");
    await upload(b, ROOT, oggFile("secret"), { name: "SENTINEL-UPLOAD-NAME.ogg" });
    await say(b, root, "t", '.audio set sentinel title=SENTINEL-UPLOAD-TITLE tags=SENTINEL-TAG layer=sfx');
    const admin = audioOf(root.sent);
    expect(admin.library.map((sound) => sound.id)).toEqual([sha256(oggFile("secret")), "harbor/bell"]);
    for (const wire of [ada, eve]) {
      const seen = JSON.stringify(audioOf(wire.sent));
      for (const marker of ["SENTINEL", "harbor", "Harbor bell", "bell", "upload"]) expect([marker, seen.includes(marker)]).toEqual([marker, false]);
      expect(audioOf(wire.sent).library.map((sound) => Object.keys(sound).sort())).toEqual([
        ["hash", "mime", "size"],
        ["hash", "mime", "size"],
      ]);
    }
    // What plays is the table's: named for everyone.
    await say(b, root, "p", ".ambience harbor/bell");
    expect(audioOf(ada.sent).playing.ambience).toMatchObject({ id: "harbor/bell", title: "Harbor bell" });
  });

  test("a pack's cues appear when it is enabled and go when it is disabled — and what played one stops", async () => {
    const b = setup();
    const root = subscribe(b, KEYS.root);
    const ada = subscribe(b, KEYS.ada);
    await say(b, root, "l0", ".audio");
    expect(resultFor(root.sent, "l0")).toMatchObject({ ok: true, data: { sounds: [] } });
    await say(b, root, "e", ".pack enable harbor");
    expect(audioOf(root.sent).library).toEqual([expect.objectContaining({ id: "harbor/bell", title: "Harbor bell", layer: "ambience", source: { kind: "pack", id: "harbor" } })]);
    expect(await say(b, root, "set", ".audio set bell title=Mine")).toMatchObject({ ok: false, error: { code: "audio_read_only" } });
    expect(await say(b, root, "rm", ".audio remove bell")).toMatchObject({ ok: false, error: { code: "audio_read_only" } });
    expect(await say(b, root, "p", ".ambience bell")).toMatchObject({ ok: true });
    expect(audioOf(ada.sent).playing.ambience?.id).toBe("harbor/bell");
    const before = signals(ada.sent, "audio").length;
    await say(b, root, "d", ".pack disable harbor");
    expect(signals(ada.sent, "audio").slice(before).map((frame) => frame.data)).toEqual([expect.objectContaining({ action: "stop", layer: "ambience", sound: "harbor/bell" })]);
    expect(audioOf(ada.sent)).toEqual({ library: [], playing: {} });
    expect(readPlaying(b.store, ROOM)).toEqual({});
  });

  test("the Stage Director's cue goes through the same state: it shows in the view, and an admin's stop ends it", async () => {
    const director = JSON.stringify({ blocks: [], audio: [{ cue: "bell", action: "play" }], image: null, prepare: [] });
    const b = setup({ lanes: LANES_ON, scribe: () => scribeReply({ beat: "scene_change" }), director: () => director });
    const root = subscribe(b, KEYS.root);
    const ada = subscribe(b, KEYS.ada);
    await say(b, root, "e", ".pack enable harbor");
    await say(b, ada, "line", "I listen to the harbor.");
    await b.settled();
    expect(signals(ada.sent, "audio").map((frame) => frame.data)).toEqual([expect.objectContaining({ action: "play", layer: "ambience", sound: "harbor/bell", title: "Harbor bell", loop: true })]);
    expect(audioOf(ada.sent).playing).toEqual({ ambience: expect.objectContaining({ id: "harbor/bell", loop: true, paused: false }) });
    expect(await say(b, root, "s", ".ambience stop")).toMatchObject({ ok: true });
    expect(audioOf(ada.sent).playing).toEqual({});
  });
});
