// What the media store accepts: the MIME types, the limits, the refusal vocabulary and
// the boundary patterns. Everything a client sends is checked against these exactly —
// refused when it does not match, never normalised into something that does.
import type { Role } from "loreweaver-protocol/v3";

import { SVG_MIME } from "./svg.ts";

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", SVG_MIME] as const;
export const AUDIO_MIMES = ["audio/mpeg", "audio/ogg", "audio/wav", "audio/flac", "audio/mp4", "audio/aac"] as const;
/**
 * Server-made HTML (the session report). Not an upload type: a client can never offer
 * it, and it enters the index only through `registerServerBlob` with an unlisted
 * audience.
 */
export const REPORT_MIME = "text/html";
/**
 * A card file brought for import (a SillyTavern card or a native lorecard as JSON). Accepted
 * from a member only as an UNLISTED upload (`MediaOffer.audience` other than `room`): it is
 * read by the server, never shown to the table as room media.
 */
export const CARD_JSON_MIME = "application/json";
/**
 * A room save (`save` export, and a save file an admin uploads to restore from): JSON, the
 * same type as a card file. What tells the two apart is the budget a blob was stored under
 * (`QuotaFamily` `save`), never the type: a save is stored only under the `admin` audience,
 * and only by a store call that says it is one.
 */
export const SAVE_MIME = CARD_JSON_MIME;

export type ImageMime = (typeof IMAGE_MIMES)[number];
export type AudioMime = (typeof AUDIO_MIMES)[number];
export type UploadMime = ImageMime | AudioMime;
/** What a member may send: the room-media types, and a card file when the upload is unlisted. */
export type MemberMime = UploadMime | typeof CARD_JSON_MIME;
export type StoredMime = MemberMime | typeof REPORT_MIME;

/**
 * The budget a blob counts against. Reports and card files share the image budget: they are
 * small documents. A room save is neither a picture nor a sound and is far larger than either
 * document, so it has a budget of its own.
 */
export type QuotaFamily = "image" | "audio" | "save";
export const QUOTA_FAMILIES: readonly QuotaFamily[] = ["image", "audio", "save"];

export function isImageMime(mime: string): mime is ImageMime {
  return (IMAGE_MIMES as readonly string[]).includes(mime);
}

export function isAudioMime(mime: string): mime is AudioMime {
  return (AUDIO_MIMES as readonly string[]).includes(mime);
}

/** The budget of a blob that is not a save (a save says so itself: it shares its type with a card file). */
export function quotaFamily(mime: StoredMime): Exclude<QuotaFamily, "save"> {
  return isAudioMime(mime) ? "audio" : "image";
}

/**
 * Who may see an indexed blob. `room` is ordinary room media: listed, and fetchable by
 * every member. The other two are unlisted — never in a listing, so never broadcast,
 * replayed or exported: `members` is fetchable by any member of the room, `admin` only
 * by an admin of the room, and for anyone else it is the same as a hash the room does
 * not hold.
 */
export type Audience = "room" | "members" | "admin";
export const AUDIENCES: readonly Audience[] = ["room", "members", "admin"];

/** The audiences a member with `role` may fetch; no role means listed media only. */
export function audiencesFor(role: Role | undefined): readonly Audience[] {
  if (role === undefined) return ["room"];
  return role === "admin" ? AUDIENCES : ["room", "members"];
}

export interface FamilyLimits {
  readonly maxFileBytes: number;
  readonly roomQuotaBytes: number;
}

export interface MediaLimits {
  readonly image: FamilyLimits;
  readonly audio: FamilyLimits;
  readonly save: FamilyLimits;
  /** Offers one member may make in one room per minute, as a refilling bucket. */
  readonly uploadsPerMinute: number;
  /** How long an accepted offer waits for its bytes before it is forgotten. */
  readonly pendingUploadTtlMs: number;
}

const MIB = 1024 * 1024;

/** The largest room save the server stores, exported or uploaded. */
export const MAX_SAVE_FILE_BYTES = 256 * MIB;
/**
 * The save budget of one room: the room's latest export and one save upload in flight. A new
 * export removes the previous one before it is stored, and an import (or a refused one)
 * removes the upload it read, so two files is all a room ever needs at once.
 */
export const SAVE_ROOM_QUOTA_BYTES = 2 * MAX_SAVE_FILE_BYTES;

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  image: { maxFileBytes: 8 * MIB, roomQuotaBytes: 512 * MIB },
  audio: { maxFileBytes: 128 * MIB, roomQuotaBytes: 2048 * MIB },
  save: { maxFileBytes: MAX_SAVE_FILE_BYTES, roomQuotaBytes: SAVE_ROOM_QUOTA_BYTES },
  uploadsPerMinute: 10,
  pendingUploadTtlMs: 15 * 60 * 1000,
};

/** Refuse a limits object a store could not enforce sensibly. */
export function checkLimits(limits: MediaLimits): void {
  const values = [
    limits.image.maxFileBytes,
    limits.image.roomQuotaBytes,
    limits.audio.maxFileBytes,
    limits.audio.roomQuotaBytes,
    limits.save.maxFileBytes,
    limits.save.roomQuotaBytes,
    limits.uploadsPerMinute,
    limits.pendingUploadTtlMs,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("media limits must be positive whole numbers");
  }
}

/** Every refusal the store gives, one stable code each. */
export const MEDIA_CODES = [
  /** A malformed field: room or member id, size, name type, upload id. */
  "media_bad_offer",
  /** The room's upload switch is off. */
  "media_disabled",
  "media_rate_limited",
  "media_bad_mime",
  "media_too_large",
  "media_bad_hash",
  "media_quota_exceeded",
  /** No accepted offer with that id for that member (never made, expired, used, or the room was cleared). */
  "media_unknown_upload",
  "media_size_mismatch",
  "media_hash_mismatch",
  /** The bytes do not start the way the declared type's files start. */
  "media_bad_signature",
  "media_bad_svg",
  /** The room already holds these bytes under another audience. */
  "media_bad_upload",
  /** Not held by the room, or not visible to the asking member — deliberately the same answer. */
  "media_not_found",
  /** The disk or the index failed; nothing was recorded. */
  "media_storage_failed",
] as const;

export type MediaCode = (typeof MEDIA_CODES)[number];

/** Lowercase hex sha256, exactly. */
export const HASH_RE = /^[0-9a-f]{64}$/;
/** Room ids and member ids: a short token of letters, digits and `_ . : -`. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const NAME_MAX_CODE_POINTS = 255;
const DEFAULT_NAME = "media";
// Controls, lone surrogates, the byte-order mark and the bidirectional overrides that
// would make a displayed name read differently from what it is.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cs}‎‏‪-‮⁦-⁩﻿]/gu;

/**
 * A client-supplied file name reduced to a safe base name. Names are metadata only —
 * never part of a path — so this is about what a client later displays or saves as.
 */
export function safeName(name: unknown): string {
  if (typeof name !== "string") return DEFAULT_NAME;
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const cleaned = base.replace(UNSAFE_NAME_CHARS, "").trim().replace(/^\.+/, "");
  const clipped = Array.from(cleaned).slice(0, NAME_MAX_CODE_POINTS).join("").trim();
  return clipped === "" ? DEFAULT_NAME : clipped;
}
