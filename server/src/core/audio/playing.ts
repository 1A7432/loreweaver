// What the room is playing, per layer, and the one function every audio transition goes
// through.
//
// A sound is played on a LAYER: `bgm` and `ambience` loop under the scene and are STATE —
// a member who connects later must hear them — while `sfx` is one-shot and never state. The
// state lives in the room (`AUDIO_PLAYING`) and the `audio` view shows it; the `audio`
// signal is only the transition. Every source of audio — the Stage Director's cues, the
// admin's `bgm` / `ambience` / `sfx` commands, a sound removed or a pack disabled while it
// plays — goes through `applyAudio`, which writes the state through the caller's writer
// and returns the very signal the caller sends. Nothing else makes an `audio` signal, so the
// state and the signals can never disagree.
//
// Lifecycle (as the reference server's `room_audio` facet: `reset_scope="all"`): what plays
// is the room's machinery, like its installed world, so `reset all` clears it (and every
// client stops on that `reset` event); a lighter reset replays the story to the same
// soundscape. An UNDO leaves it as it is: what is playing is the table's present, not the
// story's past — rewinding a turn does not un-play the music the table is hearing, and no
// signal would tell the clients to stop it if the state went back. The key is therefore
// declared `keptOnUndo`, and the store does not journal it.
import { charCount, type SignalPayloads } from "loreweaver-protocol/v3";

import { jsonStateKey, type StateKey } from "../../infra/lifecycle/declarations.ts";
import type { RoomWriter, Store } from "../../infra/store.ts";
import { AUDIO_LAYERS, type AudioLayer } from "../presentation/kit.ts";

export { AUDIO_LAYERS, type AudioLayer };

/** The layers whose sound is state: what a member connecting later must hear. */
export const STATEFUL_LAYERS = ["bgm", "ambience"] as const;
export type StatefulLayer = (typeof STATEFUL_LAYERS)[number];

export const AUDIO_ACTIONS = ["play", "stop", "pause", "resume", "volume"] as const;
export type AudioAction = (typeof AUDIO_ACTIONS)[number];

/** A sound's title, in code points: the cap a pack's cue title has (`MAX_KIT_TEXT_CHARS`), for uploads too. */
export const MAX_AUDIO_TITLE_CHARS = 400;
/** A sound's id: `<pack>/<cue>` (two slugs of at most 64) or a content hash (64). */
export const MAX_AUDIO_ID_CHARS = 129;
/** The longest fade a transition may ask for, in milliseconds. */
export const MAX_FADE_MS = 60_000;
/** The MIME types of sounds are short, known ones (`infra/media/policy.ts`). */
const MAX_MIME_CHARS = 64;

const HASH = /^[0-9a-f]{64}$/u;

export type AudioSignal = SignalPayloads["audio"];

/** A sound as a client fetches and names it. `id` is its library id. */
export interface AudioSound {
  readonly id: string;
  readonly hash: string;
  readonly mime: string;
  /** Bytes. */
  readonly size: number;
  readonly title: string;
}

/** What one stateful layer is playing. */
export interface LayerState {
  readonly sound: AudioSound;
  readonly loop: boolean;
  /** 0..1. */
  readonly volume: number;
  readonly paused: boolean;
}

/** What the room is playing: a layer with nothing playing is absent. */
export interface AudioPlaying {
  readonly bgm?: LayerState;
  readonly ambience?: LayerState;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isSound(value: unknown): value is AudioSound {
  if (!isRecord(value)) return false;
  const { id, hash, mime, size, title } = value;
  return (
    typeof id === "string" &&
    id !== "" &&
    charCount(id) <= MAX_AUDIO_ID_CHARS &&
    typeof hash === "string" &&
    HASH.test(hash) &&
    typeof mime === "string" &&
    mime.startsWith("audio/") &&
    mime.length <= MAX_MIME_CHARS &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    typeof title === "string" &&
    charCount(title) <= MAX_AUDIO_TITLE_CHARS
  );
}

function isLayerState(value: unknown): value is LayerState {
  return isRecord(value) && isSound(value.sound) && typeof value.loop === "boolean" && isVolume(value.volume) && typeof value.paused === "boolean";
}

function isPlaying(value: unknown): value is AudioPlaying {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!(STATEFUL_LAYERS as readonly string[]).includes(key)) return false;
    if (!isLayerState(value[key])) return false;
  }
  return true;
}

/** What each stateful layer is playing. See the file header for its lifecycle. */
export const AUDIO_PLAYING: StateKey<AudioPlaying> = jsonStateKey("audio.playing", { reset: "all" }, isPlaying, {
  keptOnUndo: "what is playing is the table's present, not the story's past: an undo sends no audio signal, so the state must stay what the clients hear",
  outsideBundle: "what plays may be an uploaded sound, a file of this room's media, which an import clears: a loaded room starts silent",
});

/** What the room is playing now; an unreadable value reads as nothing. */
export function readPlaying(store: Store, room: string): AudioPlaying {
  return store.stateGet(room, AUDIO_PLAYING) ?? {};
}

export function isStateful(layer: AudioLayer): layer is StatefulLayer {
  return (STATEFUL_LAYERS as readonly string[]).includes(layer);
}

/** One transition, as its source asks for it. */
export type AudioTransition =
  | {
      readonly action: "play";
      readonly layer: AudioLayer;
      readonly sound: AudioSound;
      /** Default: `bgm` and `ambience` loop, `sfx` does not. */
      readonly loop?: boolean;
      /** Default 1. */
      readonly volume?: number;
      readonly fadeMs?: number;
    }
  | { readonly action: "stop" | "pause" | "resume"; readonly layer: AudioLayer; readonly fadeMs?: number }
  | { readonly action: "volume"; readonly layer: AudioLayer; readonly volume: number; readonly fadeMs?: number };

export type AudioApplied =
  | { readonly ok: true; readonly signal: AudioSignal; readonly playing: AudioPlaying }
  /** `audio_not_playing`: stop, pause, resume or volume on a stateful layer with nothing on it. `audio_bad_transition`: a volume or fade out of range. */
  | { readonly ok: false; readonly code: "audio_not_playing" | "audio_bad_transition" };

function withLayer(playing: AudioPlaying, layer: StatefulLayer, state: LayerState | null): AudioPlaying {
  const out: { bgm?: LayerState; ambience?: LayerState } = { ...playing };
  if (state === null) delete out[layer];
  else out[layer] = state;
  return out;
}

/**
 * Apply one transition: write the room's state through `writer` (in the caller's
 * transaction, of the work the transition belongs to) and return the signal for the caller
 * to send — after its commit, and only then. `signalId` is the signal's own id (a fresh id
 * from the caller's clock). An `sfx` transition writes nothing; a stateful one on a layer
 * with nothing playing is refused, except `play`.
 */
export function applyAudio(writer: RoomWriter, store: Store, transition: AudioTransition, signalId: string): AudioApplied {
  const { layer } = transition;
  const fade = transition.fadeMs;
  if (fade !== undefined && !(Number.isSafeInteger(fade) && fade >= 0 && fade <= MAX_FADE_MS)) return { ok: false, code: "audio_bad_transition" };
  const faded = fade === undefined ? {} : { fadeMs: fade };
  const playing = readPlaying(store, writer.room);

  if (transition.action === "play") {
    const volume = transition.volume ?? 1;
    if (!isVolume(volume) || !isSound(transition.sound)) return { ok: false, code: "audio_bad_transition" };
    const loop = transition.loop ?? layer !== "sfx";
    const { sound } = transition;
    const signal: AudioSignal = {
      id: signalId,
      action: "play",
      layer,
      sound: sound.id,
      hash: sound.hash,
      mime: sound.mime,
      size: sound.size,
      ...(sound.title === "" ? {} : { title: sound.title }),
      loop,
      volume,
      ...faded,
    };
    if (!isStateful(layer)) return { ok: true, signal, playing };
    const next = withLayer(playing, layer, { sound: { id: sound.id, hash: sound.hash, mime: sound.mime, size: sound.size, title: sound.title }, loop, volume, paused: false });
    writer.statePut(AUDIO_PLAYING, next);
    return { ok: true, signal, playing: next };
  }

  if (transition.action === "volume" && !isVolume(transition.volume)) return { ok: false, code: "audio_bad_transition" };
  const base = { id: signalId, action: transition.action, layer, ...faded } as const;
  if (!isStateful(layer)) {
    const signal: AudioSignal = transition.action === "volume" ? { ...base, volume: transition.volume } : base;
    return { ok: true, signal, playing };
  }
  const current = playing[layer];
  if (current === undefined) return { ok: false, code: "audio_not_playing" };
  let next: AudioPlaying;
  let signal: AudioSignal = { ...base, sound: current.sound.id };
  switch (transition.action) {
    case "stop":
      next = withLayer(playing, layer, null);
      break;
    case "pause":
      next = withLayer(playing, layer, { ...current, paused: true });
      break;
    case "resume":
      next = withLayer(playing, layer, { ...current, paused: false });
      break;
    case "volume":
      next = withLayer(playing, layer, { ...current, volume: transition.volume });
      signal = { ...signal, volume: transition.volume };
      break;
  }
  if (Object.keys(next).length === 0) writer.stateDelete(AUDIO_PLAYING);
  else writer.statePut(AUDIO_PLAYING, next);
  return { ok: true, signal, playing: next };
}

/** The stateful layers playing a sound `matches` accepts, in layer order. */
export function layersPlaying(playing: AudioPlaying, matches: (sound: AudioSound) => boolean): StatefulLayer[] {
  return STATEFUL_LAYERS.filter((layer) => {
    const state = playing[layer];
    return state !== undefined && matches(state.sound);
  });
}
