// The room's audio state and library: every transition through `applyAudio`, `sfx` never
// state, the lifecycle (reset all clears, a lighter reset keeps, an undo leaves it), the
// library's caps and how a query names a sound.
import { describe, expect, test } from "bun:test";

import {
  applyAudio,
  AUDIO_LIBRARY,
  AUDIO_PLAYING,
  type AudioSound,
  type LibrarySound,
  MAX_AUDIO_LIBRARY,
  MAX_AUDIO_TAGS,
  readPlaying,
  resolveSound,
  titleFromName,
  type UploadedSound,
} from "../../../src/core/audio/index.ts";
import { DocumentTypes } from "../../../src/core/documents/model.ts";
import { documentCatalog } from "../../../src/core/documents/raw.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { Store } from "../../../src/infra/store.ts";

const ROOM = "audio-room";

const RAIN: AudioSound = { id: "harbor/rain", hash: "a".repeat(64), mime: "audio/ogg", size: 120, title: "Rain" };
const TAVERN: AudioSound = { id: "b".repeat(64), hash: "b".repeat(64), mime: "audio/mpeg", size: 300, title: "Tavern" };

function room(): Store {
  return new Store(openDatabase(":memory:"));
}

let ids = 0;
function id(): string {
  return `signal-${++ids}`;
}

describe("applyAudio", () => {
  test("play sets the layer and says so; stop clears it; pause, resume and volume change it", () => {
    const store = room();
    const writer = store.beginTurn(ROOM);
    const played = applyAudio(writer, store, { action: "play", layer: "bgm", sound: RAIN, fadeMs: 500 }, "s1");
    expect(played).toEqual({
      ok: true,
      signal: { id: "s1", action: "play", layer: "bgm", sound: "harbor/rain", hash: RAIN.hash, mime: "audio/ogg", size: 120, title: "Rain", loop: true, volume: 1, fadeMs: 500 },
      playing: { bgm: { sound: RAIN, loop: true, volume: 1, paused: false } },
    });
    expect(readPlaying(store, ROOM)).toEqual({ bgm: { sound: RAIN, loop: true, volume: 1, paused: false } });

    expect(applyAudio(writer, store, { action: "pause", layer: "bgm" }, "s2")).toMatchObject({ ok: true, signal: { id: "s2", action: "pause", layer: "bgm", sound: "harbor/rain" } });
    expect(readPlaying(store, ROOM).bgm?.paused).toBe(true);
    applyAudio(writer, store, { action: "resume", layer: "bgm" }, id());
    expect(readPlaying(store, ROOM).bgm?.paused).toBe(false);
    expect(applyAudio(writer, store, { action: "volume", layer: "bgm", volume: 0.25 }, "s3")).toMatchObject({ ok: true, signal: { action: "volume", volume: 0.25 } });
    expect(readPlaying(store, ROOM).bgm?.volume).toBe(0.25);

    // Another layer is its own; a second play on a layer replaces what it played.
    applyAudio(writer, store, { action: "play", layer: "ambience", sound: TAVERN, loop: false, volume: 0.5 }, id());
    applyAudio(writer, store, { action: "play", layer: "bgm", sound: TAVERN }, id());
    expect(readPlaying(store, ROOM)).toEqual({ bgm: { sound: TAVERN, loop: true, volume: 1, paused: false }, ambience: { sound: TAVERN, loop: false, volume: 0.5, paused: false } });

    expect(applyAudio(writer, store, { action: "stop", layer: "bgm", fadeMs: 2000 }, "s4")).toMatchObject({ ok: true, signal: { id: "s4", action: "stop", layer: "bgm", sound: TAVERN.id, fadeMs: 2000 } });
    applyAudio(writer, store, { action: "stop", layer: "ambience" }, id());
    expect(readPlaying(store, ROOM)).toEqual({});
    // Nothing left: the key itself is gone.
    expect(store.stateList(ROOM).has(AUDIO_PLAYING.name)).toBe(false);
  });

  test("sfx is one-shot: its signals carry no state, and stop on it needs nothing playing", () => {
    const store = room();
    const writer = store.beginTurn(ROOM);
    const played = applyAudio(writer, store, { action: "play", layer: "sfx", sound: RAIN }, "s1");
    expect(played).toMatchObject({ ok: true, signal: { action: "play", layer: "sfx", loop: false, sound: "harbor/rain" } });
    expect(readPlaying(store, ROOM)).toEqual({});
    expect(store.stateList(ROOM).size).toBe(0);
    expect(applyAudio(writer, store, { action: "stop", layer: "sfx" }, "s2")).toEqual({ ok: true, signal: { id: "s2", action: "stop", layer: "sfx" }, playing: {} });
  });

  test("a transition of a layer with nothing on it, and a volume or fade out of range, are refused and write nothing", () => {
    const store = room();
    const writer = store.beginTurn(ROOM);
    for (const action of ["stop", "pause", "resume"] as const) expect(applyAudio(writer, store, { action, layer: "ambience" }, id())).toEqual({ ok: false, code: "audio_not_playing" });
    expect(applyAudio(writer, store, { action: "volume", layer: "bgm", volume: 0.5 }, id())).toEqual({ ok: false, code: "audio_not_playing" });
    expect(applyAudio(writer, store, { action: "play", layer: "bgm", sound: RAIN, volume: 1.5 }, id())).toEqual({ ok: false, code: "audio_bad_transition" });
    expect(applyAudio(writer, store, { action: "play", layer: "bgm", sound: RAIN, fadeMs: -1 }, id())).toEqual({ ok: false, code: "audio_bad_transition" });
    expect(applyAudio(writer, store, { action: "play", layer: "bgm", sound: { ...RAIN, hash: "nope" } }, id())).toEqual({ ok: false, code: "audio_bad_transition" });
    expect(store.stateList(ROOM).size).toBe(0);
  });

  test("a stale writer cannot move the state", () => {
    const store = room();
    const writer = store.beginTurn(ROOM);
    store.reset(ROOM, "story", documentCatalog(new DocumentTypes()));
    expect(() => applyAudio(writer, store, { action: "play", layer: "bgm", sound: RAIN }, id())).toThrow();
    expect(readPlaying(store, ROOM)).toEqual({});
  });
});

describe("the lifecycle", () => {
  function playing(): Store {
    const store = room();
    const writer = store.beginTurn(ROOM);
    applyAudio(writer, store, { action: "play", layer: "bgm", sound: RAIN }, id());
    const entry: UploadedSound = { hash: TAVERN.hash, mime: TAVERN.mime, size: TAVERN.size, name: "tavern.mp3", title: "Tavern", layer: null, tags: [], uploader: "m-root", addedAt: 1 };
    writer.statePut(AUDIO_LIBRARY, [entry]);
    return store;
  }

  test("a story or characters reset keeps what plays and the library; a reset of everything clears both", () => {
    for (const scope of ["story", "chars"] as const) {
      const store = playing();
      store.reset(ROOM, scope, documentCatalog(new DocumentTypes()));
      expect(readPlaying(store, ROOM).bgm?.sound.id).toBe("harbor/rain");
      expect(store.stateGet(ROOM, AUDIO_LIBRARY)).toHaveLength(1);
    }
    const store = playing();
    store.reset(ROOM, "all", documentCatalog(new DocumentTypes()));
    expect(readPlaying(store, ROOM)).toEqual({});
    expect(store.stateGet(ROOM, AUDIO_LIBRARY)).toBeNull();
  });

  test("an undo leaves what plays, and the library, as they are — nothing it rewinds touches them", () => {
    const store = room();
    store.beginTurn(ROOM);
    const second = store.beginTurn(ROOM);
    applyAudio(second, store, { action: "play", layer: "bgm", sound: RAIN }, id());
    const third = store.beginTurn(ROOM);
    applyAudio(third, store, { action: "play", layer: "ambience", sound: TAVERN }, id());
    applyAudio(third, store, { action: "volume", layer: "bgm", volume: 0.3 }, id());
    third.statePut(AUDIO_LIBRARY, [{ hash: TAVERN.hash, mime: TAVERN.mime, size: TAVERN.size, name: "t.mp3", title: "T", layer: null, tags: [], uploader: "m-root", addedAt: 1 }]);
    const before = { playing: readPlaying(store, ROOM), library: store.stateGet(ROOM, AUDIO_LIBRARY) };
    store.undoTo(ROOM, 1);
    expect({ playing: readPlaying(store, ROOM), library: store.stateGet(ROOM, AUDIO_LIBRARY) }).toEqual(before);
    // Still the generation's: the undone turns' writers are refused.
    expect(() => applyAudio(third, store, { action: "stop", layer: "bgm" }, id())).toThrow();
  });
});

describe("the library", () => {
  const sound = (over: Partial<LibrarySound>): LibrarySound => ({ ...RAIN, layer: null, tags: [], source: { kind: "upload" }, aliases: [], ...over });
  const LIBRARY: LibrarySound[] = [
    sound({ id: "harbor/rain", title: "Rain on the quay", source: { kind: "pack", id: "harbor" }, aliases: ["rain"] }),
    sound({ id: "harbor/bell", title: "Harbor bell", source: { kind: "pack", id: "harbor" }, aliases: ["bell"] }),
    sound({ id: "c".repeat(64), hash: "c".repeat(64), title: "雨夜", aliases: ["rain-night.ogg"] }),
    sound({ id: "d".repeat(64), hash: "d".repeat(64), title: "Harbor at dawn", aliases: ["dawn.ogg"] }),
  ];
  const named = (query: string): string => {
    const found = resolveSound(LIBRARY, query);
    return found.status === "ok" ? found.sound.id : found.status === "ambiguous" ? `ambiguous:${found.matches.map((each) => each.id).join(",")}` : "not_found";
  };

  test("by id, then exact title or alias, then a unique prefix, then a unique substring", () => {
    expect(named("HARBOR/BELL")).toBe("harbor/bell");
    expect(named("Rain on the quay")).toBe("harbor/rain");
    // A cue's bare id and an upload's file name are names too.
    expect(named("rain")).toBe("harbor/rain");
    expect(named("rain-night.ogg")).toBe("c".repeat(64));
    expect(named("雨夜")).toBe("c".repeat(64));
    // A prefix of an upload's hash.
    expect(named("cccccccccccc")).toBe("c".repeat(64));
    expect(named("harbor b")).toBe("harbor/bell");
    expect(named("dawn")).toBe("d".repeat(64));
    expect(named("雨")).toBe("c".repeat(64));
  });

  test("several at one step are ambiguous; nothing is not found", () => {
    expect(named("harbor")).toBe(`ambiguous:harbor/rain,harbor/bell,${"d".repeat(64)}`);
    expect(named("qua")).toBe("harbor/rain");
    expect(named("organ")).toBe("not_found");
    expect(named("  ")).toBe("not_found");
  });

  test("the stored library refuses a value over its caps instead of cutting it", () => {
    const store = room();
    const writer = store.beginTurn(ROOM);
    const entry = (n: number, over: Partial<UploadedSound> = {}): UploadedSound => ({
      hash: n.toString(16).padStart(64, "0"),
      mime: "audio/ogg",
      size: 10,
      name: `${n}.ogg`,
      title: `${n}`,
      layer: null,
      tags: [],
      uploader: "m-root",
      addedAt: n,
      ...over,
    });
    writer.statePut(AUDIO_LIBRARY, Array.from({ length: MAX_AUDIO_LIBRARY + 1 }, (_, n) => entry(n)));
    expect(store.stateGet(ROOM, AUDIO_LIBRARY)).toBeNull();
    writer.statePut(AUDIO_LIBRARY, [entry(1, { tags: Array.from({ length: MAX_AUDIO_TAGS + 1 }, (_, n) => `t${n}`) })]);
    expect(store.stateGet(ROOM, AUDIO_LIBRARY)).toBeNull();
    writer.statePut(AUDIO_LIBRARY, [entry(1, { title: "雨".repeat(401) })]);
    expect(store.stateGet(ROOM, AUDIO_LIBRARY)).toBeNull();
    // Counted in code points: 400 CJK characters fit.
    writer.statePut(AUDIO_LIBRARY, [entry(1, { title: "雨".repeat(400), tags: ["夜"] })]);
    expect(store.stateGet(ROOM, AUDIO_LIBRARY)).toHaveLength(1);
  });

  test("an upload's default title is its file name without the extension", () => {
    expect(titleFromName("Rain Night.ogg")).toBe("Rain Night");
    expect(titleFromName(".hidden")).toBe(".hidden");
    expect(titleFromName("雨夜.mp3")).toBe("雨夜");
  });
});
