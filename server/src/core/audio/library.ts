// The room's audio library: the sounds an admin can play by name.
//
// Two sources, one list:
// - UPLOADS: sounds the room's admin uploaded (`media.offer {purpose: "audio"}`), kept here
//   as entries naming their bytes by hash, with the metadata an admin may set later
//   (title, layer, tags). Their id is their content hash.
// - PACK CUES: the cues of the presentation kits of the packs the room enabled, read-only,
//   named `<pack>/<cue>` so two packs' cues never collide. Nothing is copied: enabling a pack
//   is what makes its cues available, disabling it takes them away (the gateway assembles
//   the list, `gateway/audio.ts`).
//
// Names come from admins and packs: titles and tags are capped and counted in code points;
// over a cap is refused, never cut.
//
// Lifecycle: `reset all`, as the reference's `room_audio` facet (the library and the state
// went together there) — the room's media goes at the same scope, so a library that
// outlived it would name bytes nobody holds. An undo leaves it (`keptOnUndo`): an upload is
// not part of a turn, and its bytes in the media store are not rewound either.
import { charCount } from "loreweaver-protocol/v3";

import { foldCase } from "../sheets/text.ts";
import { jsonStateKey, type StateKey } from "../../infra/lifecycle/declarations.ts";
import { AUDIO_LAYERS, type AudioLayer } from "../presentation/kit.ts";
import { type AudioSound, isSound, MAX_AUDIO_TITLE_CHARS } from "./playing.ts";

/** Uploaded sounds a room keeps (the reference's library cap). */
export const MAX_AUDIO_LIBRARY = 100;
export const MAX_AUDIO_TAGS = 16;
export const MAX_AUDIO_TAG_CHARS = 32;
/** A file name, as the media store keeps it (`safeName`). */
const MAX_NAME_CHARS = 255;
/** Candidates a refusal names (the reference listed five). */
export const MAX_AUDIO_CANDIDATES = 5;

const HASH = /^[0-9a-f]{64}$/u;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

/** One uploaded sound, as the room keeps it. */
export interface UploadedSound {
  readonly hash: string;
  readonly mime: string;
  readonly size: number;
  /** The file name it was uploaded under. */
  readonly name: string;
  readonly title: string;
  /** The layer it is meant for; null when nobody said. */
  readonly layer: AudioLayer | null;
  readonly tags: readonly string[];
  /** The member id of the admin who uploaded it. */
  readonly uploader: string;
  readonly addedAt: number;
}

/** Where a library sound comes from. */
export type SoundSource = { readonly kind: "upload" } | { readonly kind: "pack"; readonly id: string };

/** One sound of the library, whatever its source. */
export interface LibrarySound extends AudioSound {
  readonly layer: AudioLayer | null;
  readonly tags: readonly string[];
  readonly source: SoundSource;
  /** Other names a query matches exactly: an upload's file name, a cue's bare id. */
  readonly aliases: readonly string[];
}

export function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && charCount(value) <= MAX_AUDIO_TITLE_CHARS;
}

export function isTag(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value !== "" && charCount(value) <= MAX_AUDIO_TAG_CHARS;
}

export function isTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_AUDIO_TAGS && value.every(isTag) && new Set(value).size === value.length;
}

function isUploaded(value: unknown): value is UploadedSound {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Readonly<Record<string, unknown>>;
  return (
    typeof entry.hash === "string" &&
    HASH.test(entry.hash) &&
    isSound({ id: entry.hash, hash: entry.hash, mime: entry.mime, size: entry.size, title: entry.title }) &&
    typeof entry.name === "string" &&
    charCount(entry.name) <= MAX_NAME_CHARS &&
    isTitle(entry.title) &&
    (entry.layer === null || (AUDIO_LAYERS as readonly unknown[]).includes(entry.layer)) &&
    isTags(entry.tags) &&
    typeof entry.uploader === "string" &&
    MEMBER_ID.test(entry.uploader) &&
    typeof entry.addedAt === "number" &&
    Number.isSafeInteger(entry.addedAt)
  );
}

function isLibrary(value: unknown): value is UploadedSound[] {
  return Array.isArray(value) && value.length <= MAX_AUDIO_LIBRARY && value.every(isUploaded) && new Set(value.map((entry) => (entry as UploadedSound).hash)).size === value.length;
}

/** The room's uploaded sounds, oldest first. See the file header for the lifecycle. */
export const AUDIO_LIBRARY: StateKey<UploadedSound[]> = jsonStateKey("audio.library", { reset: "all" }, isLibrary, {
  keptOnUndo: "an upload belongs to no turn, and its bytes in the media store are not rewound: the entry naming them must stay with them",
  outsideBundle: "it names files of this room's media, which an import clears: the loaded room does not hold them",
});

/** The id of a pack's cue in the library. */
export function cueSoundId(packId: string, cueId: string): string {
  return `${packId}/${cueId}`;
}

/** A file name's default title: the name without its extension. */
export function titleFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  return Array.from(stem).slice(0, MAX_AUDIO_TITLE_CHARS).join("").trim();
}

/** An uploaded entry as a library sound. */
export function uploadedSound(entry: UploadedSound): LibrarySound {
  return {
    id: entry.hash,
    hash: entry.hash,
    mime: entry.mime,
    size: entry.size,
    title: entry.title === "" ? entry.name : entry.title,
    layer: entry.layer,
    tags: [...entry.tags],
    source: { kind: "upload" },
    aliases: [entry.name],
  };
}

export type SoundResolution =
  | { readonly status: "ok"; readonly sound: LibrarySound }
  | { readonly status: "ambiguous"; readonly matches: readonly LibrarySound[] }
  | { readonly status: "not_found" };

function settle(matches: readonly LibrarySound[]): SoundResolution | null {
  if (matches.length === 1) return { status: "ok", sound: matches[0] as LibrarySound };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return null;
}

/**
 * Which sound a query names, as the reference resolved it: its id exactly; else exactly its
 * title (or an alias: an upload's file name, a cue's id without the pack); else a unique id
 * or title prefix; else a unique substring of the title, an alias or the id. Case-folded.
 * Several at one step are ambiguous, and the later steps are not tried.
 */
export function resolveSound(sounds: readonly LibrarySound[], query: string): SoundResolution {
  const needle = foldCase(query.trim());
  if (needle === "") return { status: "not_found" };
  const byId = sounds.filter((sound) => foldCase(sound.id) === needle);
  if (byId.length > 0) return { status: "ok", sound: byId[0] as LibrarySound };
  const names = (sound: LibrarySound): string[] => [sound.title, ...sound.aliases].map(foldCase);
  return (
    settle(sounds.filter((sound) => names(sound).includes(needle))) ??
    settle(sounds.filter((sound) => foldCase(sound.id).startsWith(needle) || foldCase(sound.title).startsWith(needle))) ??
    settle(sounds.filter((sound) => foldCase(sound.id).includes(needle) || names(sound).some((name) => name.includes(needle)))) ?? { status: "not_found" }
  );
}
