// What the server hands the Stage Director for its pictures: the image client as it is at
// that moment, and the room's own media.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { directorImagesFrom } from "../../src/cli/compose.ts";
import type { ImageGenerator, ImageRequest } from "../../src/infra/imagegen/index.ts";
import { MediaStore } from "../../src/infra/media/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { testClock } from "../helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "loreweaver-director-images-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MADE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

test("the client is asked for at each pass, the reference is read from the room and the picture kept in it", async () => {
  const media = new MediaStore(dir, openDatabase(":memory:"), { clock: testClock() });
  const reference = await media.registerServerBlob({ room: "table", bytes: PNG, mime: "image/png", name: "quay.png", audience: "admin" });
  expect(reference.ok).toBe(true);

  const seen: ImageRequest[] = [];
  const client: ImageGenerator = {
    generate: async (request) => {
      seen.push(request);
      return { bytes: MADE, mime: "image/png" };
    },
  };
  let now: ImageGenerator | null = null;
  const imagesFor = directorImagesFrom(() => now, media);

  // No client now (never configured, or an admin's `imagegen off`): nothing to hand over.
  expect(imagesFor("table")).toBeNull();
  // An admin switches it on: the very next pass has it, without a restart.
  now = client;
  const deps = imagesFor("table");
  if (deps === null) throw new Error("no deps");

  const asset = { hash: sha(PNG), mime: "image/png", size: PNG.length };
  // A pack's reference is readable whatever its audience — but only in ITS room.
  expect(await deps.readAsset(asset)).toEqual(PNG);
  expect(await imagesFor("elsewhere")?.readAsset(asset)).toBeNull();

  const made = await deps.generate({ prompt: "fog", reference: { bytes: PNG, mime: "image/png" } });
  expect(seen).toEqual([{ prompt: "fog", reference: { bytes: PNG, mime: "image/png" } }]);
  // A reference that is not a raster picture cannot condition one: refused before any request.
  await expect(deps.generate({ prompt: "fog", reference: { bytes: PNG, mime: "image/svg+xml" } })).rejects.toMatchObject({ code: "bad_request" });
  expect(seen).toHaveLength(1);

  const stored = await deps.storeImage(made.bytes, made.mime, "quay.png");
  expect(stored).toEqual({ hash: sha(MADE), mime: "image/png", size: MADE.length });
  // The picture is the room's: a player there may fetch it, nobody elsewhere.
  expect(media.find("table", sha(MADE), "player")).toBeDefined();
  expect(media.find("elsewhere", sha(MADE), "admin")).toBeUndefined();
});
