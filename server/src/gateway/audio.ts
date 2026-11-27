// The room's audio, as the gateway assembles it: the library (the admin's uploads the room
// still holds, and the cues of the packs it enabled now), the `audio` view per viewer, and
// the bookkeeping around an upload or a removal. Every transition still goes through
// `applyAudio` (`core/audio`); this file only decides WHICH transitions follow from a
// change of the library (a sound removed, a pack disabled: what played from it stops).
import type { AudioView, Role, ViewAudioLayer, ViewAudioSound } from "loreweaver-protocol/v3";

import {
  applyAudio,
  AUDIO_LIBRARY,
  type AudioPlaying,
  type AudioSignal,
  type AudioSound,
  cueSoundId,
  type LibrarySound,
  layersPlaying,
  MAX_AUDIO_LIBRARY,
  readPlaying,
  STATEFUL_LAYERS,
  titleFromName,
  type UploadedSound,
  uploadedSound,
} from "../core/audio/index.ts";
import type { Clock } from "../infra/ids.ts";
import type { MediaRecord, MediaStore } from "../infra/media/index.ts";
import type { RoomWriter, Store } from "../infra/store.ts";
import type { RoomPacks } from "./packs.ts";

/** Where an audio-library upload is stored: unlisted, and fetchable by every member of the room (players must hear it). */
export const AUDIO_AUDIENCE = "members";

/** The uploaded entries as stored; an unreadable value reads as none. */
export function readUploads(store: Store, room: string): readonly UploadedSound[] {
  return store.stateGet(room, AUDIO_LIBRARY) ?? [];
}

/** Whether every member of the room can fetch these bytes: listed media, or unlisted for members. */
function fetchableByAll(media: MediaStore, room: string, hash: string): boolean {
  const record = media.find(room, hash, "admin");
  return record !== undefined && record.audience !== "admin";
}

/**
 * The room's library: its uploads whose bytes it still holds, then the cues of its enabled
 * packs. Empty on a server that keeps no files (no client could fetch a sound).
 */
export function roomLibrary(store: Store, room: string, packs: RoomPacks | null, media: MediaStore | null): LibrarySound[] {
  if (media === null) return [];
  const out: LibrarySound[] = readUploads(store, room)
    .filter((entry) => fetchableByAll(media, room, entry.hash))
    .map(uploadedSound);
  for (const { packId, cue, asset } of packs?.audioCues(store, room) ?? []) {
    out.push({
      id: cueSoundId(packId, cue.id),
      hash: asset.hash,
      mime: asset.mime,
      size: asset.size,
      title: cue.title === "" ? cue.id : cue.title,
      layer: cue.layer,
      tags: [],
      source: { kind: "pack", id: packId },
      aliases: [cue.id],
    });
  }
  return out;
}

/** A library sound as a transition plays it. */
export function soundOf(sound: LibrarySound): AudioSound {
  return { id: sound.id, hash: sound.hash, mime: sound.mime, size: sound.size, title: sound.title };
}

/** Stop every stateful layer playing a sound `matches` accepts: the signals to send after the commit. */
export function stopPlaying(writer: RoomWriter, store: Store, clock: Clock, matches: (sound: AudioSound) => boolean): AudioSignal[] {
  const signals: AudioSignal[] = [];
  for (const layer of layersPlaying(readPlaying(store, writer.room), matches)) {
    const stopped = applyAudio(writer, store, { action: "stop", layer }, clock.id());
    if (stopped.ok) signals.push(stopped.signal);
  }
  return signals;
}

export type AddUpload = "added" | "present" | "full";

/**
 * Put an uploaded sound into the room's library (an admin's `media.offer {purpose: "audio"}`
 * whose bytes arrived, or that the room already held). One already there keeps its metadata.
 */
export function addUpload(writer: RoomWriter, store: Store, record: MediaRecord, uploader: string, now: number): AddUpload {
  const entries = readUploads(store, writer.room);
  if (entries.some((entry) => entry.hash === record.hash)) return "present";
  if (entries.length >= MAX_AUDIO_LIBRARY) return "full";
  const entry: UploadedSound = { hash: record.hash, mime: record.mime, size: record.size, name: record.name, title: titleFromName(record.name), layer: null, tags: [], uploader, addedAt: now };
  writer.statePut(AUDIO_LIBRARY, [...entries, entry]);
  return "added";
}

/** Whether the library has room for one more upload of `hash` (one already there always fits). */
export function uploadFits(store: Store, room: string, hash: string): boolean {
  const entries = readUploads(store, room);
  return entries.length < MAX_AUDIO_LIBRARY || entries.some((entry) => entry.hash === hash);
}

function layerView(state: NonNullable<AudioPlaying["bgm"]>): ViewAudioLayer {
  const { sound } = state;
  return { id: sound.id, title: sound.title, hash: sound.hash, mime: sound.mime, size: sound.size, loop: state.loop, volume: state.volume, paused: state.paused };
}

/**
 * The `audio` view for a viewer with `role`. An admin sees every library sound with its
 * names; anyone else what fetching needs (hash, mime, size), once per distinct file — enough
 * to prefetch, nothing that names a sound before the table hears it. What plays is the
 * table's, named for everyone.
 */
export function audioView(library: readonly LibrarySound[], playing: AudioPlaying, role: Role): AudioView {
  const sounds: ViewAudioSound[] = [];
  if (role === "admin") {
    for (const sound of library) {
      sounds.push({
        hash: sound.hash,
        mime: sound.mime,
        size: sound.size,
        id: sound.id,
        title: sound.title,
        layer: sound.layer,
        tags: [...sound.tags],
        source: sound.source.kind === "pack" ? { kind: "pack", id: sound.source.id } : { kind: "upload", id: null },
      });
    }
  } else {
    const seen = new Set<string>();
    for (const sound of library) {
      if (seen.has(sound.hash)) continue;
      seen.add(sound.hash);
      sounds.push({ hash: sound.hash, mime: sound.mime, size: sound.size });
    }
  }
  // A layer is shown playing only while the room can still serve the sound. Removing a sound
  // or disabling its pack stops the layer itself; what is left is a room brought in by an
  // import, whose stored state may name a file that did not come with it.
  const held = new Set(library.map((sound) => sound.hash));
  const layers: AudioView["playing"] = {};
  for (const layer of STATEFUL_LAYERS) {
    const state = playing[layer];
    if (state !== undefined && held.has(state.sound.hash)) layers[layer] = layerView(state);
  }
  return { library: sounds, playing: layers };
}
