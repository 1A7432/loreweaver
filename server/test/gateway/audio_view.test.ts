// The `audio` view as a function of the library and the stored layer state.
import { expect, test } from "bun:test";

import type { LibrarySound } from "../../src/core/audio/index.ts";
import { audioView } from "../../src/gateway/audio.ts";

const HASH = "a".repeat(64);
const GONE = "b".repeat(64);

function sound(hash: string, title: string): LibrarySound {
  return { id: hash, hash, mime: "audio/ogg", size: 10, title, layer: "bgm", tags: [], source: { kind: "upload" }, aliases: [] } as LibrarySound;
}

test("a layer is shown playing only while the room still holds the sound", () => {
  // A room brought in by an import may carry layer state naming a file that did not come with it.
  const playing = {
    bgm: { sound: { id: HASH, hash: HASH, mime: "audio/ogg", size: 10, title: "Rain" }, loop: true, volume: 1, paused: false },
    ambience: { sound: { id: GONE, hash: GONE, mime: "audio/ogg", size: 10, title: "Wind" }, loop: true, volume: 1, paused: false },
  };
  for (const role of ["admin", "player", "observer"] as const) {
    const view = audioView([sound(HASH, "Rain")], playing, role);
    expect(Object.keys(view.playing)).toEqual(["bgm"]);
    expect(view.playing.bgm?.hash).toBe(HASH);
  }
});

test("only an admin's library names its sounds", () => {
  const library = [sound(HASH, "The Betrayal")];
  expect(JSON.stringify(audioView(library, {}, "player"))).not.toContain("Betrayal");
  expect(JSON.stringify(audioView(library, {}, "observer"))).not.toContain("Betrayal");
  expect(JSON.stringify(audioView(library, {}, "admin"))).toContain("Betrayal");
});
