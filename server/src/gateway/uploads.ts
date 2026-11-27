// Members' files, as the gateway sees them: an offer, the bytes that follow it, a fetch, the
// room's upload switch — and which import and save files each member brought.
//
// The media store decides everything about bytes (types, sizes, quotas, the rate, the
// signatures, who may fetch what). This layer adds only what the store cannot know: what an
// upload is FOR. A `share` is listed room media, announced to the table. An `import` is a
// card file for the `import` command: stored under the `admin` audience (no player can fetch
// it — a character card may carry world machinery the import strips, and an admin's world
// card is keeper-side content by definition) and announced to nobody. The server reads it
// back as an admin would; the member who brought it is remembered, so that `import` takes
// only a file its caller uploaded. An `audio` upload is a sound for the room's audio library:
// an admin's only, sounds only, stored unlisted under `members` (every member must be able
// to fetch what plays), announced to nobody — the room puts it in the library
// (`gateway/audio.ts`) and the `audio` view shows it. A `save` upload is a room save for
// `save import`: an admin's only, JSON only, stored under the `admin` audience and against the
// save budget, announced to nobody, and remembered per member as an import file is — a save
// holds every secret of a room, so no player may ever fetch one or confirm one from its hash.
import type { MediaData, Role, UploadPurpose } from "loreweaver-protocol/v3";

import { CARD_JSON_MIME, isAudioMime, SAVE_MIME, type Audience, type MediaRecord, type MediaStore } from "../infra/media/index.ts";
import { AUDIO_AUDIENCE } from "./audio.ts";

/** Who may fetch an import file: the room's admins (and the server, reading it for `import`). */
export const IMPORT_AUDIENCE: Audience = "admin";
/** What a card file may be: a PNG with the card embedded, or the card as JSON. */
export const IMPORT_MIMES: readonly string[] = ["image/png", CARD_JSON_MIME];
/** Who may fetch a save file: the room's admins (and the server, reading it for `save import`). */
export const SAVE_AUDIENCE: Audience = "admin";
/** Import and save files remembered per member (newest kept); an older one must be offered again. */
export const MAX_IMPORT_CLAIMS_PER_MEMBER = 16;
/** Members whose import files are remembered at once, across rooms (oldest forgotten first). */
export const MAX_IMPORT_CLAIM_MEMBERS = 4096;

export interface UploadOffer {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly purpose: UploadPurpose;
}

/** Who is uploading: the member's stable id and role. */
export interface Uploader {
  readonly id: string;
  readonly role: Role;
}

export type OfferOutcome =
  | { readonly ok: true; readonly kind: "upload"; readonly uploadId: string }
  /** The room already holds the bytes: nothing to send. `share`: announce it to the table. `audio`: put it in the audio library. */
  | { readonly ok: true; readonly kind: "existing"; readonly record: MediaRecord; readonly share: boolean; readonly audio: boolean }
  | { readonly ok: false; readonly code: string };

export type ReceiveOutcome =
  /** `share`: listed room media, to announce to the table. `audio`: a sound for the audio library. */
  | { readonly ok: true; readonly record: MediaRecord; readonly share: boolean; readonly audio: boolean }
  | { readonly ok: false; readonly code: string };

/** A record as the `media` event (and the offer's `existing`) state it. */
export function mediaData(record: MediaRecord): MediaData {
  return { hash: record.hash, mime: record.mime, size: record.size, name: record.name, from: record.uploader };
}

export class Uploads {
  readonly media: MediaStore;
  /** `room \0 member` → the hashes of import files that member brought, oldest first. */
  readonly #claims = new Map<string, string[]>();

  constructor(media: MediaStore) {
    this.media = media;
  }

  /** Whether members may upload in `room` (the admin's switch). */
  enabled(room: string): boolean {
    return this.media.uploadsEnabled(room);
  }

  setEnabled(room: string, enabled: boolean): void {
    this.media.setUploadsEnabled(room, enabled);
  }

  /** `media.offer`: accept, answer that the bytes are already here, or refuse with the store's code. */
  offer(room: string, member: Uploader, offer: UploadOffer): OfferOutcome {
    if (member.role === "observer") return { ok: false, code: "observer_upload" };
    if (offer.purpose === "audio") {
      if (member.role !== "admin") return { ok: false, code: "forbidden" };
      if (!isAudioMime(offer.mime)) return { ok: false, code: "media_bad_mime" };
      // Bytes every member can already fetch (a shared sound, a pack's, an earlier upload)
      // need not travel again; the room's switch still governs, as for any upload.
      const held = this.media.find(room, offer.sha256, "admin");
      if (held !== undefined && held.audience !== IMPORT_AUDIENCE && isAudioMime(held.mime) && this.media.uploadsEnabled(room)) {
        return { ok: true, kind: "existing", record: held, share: false, audio: true };
      }
    }
    if (offer.purpose === "import") {
      if (!IMPORT_MIMES.includes(offer.mime)) return { ok: false, code: "media_bad_mime" };
      // Bytes this member may already see (or brought before) need not travel again; a copy
      // they may not see is never confirmed from its hash — they send the bytes, and the
      // store settles it. A save is never a card file.
      const seen = this.media.find(room, offer.sha256, member.role) ?? this.#own(room, member.id, offer.sha256);
      if (seen !== undefined && seen.family !== "save" && this.media.uploadsEnabled(room)) {
        this.#claim(room, member.id, seen.hash);
        return { ok: true, kind: "existing", record: seen, share: false, audio: false };
      }
    }
    if (offer.purpose === "save") {
      // Checked before anything that looks at the bytes: a player learns nothing about which
      // saves the room holds, not even whether the hash is one.
      if (member.role !== "admin") return { ok: false, code: "forbidden" };
      if (offer.mime !== SAVE_MIME) return { ok: false, code: "media_bad_mime" };
      // A save an admin may already fetch (the room's latest export, another admin's upload)
      // need not travel again.
      const held = this.media.find(room, offer.sha256, "admin");
      if (held !== undefined && held.family === "save" && this.media.uploadsEnabled(room)) {
        this.#claim(room, member.id, held.hash);
        return { ok: true, kind: "existing", record: held, share: false, audio: false };
      }
    }
    const begun = this.media.beginUpload({
      room,
      uploader: member.id,
      name: offer.name,
      mime: offer.mime,
      size: offer.size,
      sha256: offer.sha256,
      audience: offer.purpose === "import" ? IMPORT_AUDIENCE : offer.purpose === "save" ? SAVE_AUDIENCE : offer.purpose === "audio" ? AUDIO_AUDIENCE : "room",
      save: offer.purpose === "save",
    });
    if (!begun.ok) return begun;
    if (begun.kind === "existing") return { ok: true, kind: "existing", record: begun.record, share: true, audio: false };
    return begun;
  }

  /** How many bytes the member's accepted offer promised; undefined for an id that is not theirs or not waiting. */
  pendingSize(member: Uploader, uploadId: string): number | undefined {
    return this.media.pendingSize(uploadId, member.id);
  }

  /** The bytes of an accepted offer did not arrive whole: the offer is used up. */
  abandon(member: Uploader, uploadId: string): void {
    this.media.abandonUpload(uploadId, member.id);
  }

  /** The bytes of an accepted offer: checked and stored by the store. */
  async receive(room: string, member: Uploader, uploadId: string, bytes: Uint8Array): Promise<ReceiveOutcome> {
    const stored = await this.media.completeUpload(uploadId, member.id, bytes);
    if (!stored.ok) return stored;
    const record = stored.record;
    if (record.room !== room) return { ok: false, code: "media_unknown_upload" };
    // Import and save files alike (both `admin`): the member who brought one may use it.
    if (record.audience === IMPORT_AUDIENCE || record.audience === SAVE_AUDIENCE) this.#claim(room, member.id, record.hash);
    // Only an admin's audio upload is stored under `members` by a member (a pack's files are the server's).
    return { ok: true, record, share: record.audience === "room", audio: record.audience === AUDIO_AUDIENCE };
  }

  /** A fetch: the bytes when the room holds `hash` under an audience `role` may see. */
  read(room: string, role: Role, hash: string): Promise<{ record: MediaRecord; bytes: Uint8Array } | undefined> {
    return this.media.read(room, hash, role);
  }

  /**
   * The bytes of an import file `member` brought (an upload or an offer they made with that
   * hash); undefined otherwise — a hash the room does not hold and one somebody else brought
   * give the same answer.
   */
  importFile(room: string, memberId: string, hash: string): Promise<{ record: MediaRecord; bytes: Uint8Array } | undefined> {
    return this.#brought(room, memberId, hash, false);
  }

  /**
   * The bytes of a save file `member` brought (`purpose: "save"`: an upload, or an offer they
   * made with that hash); undefined otherwise, with the same one answer as `importFile`.
   */
  saveFile(room: string, memberId: string, hash: string): Promise<{ record: MediaRecord; bytes: Uint8Array } | undefined> {
    return this.#brought(room, memberId, hash, true);
  }

  async #brought(room: string, memberId: string, hash: string, save: boolean): Promise<{ record: MediaRecord; bytes: Uint8Array } | undefined> {
    const claimed = this.#claims.get(this.#key(room, memberId))?.includes(hash) === true;
    const record = this.media.find(room, hash, "admin");
    if (record === undefined || (record.family === "save") !== save) return undefined;
    if (!(claimed || (record.audience === IMPORT_AUDIENCE && record.uploader === memberId))) return undefined;
    return this.media.read(room, hash, "admin");
  }

  #own(room: string, memberId: string, hash: string): MediaRecord | undefined {
    const record = this.media.find(room, hash, "admin");
    return record !== undefined && record.audience === IMPORT_AUDIENCE && record.uploader === memberId ? record : undefined;
  }

  #key(room: string, memberId: string): string {
    return `${room}\u0000${memberId}`;
  }

  #claim(room: string, memberId: string, hash: string): void {
    const key = this.#key(room, memberId);
    const held = (this.#claims.get(key) ?? []).filter((item) => item !== hash);
    held.push(hash);
    // Re-inserted, so the member most recently heard from is the newest key.
    this.#claims.delete(key);
    this.#claims.set(key, held.slice(-MAX_IMPORT_CLAIMS_PER_MEMBER));
    while (this.#claims.size > MAX_IMPORT_CLAIM_MEMBERS) {
      const oldest = this.#claims.keys().next().value;
      if (oldest === undefined) break;
      this.#claims.delete(oldest);
    }
  }
}
