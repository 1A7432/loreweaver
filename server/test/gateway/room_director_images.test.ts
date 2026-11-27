// The Stage Director's pictures at the room: a picture is made from the pack's reference,
// stored as the room's own media and shown; with no image client at that moment none is
// made and the pack's own picture is shown instead. Until this test, the server never
// handed the Director an image client at all (the wiring existed, nobody passed it).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerFrame } from "loreweaver-protocol/v3";

import type { DirectorImageDeps } from "../../src/agent/lanes/director.ts";
import { installPack, loadInstalledPacks } from "../../src/cli/packs.ts";
import type { LaneSettings } from "../../src/gateway/lanes.ts";
import { assemblePacks, type LoadedPack, RoomPacks } from "../../src/gateway/packs.ts";
import { writeZip } from "../../src/infra/zip.ts";
import { manifestYaml, packEntries, PNG_BYTES } from "../packs/fixture.ts";
import { sha256 } from "./card_files.ts";
import { KEYS, resultFor, ROOM, RoomBench, scribeReply, type BenchOptions } from "./room_bench.ts";

const dir = mkdtempSync(join(tmpdir(), "loreweaver-room-director-images-"));
let installed: readonly LoadedPack[] = [];

beforeAll(async () => {
  const file = join(dir, "harbor.lwpack");
  const entries = packEntries({}, manifestYaml());
  writeFileSync(file, writeZip(entries.sort((a, b) => (a.path === "pack.yaml" ? -1 : b.path === "pack.yaml" ? 1 : a.path < b.path ? -1 : 1))));
  const outcome = await installPack(join(dir, "data"), file, { yes: true, fetch: () => Promise.reject(new Error("offline")) });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  installed = loadInstalledPacks(join(dir, "data")).packs;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

const PICTURES_ON: LaneSettings = { scribe: true, director: true, directorSettings: { imagesEnabled: true, maxImages: 2, pregenPerBeat: 0 } };
const PROPOSAL = JSON.stringify({ blocks: [], audio: [], image: { subject: "quay", prompt: "fog over the water" }, prepare: [] });
/** A different picture than the pack's reference: PNG bytes with a trailing chunk of our own. */
const MADE = new Uint8Array([...PNG_BYTES, 0, 0, 0, 0]);

function setup(options: BenchOptions): RoomBench {
  const bench = new RoomBench({
    media: true,
    packs: (media) => new RoomPacks({ packs: installed, skills: assemblePacks(installed).skills, media }),
    lanes: PICTURES_ON,
    scribe: () => scribeReply({ beat: "scene_change" }),
    director: () => PROPOSAL,
    ...options,
  });
  benches.push(bench);
  return bench;
}

/** What the server composes: the room's media to read the reference from and store the picture in. */
function deps(bench: () => RoomBench, calls: { prompt: string; reference: string }[]): DirectorImageDeps {
  return {
    generate: async (request) => {
      calls.push({ prompt: request.prompt, reference: sha256(request.reference.bytes) });
      return { bytes: MADE, mime: "image/png" };
    },
    readAsset: async (asset) => (await bench().media?.read(ROOM, asset.hash, "admin"))?.bytes ?? null,
    storeImage: async (bytes, mime, name) => {
      const stored = await bench().media?.registerServerBlob({ room: ROOM, bytes, mime, name, audience: "room" });
      return stored?.ok === true ? { hash: stored.record.hash, mime: stored.record.mime, size: stored.record.size } : null;
    },
  };
}

function pictures(frames: readonly ServerFrame[]): string[] {
  const out: string[] = [];
  for (const frame of frames) {
    if (frame.type !== "event" || frame.kind !== "blocks") continue;
    for (const block of (frame.data as { blocks: { kind: string; hash?: string }[] }).blocks) if (block.kind === "image" && block.hash !== undefined) out.push(block.hash);
  }
  return out;
}

async function play(b: RoomBench): Promise<{ readonly ada: ReturnType<RoomBench["join"]> }> {
  const root = b.join(KEYS.root);
  const ada = b.join(KEYS.ada);
  root.receive({ type: "input", rid: "e", text: ".pack enable harbor" });
  await b.settled();
  expect(resultFor(root.sent, "e")).toMatchObject({ ok: true });
  ada.receive({ type: "input", rid: "line", text: "I walk down to the quay." });
  await b.settled();
  return { ada };
}

test("a picture is made from the pack's reference, stored as the room's media, and shown to the table", async () => {
  const calls: { prompt: string; reference: string }[] = [];
  const b: RoomBench = setup({ images: () => deps(() => b, calls) });
  const { ada } = await play(b);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.reference).toBe(sha256(PNG_BYTES));
  expect(calls[0]?.prompt).toContain("fog over the water");
  expect(calls[0]?.prompt).toContain("ink wash");
  // The made picture, not the reference, is on the table — and a player may fetch it.
  expect(pictures(ada.sent)).toEqual([sha256(MADE)]);
  expect(b.media?.find(ROOM, sha256(MADE), "player")).toBeDefined();
});

test("with no image client at that moment nothing is generated: the pack's own picture is shown", async () => {
  // What an admin's `imagegen off` (or a server never given a provider) looks like to a pass.
  const b = setup({ images: () => null });
  const { ada } = await play(b);
  expect(pictures(ada.sent)).toEqual([sha256(PNG_BYTES)]);
});
