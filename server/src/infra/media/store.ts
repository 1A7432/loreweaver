// The media store: content-addressed blobs and a per-room index of which hashes belong
// to which room. A blob is stored once under its sha256 (`blobs.ts`); a row in `media`
// says a room holds it, with the metadata of that room's copy. Clients fetch by hash,
// and an answer is given only for a hash the asking member's room holds under an
// audience the member may see.
//
// Consistency rule: an index row never points at a missing file. Files are therefore
// published before their row is written and removed only after the last row naming
// them is gone; both decisions and their file operations run inside one synchronous
// stretch (SQLite calls are synchronous, `BlobDir.publish`/`remove` too), so no other
// store operation interleaves. The only inconsistency a failure can leave is the
// harmless one — a file no row names — and `sweep` removes those.
import { createHash } from "node:crypto";

import type { Role } from "loreweaver-protocol/v3";

import type { Clock } from "../ids.ts";
import type { Database, Statement } from "../runtime/sqlite.ts";
import { BlobDir } from "./blobs.ts";
import {
  AUDIENCES,
  audiencesFor,
  CARD_JSON_MIME,
  checkLimits,
  DEFAULT_MEDIA_LIMITS,
  HASH_RE,
  ID_RE,
  isAudioMime,
  isImageMime,
  quotaFamily,
  REPORT_MIME,
  safeName,
  type Audience,
  type MediaCode,
  type MediaLimits,
  type MemberMime,
  type QuotaFamily,
  type StoredMime,
} from "./policy.ts";
import { RateLimiter } from "./rate_limit.ts";
import { matchesSignature } from "./signatures.ts";

export interface MediaRecord {
  readonly room: string;
  readonly hash: string;
  readonly mime: StoredMime;
  /** Measured, in bytes. */
  readonly size: number;
  /** The client's file name reduced to a safe base name; metadata only. */
  readonly name: string;
  /** The member id that uploaded it, or `server` for server-made blobs. */
  readonly uploader: string;
  readonly createdAt: number;
  readonly audience: Audience;
}

/** What a client declares before sending bytes. Only the store decides what it means. */
export interface MediaOffer {
  readonly room: string;
  readonly uploader: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  /**
   * Who may fetch the stored file; `room` (listed room media) unless said otherwise. An
   * unlisted upload is never answered with an `existing` record (that would confirm a hidden
   * blob from its hash), and only it may be a card file (`CARD_JSON_MIME`).
   */
  readonly audience?: Audience;
}

export type Refusal = { readonly ok: false; readonly code: MediaCode };

export type BeginResult =
  | { readonly ok: true; readonly kind: "upload"; readonly uploadId: string }
  /** The room already holds these bytes as listed media: nothing to send. */
  | { readonly ok: true; readonly kind: "existing"; readonly record: MediaRecord }
  | Refusal;

export type StoreResult =
  /** `created` is false when the room already held these bytes under the same audience. */
  | { readonly ok: true; readonly record: MediaRecord; readonly created: boolean }
  | Refusal;

export interface ServerBlob {
  readonly room: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly name: string;
  readonly audience: Audience;
}

export interface MediaStoreOptions {
  readonly clock: Clock;
  readonly limits?: MediaLimits;
}

export const SERVER_UPLOADER = "server";

interface Pending {
  readonly room: string;
  readonly uploader: string;
  readonly name: string;
  readonly mime: MemberMime;
  readonly audience: Audience;
  readonly size: number;
  readonly hash: string;
  readonly expiresAt: number;
  /** The room's clear count when the offer was accepted; a clear since voids it. */
  readonly generation: number;
}

interface Row {
  room: string;
  hash: string;
  mime: string;
  size: number;
  name: string;
  uploader: string;
  created_at: number;
  audience: string;
}

interface Item {
  readonly room: string;
  readonly hash: string;
  readonly mime: StoredMime;
  readonly name: string;
  readonly uploader: string;
  readonly audience: Audience;
  readonly bytes: Uint8Array;
  /** The room's clear count when the request began; a clear since voids it. */
  readonly generation: number;
  /** A member's upload, which the room's switch also governs. */
  readonly byMember: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  room TEXT NOT NULL,
  hash TEXT NOT NULL,
  mime TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('image', 'audio')),
  size INTEGER NOT NULL CHECK (size > 0),
  name TEXT NOT NULL,
  uploader TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('room', 'members', 'admin')),
  PRIMARY KEY (room, hash)
) STRICT;
CREATE INDEX IF NOT EXISTS media_by_hash ON media (hash);
CREATE TABLE IF NOT EXISTS media_uploads_off (
  room TEXT PRIMARY KEY
) STRICT;
`;

const COLUMNS = "room, hash, mime, size, name, uploader, created_at, audience";

function toRecord(row: Row): MediaRecord {
  return {
    room: row.room,
    hash: row.hash,
    mime: row.mime as StoredMime,
    size: row.size,
    name: row.name,
    uploader: row.uploader,
    createdAt: row.created_at,
    audience: row.audience as Audience,
  };
}

function refuse(code: MediaCode): Refusal {
  return { ok: false, code };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class MediaStore {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #limits: MediaLimits;
  readonly #blobs: BlobDir;
  readonly #rate: RateLimiter;
  readonly #pending = new Map<string, Pending>();
  /** Bumped by `deleteRoom`, so an upload in flight across a clear does not land after it. */
  readonly #generations = new Map<string, number>();
  /** Temporary files being written right now; `sweep` leaves them alone. */
  readonly #inFlight = new Set<string>();

  readonly #get: Statement<Row>;
  readonly #listed: Statement<Row>;
  readonly #used: Statement<{ total: number }>;
  readonly #refs: Statement<{ n: number }>;
  readonly #insert: Statement<unknown>;
  readonly #roomHashes: Statement<{ hash: string }>;
  readonly #deleteRoom: Statement<unknown>;
  readonly #isOff: Statement<{ room: string }>;
  readonly #setOff: Statement<unknown>;
  readonly #setOn: Statement<unknown>;

  constructor(dataDir: string, db: Database, options: MediaStoreOptions) {
    const limits = options.limits ?? DEFAULT_MEDIA_LIMITS;
    checkLimits(limits);
    this.#db = db;
    this.#clock = options.clock;
    this.#limits = limits;
    this.#blobs = new BlobDir(dataDir);
    this.#rate = new RateLimiter(limits.uploadsPerMinute, () => this.#clock.now());
    db.exec(SCHEMA);
    this.#get = db.prepare(`SELECT ${COLUMNS} FROM media WHERE room = ? AND hash = ?`);
    this.#listed = db.prepare(`SELECT ${COLUMNS} FROM media WHERE room = ? AND audience = 'room' ORDER BY created_at, hash`);
    this.#used = db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM media WHERE room = ? AND family = ?");
    this.#refs = db.prepare("SELECT COUNT(*) AS n FROM media WHERE hash = ?");
    this.#insert = db.prepare(`INSERT INTO media (${COLUMNS}, family) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.#roomHashes = db.prepare("SELECT hash FROM media WHERE room = ?");
    this.#deleteRoom = db.prepare("DELETE FROM media WHERE room = ?");
    this.#isOff = db.prepare("SELECT room FROM media_uploads_off WHERE room = ?");
    this.#setOff = db.prepare("INSERT OR IGNORE INTO media_uploads_off (room) VALUES (?)");
    this.#setOn = db.prepare("DELETE FROM media_uploads_off WHERE room = ?");
  }

  // ---- the upload switch ----

  /** Whether members may upload in `room`. On unless an admin switched it off. */
  uploadsEnabled(room: string): boolean {
    return this.#isOff.get(room) === null;
  }

  /** Only the off state is stored, so switching back on leaves nothing behind. */
  setUploadsEnabled(room: string, enabled: boolean): void {
    if (!ID_RE.test(room)) throw new RangeError("not a room id");
    if (enabled) this.#setOn.run(room);
    else this.#setOff.run(room);
  }

  // ---- uploads ----

  /**
   * Check an offer and either accept it (the client then sends the bytes with the
   * returned id), answer that the room already has it, or refuse it. The order is
   * deliberate: the switch and the rate limit come before anything that looks at the
   * offer, so a refused offer still spends a token and probing costs the same as
   * uploading.
   */
  beginUpload(offer: MediaOffer): BeginResult {
    const { room, uploader, mime, size, sha256: hash } = offer;
    if (typeof room !== "string" || !ID_RE.test(room) || typeof uploader !== "string" || !ID_RE.test(uploader)) {
      return refuse("media_bad_offer");
    }
    const audience = offer.audience ?? "room";
    if (!AUDIENCES.includes(audience)) return refuse("media_bad_offer");
    if (!this.uploadsEnabled(room)) return refuse("media_disabled");
    if (!this.#rate.take(`${room}\u0000${uploader}`)) return refuse("media_rate_limited");
    if (typeof mime !== "string" || !(isImageMime(mime) || isAudioMime(mime) || (mime === CARD_JSON_MIME && audience !== "room"))) {
      return refuse("media_bad_mime");
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return refuse("media_bad_offer");
    if (typeof offer.name !== "string") return refuse("media_bad_offer");
    const family = quotaFamily(mime);
    if (size > this.#limits[family].maxFileBytes) return refuse("media_too_large");
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return refuse("media_bad_hash");

    // Only listed media counts as "already here", and only for a listed upload: an unlisted
    // copy must not be republished as room media, nor may its existence be confirmed from a
    // hash.
    const existing = audience === "room" ? this.#find(room, hash, ["room"]) : undefined;
    if (existing !== undefined) return { ok: true, kind: "existing", record: existing };
    // Advisory: several offers may be pending at once, so completion checks again.
    if (this.#used.get(room, family)!.total + size > this.#limits[family].roomQuotaBytes) {
      return refuse("media_quota_exceeded");
    }

    const now = this.#clock.now();
    this.#dropExpired(now);
    let uploadId = this.#clock.id();
    while (this.#pending.has(uploadId)) uploadId = this.#clock.id();
    this.#pending.set(uploadId, {
      room,
      uploader,
      name: safeName(offer.name),
      mime,
      audience,
      size,
      hash,
      expiresAt: now + this.#limits.pendingUploadTtlMs,
      generation: this.#generation(room),
    });
    return { ok: true, kind: "upload", uploadId };
  }

  /**
   * Hand over the bytes of an accepted offer. They are checked — exact size, sha256,
   * the declared type's signature, the SVG subset — before anything is written. One
   * attempt per offer: a refused completion needs a new offer.
   */
  async completeUpload(uploadId: string, uploader: string, bytes: Uint8Array): Promise<StoreResult> {
    const pending = typeof uploadId === "string" ? this.#pending.get(uploadId) : undefined;
    if (pending === undefined || pending.uploader !== uploader) return refuse("media_unknown_upload");
    this.#pending.delete(uploadId);
    if (pending.expiresAt <= this.#clock.now()) return refuse("media_unknown_upload");
    if (bytes.length !== pending.size) return refuse("media_size_mismatch");
    if (sha256(bytes) !== pending.hash) return refuse("media_hash_mismatch");
    if (!matchesSignature(pending.mime, bytes)) return refuse(pending.mime === "image/svg+xml" ? "media_bad_svg" : "media_bad_signature");
    return this.#store({
      room: pending.room,
      hash: pending.hash,
      mime: pending.mime,
      name: pending.name,
      uploader: pending.uploader,
      audience: pending.audience,
      bytes,
      generation: pending.generation,
      byMember: true,
    });
  }

  /**
   * The size an accepted offer promised, while it waits for its bytes; undefined for an id
   * that is not `uploader`'s accepted, unexpired offer. A transport reads at most this many
   * bytes for it.
   */
  pendingSize(uploadId: string, uploader: string): number | undefined {
    const pending = typeof uploadId === "string" ? this.#pending.get(uploadId) : undefined;
    if (pending === undefined || pending.uploader !== uploader || pending.expiresAt <= this.#clock.now()) return undefined;
    return pending.size;
  }

  /** Forget `uploader`'s accepted offer whose bytes did not arrive whole: it is used up, as a refused completion is. */
  abandonUpload(uploadId: string, uploader: string): void {
    const pending = typeof uploadId === "string" ? this.#pending.get(uploadId) : undefined;
    if (pending !== undefined && pending.uploader === uploader) this.#pending.delete(uploadId);
  }

  /**
   * Index bytes the server made or carries: a generated picture (an image, any audience),
   * a session report (`text/html`, unlisted audiences only — HTML never becomes listed
   * room media), or an enabled pack's picture or sound (`gateway/packs.ts`). They count
   * against their family's budget and limits. Not subject to the upload switch or the
   * rate limit, which govern members.
   */
  async registerServerBlob(blob: ServerBlob): Promise<StoreResult> {
    const { room, bytes, mime, audience } = blob;
    if (typeof room !== "string" || !ID_RE.test(room) || !(bytes instanceof Uint8Array) || bytes.length === 0) {
      return refuse("media_bad_offer");
    }
    if (!(["room", "members", "admin"] as const).includes(audience)) return refuse("media_bad_offer");
    let stored: StoredMime;
    if (mime === REPORT_MIME && audience !== "room") stored = REPORT_MIME;
    else if (typeof mime === "string" && (isImageMime(mime) || isAudioMime(mime))) stored = mime;
    else return refuse("media_bad_mime");
    if (bytes.length > this.#limits[quotaFamily(stored)].maxFileBytes) return refuse("media_too_large");
    if (stored !== REPORT_MIME && !matchesSignature(stored, bytes)) {
      return refuse(stored === "image/svg+xml" ? "media_bad_svg" : "media_bad_signature");
    }
    return this.#store({
      room,
      hash: sha256(bytes),
      mime: stored,
      name: safeName(blob.name),
      uploader: SERVER_UPLOADER,
      audience,
      bytes,
      generation: this.#generation(room),
      byMember: false,
    });
  }

  /**
   * Record verified bytes. Order of operations:
   *   1. pre-check (no I/O): same bytes already in the room → answer with that record;
   *   2. write a flushed temporary file (async; failure → nothing recorded);
   *   3. in one synchronous stretch: re-check the room's clear count (and, for a member's
   *      upload, the switch), then in one transaction re-check duplicate and quota, rename
   *      the file into place, insert the row. If the transaction fails after the rename,
   *      the file is removed again unless some row (another room's) names that hash;
   *   4. always remove the temporary file if it is still there.
   */
  async #store(item: Item): Promise<StoreResult> {
    const pre = this.#settled(item);
    if (pre !== undefined) return pre;

    let temp: string;
    try {
      temp = await this.#blobs.writeTemp(item.hash, item.bytes, this.#clock.id());
    } catch {
      return refuse("media_storage_failed");
    }
    this.#inFlight.add(temp);
    try {
      if (item.generation !== this.#generation(item.room)) return refuse("media_unknown_upload");
      if (item.byMember && !this.uploadsEnabled(item.room)) return refuse("media_disabled");
      const family = quotaFamily(item.mime);
      const size = item.bytes.length;
      let published = false;
      try {
        return this.#db.transaction((): StoreResult => {
          const settled = this.#settled(item);
          if (settled !== undefined) return settled;
          if (this.#used.get(item.room, family)!.total + size > this.#limits[family].roomQuotaBytes) {
            return refuse("media_quota_exceeded");
          }
          this.#blobs.publish(temp, item.hash);
          published = true;
          const createdAt = this.#clock.now();
          this.#insert.run(item.room, item.hash, item.mime, size, item.name, item.uploader, createdAt, item.audience, family);
          const record: MediaRecord = {
            room: item.room,
            hash: item.hash,
            mime: item.mime,
            size,
            name: item.name,
            uploader: item.uploader,
            createdAt,
            audience: item.audience,
          };
          return { ok: true, record, created: true };
        });
      } catch {
        if (published) this.#removeIfUnreferenced(item.hash);
        return refuse("media_storage_failed");
      }
    } finally {
      this.#inFlight.delete(temp);
      try {
        this.#blobs.removeTemp(temp);
      } catch {
        // Left for `sweep`; the outcome above stands.
      }
    }
  }

  /** The answer when the room already holds `item.hash`, or undefined when it does not. */
  #settled(item: Item): StoreResult | undefined {
    const row = this.#get.get(item.room, item.hash);
    if (row === null) return undefined;
    const existing = toRecord(row);
    // The same bytes under another audience: answering with that record would publish
    // an unlisted blob as room media, or quietly change who may see it.
    if (existing.audience !== item.audience) return refuse("media_bad_upload");
    return { ok: true, record: existing, created: false };
  }

  // ---- reading ----

  /** The room's record for `hash` if a member with `viewer` may see it; no viewer means listed media only. */
  find(room: string, hash: string, viewer?: Role): MediaRecord | undefined {
    return this.#find(room, hash, audiencesFor(viewer));
  }

  /**
   * The bytes and record for `hash`, verified against the hash on every read. A hash the
   * room does not hold, one the viewer may not see, and a missing or damaged file all
   * give the same answer: undefined.
   */
  async read(room: string, hash: string, viewer?: Role): Promise<{ record: MediaRecord; bytes: Uint8Array } | undefined> {
    const record = this.find(room, hash, viewer);
    if (record === undefined) return undefined;
    const bytes = await this.#blobs.read(record.hash);
    return bytes !== undefined && bytes.length === record.size ? { record, bytes } : undefined;
  }

  /** The room's listed media, oldest first. Unlisted blobs never appear here. */
  list(room: string): MediaRecord[] {
    if (!ID_RE.test(room)) return [];
    return this.#listed.all(room).map(toRecord);
  }

  /** Bytes the room uses against each budget, unlisted blobs included. */
  usage(room: string): Record<QuotaFamily, number> {
    return { image: this.#used.get(room, "image")!.total, audio: this.#used.get(room, "audio")!.total };
  }

  #find(room: string, hash: string, audiences: readonly Audience[]): MediaRecord | undefined {
    if (typeof room !== "string" || typeof hash !== "string" || !ID_RE.test(room) || !HASH_RE.test(hash)) return undefined;
    const row = this.#get.get(room, hash);
    if (row === null) return undefined;
    const record = toRecord(row);
    return audiences.includes(record.audience) ? record : undefined;
  }

  // ---- removal ----

  /**
   * Remove every blob `room` holds (listed or not), for a room reset or delete, and
   * return how many index rows went. Offers pending for the room, and uploads already
   * writing their bytes, are voided. Order: the rows go in one transaction (failure →
   * it throws and nothing changed); then, in the same synchronous stretch, the files no
   * remaining row names are removed. A file that cannot be removed is left for `sweep`
   * — never the reverse, a row without its file. The upload switch is room setting, not
   * media, and is kept; `setUploadsEnabled(room, true)` clears it for a deleted room.
   */
  deleteRoom(room: string): number {
    if (!ID_RE.test(room)) return 0;
    this.#generations.set(room, this.#generation(room) + 1);
    for (const [id, pending] of this.#pending) if (pending.room === room) this.#pending.delete(id);
    const hashes = this.#db.transaction(() => {
      const held = this.#roomHashes.all(room).map((row) => row.hash);
      this.#deleteRoom.run(room);
      return held;
    });
    for (const hash of hashes) this.#removeIfUnreferenced(hash);
    return hashes.length;
  }

  /**
   * Remove what failures left behind: blob files no row names and temporary files no
   * write in progress owns. Files of any other name are not the store's and are kept.
   * Synchronous, so it cannot interleave with an upload's publish. Returns how many
   * files went.
   */
  sweep(): number {
    const { blobs, temps } = this.#blobs.entries();
    let removed = 0;
    for (const hash of blobs) if (this.#removeIfUnreferenced(hash)) removed += 1;
    for (const temp of temps) {
      if (this.#inFlight.has(temp)) continue;
      try {
        this.#blobs.removeTemp(temp);
        removed += 1;
      } catch {
        // Still there next time.
      }
    }
    return removed;
  }

  /** Remove the blob file when no row names it. Never throws; true when a file was removed. */
  #removeIfUnreferenced(hash: string): boolean {
    if (this.#refs.get(hash)!.n > 0) return false;
    try {
      this.#blobs.remove(hash);
      return true;
    } catch {
      return false;
    }
  }

  #generation(room: string): number {
    return this.#generations.get(room) ?? 0;
  }

  #dropExpired(now: number): void {
    for (const [id, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(id);
  }
}
