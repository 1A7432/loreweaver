// `audio`, `bgm`, `ambience`, `sfx`: the text forms in both languages, query resolution and
// its refusals, strict volumes, the state each command leaves, and what a removal takes
// with it.
import { describe, expect, test } from "bun:test";

import { AUDIO_LIBRARY, readPlaying } from "../../../src/core/audio/index.ts";
import type { CommandOutcome, CommandSuccess } from "../../../src/gateway/commands/index.ts";
import { parseVolume, shellWords } from "../../../src/gateway/commands/engine/audio.ts";
import { ADA, ADMIN, bench, type Bench, code, ok, ROOM } from "./bench.ts";
import { seedSounds } from "./seed.ts";

async function typed(b: Bench, line: string, locale = "en"): Promise<CommandOutcome> {
  const outcome = await b.input(ADMIN, line, locale);
  if (outcome.kind !== "command") throw new Error(`${line} was speech`);
  return outcome.outcome;
}

function signalsOf(outcome: CommandSuccess): unknown[] {
  return outcome.signals.map((signal) => signal.data);
}

async function room(names?: readonly string[]): Promise<{ b: Bench; hashes: string[] }> {
  const b = bench({ media: true });
  return { b, hashes: await seedSounds(b, names) };
}

describe("playing a layer", () => {
  test(".bgm plays a library sound by name: one signal, and the layer's state", async () => {
    const { b, hashes } = await room();
    const played = ok(await typed(b, ".bgm play rain --volume 0.6 --fade 1200"));
    expect(played.text).toBe("BGM: playing Rain Night.");
    expect(played.events).toEqual([]);
    expect(signalsOf(played)).toEqual([
      { id: expect.any(String), action: "play", layer: "bgm", sound: hashes[0], hash: hashes[0], mime: "audio/ogg", size: expect.any(Number), title: "Rain Night", loop: true, volume: 0.6, fadeMs: 1200 },
    ]);
    expect(readPlaying(b.store, ROOM).bgm).toMatchObject({ sound: { id: hashes[0], title: "Rain Night" }, loop: true, volume: 0.6, paused: false });
  });

  test("the Chinese forms reach the same commands: 背景音乐 暂停 / 继续 / 音量 / 停止, 环境音, 音效", async () => {
    const { b } = await room();
    ok(await typed(b, ".背景音乐 播放 Tavern", "zh"));
    const paused = ok(await typed(b, "。背景音乐 暂停", "zh"));
    expect(paused.text).toBe("BGM：已暂停。");
    expect(readPlaying(b.store, ROOM).bgm?.paused).toBe(true);
    ok(await typed(b, ".背景音乐 继续", "zh"));
    expect(readPlaying(b.store, ROOM).bgm?.paused).toBe(false);
    ok(await typed(b, ".背景音乐 音量 30%", "zh"));
    expect(readPlaying(b.store, ROOM).bgm?.volume).toBe(0.3);
    ok(await typed(b, ".環境音 Rain Night", "zh"));
    expect(readPlaying(b.store, ROOM).ambience?.sound.title).toBe("Rain Night");
    const sfx = ok(await typed(b, ".音效 tavern", "zh"));
    expect(signalsOf(sfx)).toEqual([expect.objectContaining({ action: "play", layer: "sfx", loop: false })]);
    expect(Object.keys(readPlaying(b.store, ROOM)).sort()).toEqual(["ambience", "bgm"]);
    const stopped = ok(await typed(b, "/背景音乐 停止", "zh"));
    expect(signalsOf(stopped)).toEqual([expect.objectContaining({ action: "stop", layer: "bgm" })]);
    expect(Object.keys(readPlaying(b.store, ROOM))).toEqual(["ambience"]);
    ok(await typed(b, ".amb stop"));
    expect(readPlaying(b.store, ROOM)).toEqual({});
  });

  test("an sfx never becomes state; --once and --loop are read", async () => {
    const { b } = await room();
    ok(await typed(b, ".sfx rain"));
    expect(readPlaying(b.store, ROOM)).toEqual({});
    ok(await typed(b, ".ambience rain --once"));
    expect(readPlaying(b.store, ROOM).ambience?.loop).toBe(false);
    ok(await typed(b, ".sfx tavern --loop"));
    expect(Object.keys(readPlaying(b.store, ROOM))).toEqual(["ambience"]);
  });

  test("stop, pause, resume and volume on a layer with nothing playing are refused", async () => {
    const { b } = await room();
    expect(code(await typed(b, ".bgm stop"))).toBe("audio_not_playing");
    const refused = await typed(b, ".ambience pause");
    expect(refused).toMatchObject({ ok: false, code: "audio_not_playing", message: "Nothing is playing on Ambience." });
    expect(code(await b.run(ADMIN, "bgm", { op: "volume", volume: 0.5 }))).toBe("audio_not_playing");
  });

  test("volumes are read strictly: 0..1 or a percentage, never more, never text", async () => {
    const { b } = await room();
    ok(await typed(b, ".bgm rain"));
    for (const line of [".bgm volume 1.5", ".bgm volume 150%", ".bgm volume loud", ".bgm volume", ".bgm rain --volume 2", ".bgm volume -0.1"]) {
      expect([line, code(await typed(b, line))]).toEqual([line, "audio_bad_volume"]);
    }
    expect(code(await b.run(ADMIN, "bgm", { op: "volume", volume: 1.01 }))).toBe("invalid_arg");
    expect(code(await b.run(ADMIN, "bgm", { op: "volume", volume: "0.5" }))).toBe("invalid_arg");
    expect(code(await b.run(ADMIN, "bgm", { op: "volume" }))).toBe("missing_arg");
    expect(code(await b.run(ADMIN, "bgm", { op: "play", query: "rain", fadeMs: 60_001 }))).toBe("invalid_arg");
    expect(code(await typed(b, ".bgm rain --fade soon"))).toBe("audio_bad_fade");
    ok(await b.run(ADMIN, "bgm", { op: "volume", volume: 0 }));
    expect(readPlaying(b.store, ROOM).bgm?.volume).toBe(0);
    expect([parseVolume("0.75"), parseVolume(".5"), parseVolume("100%"), parseVolume("1"), parseVolume("1.0001"), parseVolume("0x1"), parseVolume("1e-1")]).toEqual([0.75, 0.5, 1, 1, null, null, null]);
  });

  test("a query names by id, title, prefix or substring; several are ambiguous (five named at most); none is not found", async () => {
    const { b, hashes } = await room(["Rain Night.ogg", "Rain Day.ogg", "Rainy 1.ogg", "Rainy 2.ogg", "Rainy 3.ogg", "Rainy 4.ogg", "Tavern.ogg"]);
    const ambiguous = await typed(b, ".bgm rain");
    expect(ambiguous).toMatchObject({ ok: false, code: "audio_ambiguous" });
    expect(ambiguous.ok ? "" : ambiguous.message).toBe("rain matches 6 sounds: Rain Night, Rain Day, Rainy 1, Rainy 2, Rainy 3. Say which.");
    expect(ok(await typed(b, '.bgm "rain night"')).data).toMatchObject({ sound: { title: "Rain Night" } });
    expect(ok(await typed(b, `.bgm ${hashes[6]?.slice(0, 10)}`)).data).toMatchObject({ sound: { title: "Tavern" } });
    expect(ok(await typed(b, ".bgm Rain Day.ogg")).data).toMatchObject({ sound: { title: "Rain Day" } });
    expect(await typed(b, ".bgm organ")).toMatchObject({ ok: false, code: "audio_not_found", message: "No sound in the audio library matches organ." });
    expect(code(await typed(b, ".bgm"))).toBe("usage");
    expect(code(await typed(b, '.bgm "open quote'))).toBe("usage");
  });
});

describe("the library", () => {
  test(".audio list names every sound; set changes an upload's title, layer and tags", async () => {
    const { b, hashes } = await room();
    const listed = ok(await typed(b, ".audio"));
    expect(listed.text).toBe(["Audio library:", `• Rain Night (${hashes[0]?.slice(0, 12)}) — any layer`, `• Tavern (${hashes[1]?.slice(0, 12)}) — any layer`].join("\n"));
    expect(listed.data).toEqual({ sounds: [expect.objectContaining({ id: hashes[0], title: "Rain Night", layer: null, tags: [], source: { kind: "upload", id: null } }), expect.objectContaining({ title: "Tavern" })] });

    const set = ok(await typed(b, '.audio set tavern title="The Drunken Gull" layer=bgm tags=inn,night'));
    expect(set.data).toEqual({ id: hashes[1], title: "The Drunken Gull", layer: "bgm", tags: ["inn", "night"] });
    expect(ok(await typed(b, ".音频 列表", "zh")).text).toContain("• The Drunken Gull（");
    ok(await typed(b, ".audio set gull layer=none tags="));
    expect(b.store.stateGet(ROOM, AUDIO_LIBRARY)?.[1]).toMatchObject({ title: "The Drunken Gull", layer: null, tags: [] });

    expect(code(await typed(b, ".audio set gull"))).toBe("usage");
    expect(code(await typed(b, ".audio set gull layer=voice"))).toBe("invalid_arg");
    expect(code(await b.run(ADMIN, "audio", { op: "set", query: "gull", tags: ["a", "a"] }))).toBe("audio_bad_tags");
    expect(code(await b.run(ADMIN, "audio", { op: "set", query: "gull", title: "x".repeat(401) }))).toBe("invalid_arg");
    expect(code(await b.run(ADMIN, "audio", { op: "set", query: "gull", tags: Array.from({ length: 17 }, (_, n) => `t${n}`) }))).toBe("invalid_arg");
  });

  test("removing a sound that plays stops it, and its bytes go after the removal committed", async () => {
    const { b, hashes } = await room();
    ok(await typed(b, ".bgm rain"));
    ok(await typed(b, ".ambience tavern"));
    const removed = ok(await typed(b, ".audio remove rain"));
    expect(removed.text).toBe("Removed from the library: Rain Night. It was playing and has stopped.");
    expect(signalsOf(removed)).toEqual([expect.objectContaining({ action: "stop", layer: "bgm", sound: hashes[0] })]);
    expect(readPlaying(b.store, ROOM)).toEqual({ ambience: expect.objectContaining({ sound: expect.objectContaining({ title: "Tavern" }) }) });
    expect(b.store.stateGet(ROOM, AUDIO_LIBRARY)?.map((entry) => entry.title)).toEqual(["Tavern"]);
    expect(b.uploads?.media.find(ROOM, hashes[0] as string, "admin")).toBeDefined();
    await removed.after?.();
    expect(b.uploads?.media.find(ROOM, hashes[0] as string, "admin")).toBeUndefined();

    const quiet = ok(await typed(b, ".音频 删除 tavern", "zh"));
    expect(quiet.text).toBe("已从音频库移除：Tavern。它正在播放，已停止。");
    expect(b.store.stateGet(ROOM, AUDIO_LIBRARY)).toBeNull();
    expect(code(await typed(b, ".audio remove tavern"))).toBe("audio_not_found");
  });

  test(".audio import is gone, and says where pack sounds come from now", async () => {
    const { b } = await room();
    expect(await typed(b, ".audio import harbor")).toMatchObject({ ok: false, code: "audio_import_gone" });
  });

  test("all four are the admin's; without a media store none is available", async () => {
    const { b } = await room();
    for (const id of ["audio", "bgm", "ambience", "sfx"]) expect(code(await b.run(ADA, id, { op: id === "audio" ? "list" : "stop" }))).toBe("forbidden");
    const bare = bench();
    for (const id of ["audio", "bgm", "ambience", "sfx"]) expect(code(await bare.run(ADMIN, id, { op: id === "audio" ? "list" : "stop" }))).toBe("no_media");
  });

  test("an undo leaves the music playing; a reset of everything clears the library and what plays", async () => {
    const { b } = await room();
    ok(await typed(b, ".bgm rain"));
    ok(await b.run(ADA, "roll", { expr: "1d6" }));
    ok(await typed(b, ".bgm volume 0.4"));
    ok(await typed(b, ".undo 2"));
    expect(readPlaying(b.store, ROOM).bgm).toMatchObject({ sound: { title: "Rain Night" }, volume: 0.4 });
    expect(b.store.stateGet(ROOM, AUDIO_LIBRARY)).toHaveLength(2);

    ok(await typed(b, ".reset story"));
    ok(await typed(b, ".reset story confirm"));
    expect(readPlaying(b.store, ROOM).bgm).toBeDefined();
    ok(await typed(b, ".reset all"));
    ok(await typed(b, ".reset all confirm"));
    expect(readPlaying(b.store, ROOM)).toEqual({});
    expect(b.store.stateGet(ROOM, AUDIO_LIBRARY)).toBeNull();
  });
});

test("shell words keep quoted spaces, straight or curly, and refuse an open quote", () => {
  expect(shellWords('set "Rain Night" title=“雨 夜” tags=a,b')).toEqual(["set", "Rain Night", "title=雨 夜", "tags=a,b"]);
  expect(shellWords("  play  rain ")).toEqual(["play", "rain"]);
  expect(shellWords('title=""')).toEqual(["title="]);
  expect(shellWords('"open')).toBeNull();
});
