// The room's sound, from chat: `audio` (the admin lists the library, sets an uploaded
// sound's title, layer and tags, removes one) and one command per layer — `bgm`,
// `ambience`, `sfx` — to play, stop, pause, resume and set the volume. Admins only, as in
// the reference server (`gateway/commands/router.py`: GROUP_ADMIN on all four).
//
// Every transition goes through `applyAudio` (`core/audio`) with the command's writer: the
// room's state moves in the command's transaction and the signal it returns goes out after
// the commit, with the command's result.
//
// Dropped from the reference: `.audio import <pack>`, which copied a pack's sounds into the
// room. Enabling a pack is what makes its cues available now (`<pack>/<cue>` in the
// library), and disabling it takes them away; a copy would outlive the pack and need its
// own cleanup. The text form still recognises the word and says so. Also dropped: the
// `license` and `source` metadata nobody displayed.
import {
  applyAudio,
  AUDIO_LAYERS,
  AUDIO_LIBRARY,
  type AudioLayer,
  type AudioSignal,
  isTags,
  isTitle,
  type LibrarySound,
  MAX_AUDIO_CANDIDATES,
  MAX_AUDIO_TAG_CHARS,
  MAX_AUDIO_TAGS,
  MAX_AUDIO_TITLE_CHARS,
  MAX_FADE_MS,
  resolveSound,
  type UploadedSound,
} from "../../../core/audio/index.ts";
import { foldCase } from "../../../core/sheets/text.ts";
import { readUploads, roomLibrary, soundOf, stopPlaying } from "../../audio.ts";
import type { RoomPacks } from "../../packs.ts";
import type { Uploads } from "../../uploads.ts";
import { parseInteger } from "../parse.ts";
import { BOOLEAN, compact, integer, number, object, oneOf, type Schema, text } from "../schema.ts";
import { type Args, type CommandCall, type CommandSignal, type CommandSpec, type Done, refuse, type Refused } from "../types.ts";

const NO_MEDIA = "no_media";

const LIST_WORDS: ReadonlySet<string> = new Set(["list", "ls", "show", "列表", "查看"]);
const SET_WORDS: ReadonlySet<string> = new Set(["set", "meta", "metadata", "设置", "設置", "元数据", "元資料"]);
const REMOVE_WORDS: ReadonlySet<string> = new Set(["remove", "rm", "delete", "del", "删除", "刪除", "移除"]);
const IMPORT_WORDS: ReadonlySet<string> = new Set(["import", "load", "导入", "導入"]);
const PLAY_WORDS: ReadonlySet<string> = new Set(["play", "start", "播放", "开始", "開始"]);
const STOP_WORDS: ReadonlySet<string> = new Set(["stop", "停止"]);
const PAUSE_WORDS: ReadonlySet<string> = new Set(["pause", "暂停", "暫停"]);
const RESUME_WORDS: ReadonlySet<string> = new Set(["resume", "继续", "繼續"]);
const VOLUME_WORDS: ReadonlySet<string> = new Set(["volume", "vol", "音量"]);
const LAYER_NONE_WORDS: ReadonlySet<string> = new Set(["none", "any", "-", "无", "無"]);

/** An uploaded sound's id is its hash; a list shows this much of it (a prefix still resolves). */
const SHORT_HASH = 12;

const LAYER_OR_NULL: Schema = { type: ["string", "null"], enum: [...AUDIO_LAYERS] };

const AUDIO_PARAMS = object(
  {
    op: oneOf(["list", "set", "remove"]),
    query: text(MAX_AUDIO_TITLE_CHARS, 1),
    title: text(MAX_AUDIO_TITLE_CHARS, 1),
    layer: LAYER_OR_NULL,
    tags: { type: "array", items: text(MAX_AUDIO_TAG_CHARS, 1), maxItems: MAX_AUDIO_TAGS },
  },
  ["op"],
);

const LAYER_PARAMS = object(
  {
    op: oneOf(["play", "stop", "pause", "resume", "volume"]),
    query: text(MAX_AUDIO_TITLE_CHARS, 1),
    loop: BOOLEAN,
    volume: number(0, 1),
    fadeMs: integer(0, MAX_FADE_MS),
  },
  ["op"],
);

// ---------------------------------------------------------------------------
// Reading the text forms
// ---------------------------------------------------------------------------

/** Whitespace-separated words; a word in straight or curly double quotes (or single quotes) may hold spaces. Null: a quote left open. */
export function shellWords(rest: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  const closing: Readonly<Record<string, string>> = { '"': '"', "'": "'", "“": "”", "「": "」" };
  for (const ch of rest) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (Object.hasOwn(closing, ch)) {
      quote = closing[ch] as string;
      started = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) return null;
  if (started) words.push(current);
  return words;
}

/** A volume as typed: a number from 0 to 1, or a percentage from 0% to 100%. Anything else is null. */
export function parseVolume(word: string): number | null {
  const percent = /^(\d{1,3}(?:\.\d+)?)%$/u.exec(word);
  if (percent !== null) {
    const value = Number(percent[1]);
    return value <= 100 ? value / 100 : null;
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(word)) return null;
  const value = Number(word);
  return value <= 1 ? value : null;
}

function parseFade(word: string | undefined): number | Refused {
  const value = word === undefined ? null : parseInteger(word);
  return value === null || value < 0 || value > MAX_FADE_MS ? refuse("audio_bad_fade", { max: MAX_FADE_MS }) : value;
}

/** The play options the reference read (`--loop`, `--once`, `--volume X`, `--fade N`, and their bare and `key=value` forms); the rest is the query. */
function playOptions(words: readonly string[]): { query: string; loop?: boolean; volume?: number; fadeMs?: number } | Refused {
  const out: { query: string; loop?: boolean; volume?: number; fadeMs?: number } = { query: "" };
  const query: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string;
    const lowered = foldCase(word);
    const [key, value] = lowered.includes("=") ? [lowered.slice(0, lowered.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [lowered, undefined];
    if (value === undefined && (key === "--loop" || key === "loop")) out.loop = true;
    else if (value === undefined && (key === "--no-loop" || key === "--once" || key === "noloop" || key === "once")) out.loop = false;
    else if (["--volume", "volume", "vol", "--vol"].includes(key)) {
      const given = value ?? words[++index];
      const volume = given === undefined ? null : parseVolume(given);
      if (volume === null) return refuse("audio_bad_volume");
      out.volume = volume;
    } else if (["--fade", "fade", "fade_ms", "--fade-ms"].includes(key)) {
      const fade = parseFade(value ?? words[++index]);
      if (typeof fade !== "number") return fade;
      out.fadeMs = fade;
    } else query.push(word);
  }
  out.query = query.join(" ").trim();
  return out;
}

function parseLayer(rest: string): Args | Refused {
  const words = shellWords(rest);
  if (words === null || words.length === 0) return refuse("usage");
  const first = foldCase(words[0] as string);
  const op = STOP_WORDS.has(first) ? "stop" : PAUSE_WORDS.has(first) ? "pause" : RESUME_WORDS.has(first) ? "resume" : VOLUME_WORDS.has(first) ? "volume" : null;
  if (op !== null) {
    let tail = words.slice(1);
    let volume: number | undefined;
    if (op === "volume") {
      const value = tail[0] === undefined ? null : parseVolume(tail[0]);
      if (value === null) return refuse("audio_bad_volume");
      volume = value;
      tail = tail.slice(1);
    }
    const options = playOptions(tail);
    if ("refused" in options) return options;
    if (options.query !== "" || options.loop !== undefined || options.volume !== undefined) return refuse("usage");
    return compact({ op, volume, fadeMs: options.fadeMs });
  }
  const options = playOptions(PLAY_WORDS.has(first) ? words.slice(1) : words);
  if ("refused" in options) return options;
  if (options.query === "") return refuse("usage");
  return compact({ op: "play", query: options.query, loop: options.loop, volume: options.volume, fadeMs: options.fadeMs });
}

function parseAudio(rest: string): Args | Refused {
  const words = shellWords(rest);
  if (words === null) return refuse("usage");
  if (words.length === 0) return { op: "list" };
  const first = foldCase(words[0] as string);
  const tail = words.slice(1);
  if (LIST_WORDS.has(first)) return tail.length === 0 ? { op: "list" } : refuse("usage");
  if (IMPORT_WORDS.has(first)) return refuse("audio_import_gone");
  if (REMOVE_WORDS.has(first)) return tail.length === 0 ? refuse("usage") : { op: "remove", query: tail.join(" ") };
  if (!SET_WORDS.has(first)) return refuse("usage");
  // `set <sound> title=… layer=… tags=a,b`: the words before the first `key=value` name the sound.
  const query: string[] = [];
  const out: { op: "set"; query?: string; title?: string; layer?: AudioLayer | null; tags?: string[] } = { op: "set" };
  let metadata = false;
  for (const word of tail) {
    const at = word.indexOf("=");
    const key = at > 0 ? foldCase(word.slice(0, at)) : "";
    const value = at > 0 ? word.slice(at + 1).trim() : "";
    if (key === "title" || key === "标题" || key === "標題") out.title = value;
    else if (key === "layer" || key === "层" || key === "層") {
      const layer = foldCase(value);
      if (LAYER_NONE_WORDS.has(layer)) out.layer = null;
      else if ((AUDIO_LAYERS as readonly string[]).includes(layer)) out.layer = layer as AudioLayer;
      else return refuse("invalid_arg", { path: "layer" });
    } else if (key === "tags" || key === "标签" || key === "標籤") {
      out.tags = value === "" ? [] : value.split(/[,，]/u).map((tag) => tag.trim());
    } else if (metadata) return refuse("usage");
    else {
      query.push(word);
      continue;
    }
    metadata = true;
  }
  if (query.length === 0 || !metadata) return refuse("usage");
  out.query = query.join(" ");
  return out;
}

// ---------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------

function signal(audio: AudioSignal): CommandSignal {
  return { kind: "audio", data: audio };
}

function layerLabel(call: CommandCall, layer: AudioLayer | null): string {
  return call.say(`audio.layer.${layer ?? "none"}`);
}

/** The library sound a query names, or the refusal that lists up to five candidates. */
function resolve(call: CommandCall, library: readonly LibrarySound[], query: string): LibrarySound | Refused {
  const found = resolveSound(library, query);
  if (found.status === "ok") return found.sound;
  if (found.status === "not_found") return refuse("audio_not_found", { query });
  const names = found.matches.slice(0, MAX_AUDIO_CANDIDATES).map((sound) => sound.title);
  return refuse("audio_ambiguous", { query, matches: names.join(call.say("list.separator")), count: found.matches.length });
}

function shortId(sound: LibrarySound): string {
  return sound.source.kind === "upload" ? sound.id.slice(0, SHORT_HASH) : sound.id;
}

/** The entry of `data` a library sound is stated as. */
function soundData(sound: LibrarySound): Record<string, unknown> {
  return { id: sound.id, title: sound.title, layer: sound.layer, tags: [...sound.tags], source: sound.source.kind === "pack" ? { kind: "pack", id: sound.source.id } : { kind: "upload", id: null } };
}

function libraryOf(call: CommandCall, uploads: Uploads, packs: RoomPacks): LibrarySound[] {
  return roomLibrary(call.context.services.store, call.context.room, packs, uploads.media);
}

function listAudio(call: CommandCall, uploads: Uploads, packs: RoomPacks): Done {
  const library = libraryOf(call, uploads, packs);
  if (library.length === 0) return { text: call.say("audio.empty"), data: { sounds: [] } };
  const lines = library.map((sound) => {
    const params = { title: sound.title, id: shortId(sound), layer: layerLabel(call, sound.layer) };
    return sound.tags.length === 0 ? call.say("audio.line", params) : call.say("audio.line_tags", { ...params, tags: sound.tags.join(call.say("list.separator")) });
  });
  return { text: [call.say("audio.header"), ...lines].join("\n"), data: { sounds: library.map(soundData) } };
}

function setAudio(call: CommandCall, uploads: Uploads, packs: RoomPacks, args: Args): Done | Refused {
  if (args.title === undefined && args.layer === undefined && args.tags === undefined) return refuse("usage");
  const found = resolve(call, libraryOf(call, uploads, packs), args.query as string);
  if ("refused" in found) return found;
  if (found.source.kind === "pack") return refuse("audio_read_only", { title: found.title });
  const title = args.title === undefined ? undefined : (args.title as string).trim();
  if (title !== undefined && (title === "" || !isTitle(title))) return refuse("invalid_arg", { path: "title" });
  const tags = args.tags === undefined ? undefined : (args.tags as string[]).map((tag) => tag.trim());
  if (tags !== undefined && !isTags(tags)) return refuse("audio_bad_tags", { max: MAX_AUDIO_TAGS, chars: MAX_AUDIO_TAG_CHARS });
  const { services, room, writer } = call.context;
  const entries = readUploads(services.store, room);
  const updated = entries.map((entry): UploadedSound =>
    entry.hash !== found.hash
      ? entry
      : {
          ...entry,
          ...(title === undefined ? {} : { title }),
          ...(args.layer === undefined ? {} : { layer: args.layer as AudioLayer | null }),
          ...(tags === undefined ? {} : { tags }),
        },
  );
  writer.statePut(AUDIO_LIBRARY, updated);
  const entry = updated.find((each) => each.hash === found.hash) as UploadedSound;
  return { text: call.say("audio.updated", { title: entry.title }), data: { id: found.id, title: entry.title, layer: entry.layer, tags: [...entry.tags] } };
}

function removeAudio(call: CommandCall, uploads: Uploads, packs: RoomPacks, args: Args): Done | Refused {
  const found = resolve(call, libraryOf(call, uploads, packs), args.query as string);
  if ("refused" in found) return found;
  if (found.source.kind === "pack") return refuse("audio_read_only", { title: found.title });
  const { services, room, writer } = call.context;
  const remaining = readUploads(services.store, room).filter((entry) => entry.hash !== found.hash);
  if (remaining.length === 0) writer.stateDelete(AUDIO_LIBRARY);
  else writer.statePut(AUDIO_LIBRARY, remaining);
  // What played it stops: the library no longer has it, and its bytes are about to go.
  const stopped = stopPlaying(writer, services.store, services.clock, (sound) => sound.id === found.id);
  const media = uploads.media;
  const store = services.store;
  return {
    text: call.say(stopped.length === 0 ? "audio.removed" : "audio.removed_stopped", { title: found.title }),
    data: { id: found.id, stopped: stopped.map((each) => each.layer) },
    signals: stopped.map(signal),
    // The bytes go once the removal committed — unless they are a shared file of the table's
    // log, or a file an enabled pack ships (both still need them).
    after: () => {
      const record = media.find(room, found.hash, "admin");
      if (record?.audience === "members" && !packs.shipsBytes(store, room, found.hash)) media.remove(room, found.hash);
      return Promise.resolve([]);
    },
  };
}

export function audioCommand(uploads: Uploads | null, packs: RoomPacks): CommandSpec {
  return {
    id: "audio",
    source: "engine",
    key: "audio",
    params: AUDIO_PARAMS,
    text: { en: ["audio"], zh: ["audio", "音频", "音訊"] },
    role: "admin",
    available: () => (uploads === null ? NO_MEDIA : true),
    parseText: (rest) => parseAudio(rest),
    run(call, args): Done | Refused {
      if (uploads === null) return refuse(NO_MEDIA);
      if (args.op === "list") return listAudio(call, uploads, packs);
      if (args.query === undefined) return refuse("missing_arg", { path: "query" });
      return args.op === "set" ? setAudio(call, uploads, packs, args) : removeAudio(call, uploads, packs, args);
    },
  };
}

const LAYER_FORMS: Readonly<Record<AudioLayer, { readonly en: readonly string[]; readonly zh: readonly string[] }>> = {
  bgm: { en: ["bgm"], zh: ["bgm", "背景音乐", "背景音樂"] },
  ambience: { en: ["ambience", "amb"], zh: ["ambience", "amb", "环境音", "環境音"] },
  sfx: { en: ["sfx"], zh: ["sfx", "音效"] },
};

/** `bgm`, `ambience` or `sfx`: play a library sound on that layer, or stop, pause, resume or change the volume of what it plays. */
export function layerCommand(layer: AudioLayer, uploads: Uploads | null, packs: RoomPacks): CommandSpec {
  return {
    id: layer,
    source: "engine",
    key: layer,
    params: LAYER_PARAMS,
    text: LAYER_FORMS[layer],
    role: "admin",
    available: () => (uploads === null ? NO_MEDIA : true),
    parseText: (rest) => parseLayer(rest),
    run(call, args): Done | Refused {
      if (uploads === null) return refuse(NO_MEDIA);
      const { services, writer } = call.context;
      const fade = args.fadeMs === undefined ? {} : { fadeMs: args.fadeMs as number };
      const label = layerLabel(call, layer);
      if (args.op === "play") {
        if (args.query === undefined) return refuse("missing_arg", { path: "query" });
        const found = resolve(call, libraryOf(call, uploads, packs), args.query as string);
        if ("refused" in found) return found;
        const applied = applyAudio(
          writer,
          services.store,
          { action: "play", layer, sound: soundOf(found), ...(args.loop === undefined ? {} : { loop: args.loop as boolean }), ...(args.volume === undefined ? {} : { volume: args.volume as number }), ...fade },
          services.clock.id(),
        );
        if (!applied.ok) return refuse(applied.code, { layer: label });
        return { text: call.say("audio.played", { layer: label, title: found.title }), data: { layer, action: "play", sound: soundData(found) }, signals: [signal(applied.signal)] };
      }
      const action = args.op as "stop" | "pause" | "resume" | "volume";
      if (action === "volume" && args.volume === undefined) return refuse("missing_arg", { path: "volume" });
      const applied = applyAudio(writer, services.store, action === "volume" ? { action, layer, volume: args.volume as number, ...fade } : { action, layer, ...fade }, services.clock.id());
      if (!applied.ok) return refuse(applied.code, { layer: label });
      const said =
        action === "volume"
          ? call.say("audio.volume_set", { layer: label, volume: Math.round((args.volume as number) * 100) })
          : action === "stop"
            ? call.say("audio.stopped", { layer: label })
            : action === "pause"
              ? call.say("audio.paused", { layer: label })
              : call.say("audio.resumed", { layer: label });
      return { text: said, data: { layer, action, ...(action === "volume" ? { volume: args.volume as number } : {}) }, signals: [signal(applied.signal)] };
    },
  };
}
