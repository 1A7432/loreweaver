// The byte channel (protocol 3.0 §8.6): content-addressed GET and PUT beside the control
// stream. Every operation is its own bidirectional stream on the same connection:
//
//   GET   client: {"op":"get","hash":"<sha256 hex>"}\n
//         server: {"op":"get","ok":true,"hash","size","mime","name"}\n then exactly `size` bytes
//                 — or one error line.
//   PUT   (after `call media.offer` answered `{upload_id}`)
//         client: {"op":"put","upload_id":"<id>"}\n then exactly the offered `size` bytes, then
//                 it finishes its side of the stream
//         server: {"op":"put","ok":true,"hash","size","mime","name"}\n — or one error line.
//   error server: {"ok":false,"code":"<stable code>","message":"<in the member's language>"}\n
//
// The server then finishes the stream. A stream that breaks a limit is answered with an
// error line and closed; the connection and its control stream carry on. Nothing here does
// I/O: these are the shapes, the limits and the helpers every client shares.
import type { MediaData } from "./frames.js";

/** Byte streams one connection may have open at once (the control stream not counted). */
export const MAX_BYTE_STREAMS = 4;
/**
 * The longest request or reply header line, in bytes, newline included: room for a reply
 * naming a file of `MAX_OFFER_NAME_CHARS` four-byte characters.
 */
export const MAX_BYTE_HEADER_BYTES = 2048;
/** How long a stream may go without receiving anything before it is closed as stalled. */
export const BYTE_STALL_MS = 30_000;
/** The longest `upload_id`, in characters. */
export const MAX_UPLOAD_ID_CHARS = 64;
/** The longest file name a `media.offer` may carry, in code points; over it is refused. */
export const MAX_OFFER_NAME_CHARS = 255;

/**
 * What an upload is for. `share` (the default): the file becomes room media and every member
 * sees it arrive as a `media` event. `import`: a card file brought for the `import`
 * command — stored unlisted (no member but an admin can fetch it), announced to nobody.
 * `audio` (admins only, sounds only): a sound for the room's audio library — fetchable by
 * every member, announced by no event; the `audio` view lists it.
 */
export const UPLOAD_PURPOSES = ["share", "import", "audio"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** The params of `call media.offer`. */
export interface MediaOfferParams {
  name: string;
  mime: string;
  /** Bytes. */
  size: number;
  /** Lowercase hex sha256 of the bytes. */
  sha256: string;
  purpose?: UploadPurpose;
}

/** The `data` of a successful `media.offer`: send the bytes with `upload_id`, or nothing at all. */
export type MediaOfferResult = { upload_id: string } | { existing: MediaData };

export interface GetRequest {
  op: "get";
  hash: string;
}

export interface PutRequest {
  op: "put";
  upload_id: string;
}

export type ByteRequest = GetRequest | PutRequest;

/** What a stream's answer says about the file: the GET header, or the PUT receipt. */
export interface ByteFile {
  hash: string;
  size: number;
  mime: string;
  name: string;
}

export type ByteReply =
  | ({ op: "get"; ok: true } & ByteFile)
  | ({ op: "put"; ok: true } & ByteFile)
  | { ok: false; code: string; message: string };

/**
 * The byte channel's own refusal codes. A PUT or GET may also answer with the media store's
 * codes (`media_unknown_upload`, `media_size_mismatch`, `media_hash_mismatch`,
 * `media_bad_signature`, `media_not_found`, …).
 */
export const BYTE_CODES = [
  /** The header line is not a request this channel knows. */
  "bad_request",
  /** No newline within `MAX_BYTE_HEADER_BYTES`. */
  "header_too_long",
  /** More than `MAX_BYTE_STREAMS` byte streams at once on this connection. */
  "too_many_streams",
  /** Nothing arrived for `BYTE_STALL_MS`. */
  "stalled",
  /** The connection has not joined a room (no `welcome` yet), or its session ended. */
  "not_open",
] as const;

export type ByteCode = (typeof BYTE_CODES)[number];

const HASH = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Whether `value` is a content hash as the protocol writes one: 64 lowercase hex digits. */
export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

/** One header line: compact JSON and a newline. */
export function encodeByteLine(value: ByteRequest | ByteReply): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/** A parsed header line as a request (the server's side). Unknown fields are ignored. */
export function decodeByteRequest(raw: unknown): { ok: true; request: ByteRequest } | { ok: false; code: "bad_request" } {
  if (!isRecord(raw)) return { ok: false, code: "bad_request" };
  if (raw.op === "get" && isContentHash(raw.hash)) return { ok: true, request: { op: "get", hash: raw.hash } };
  if (raw.op === "put" && typeof raw.upload_id === "string" && raw.upload_id.length > 0 && raw.upload_id.length <= MAX_UPLOAD_ID_CHARS) {
    return { ok: true, request: { op: "put", upload_id: raw.upload_id } };
  }
  return { ok: false, code: "bad_request" };
}

/** A parsed header line as a reply (a client's side); null when it is neither shape. */
export function decodeByteReply(raw: unknown): ByteReply | null {
  if (!isRecord(raw)) return null;
  if (raw.ok === false) {
    return typeof raw.code === "string" && typeof raw.message === "string" ? { ok: false, code: raw.code, message: raw.message } : null;
  }
  if (raw.ok !== true || (raw.op !== "get" && raw.op !== "put")) return null;
  if (!isContentHash(raw.hash) || !isSize(raw.size) || typeof raw.mime !== "string" || typeof raw.name !== "string") return null;
  return { op: raw.op, ok: true, hash: raw.hash, size: raw.size, mime: raw.mime, name: raw.name };
}

/** The `data` of a `media.offer` result; null when it is neither shape. */
export function decodeMediaOfferResult(raw: unknown): MediaOfferResult | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.upload_id === "string" && raw.upload_id.length > 0 && raw.upload_id.length <= MAX_UPLOAD_ID_CHARS) return { upload_id: raw.upload_id };
  const existing = raw.existing;
  if (
    isRecord(existing) &&
    isContentHash(existing.hash) &&
    isSize(existing.size) &&
    typeof existing.mime === "string" &&
    typeof existing.name === "string" &&
    typeof existing.from === "string"
  ) {
    return { existing: { hash: existing.hash, size: existing.size, mime: existing.mime, name: existing.name, from: existing.from } };
  }
  return null;
}

/** What `HeaderReader.push` found. */
export type HeaderStep =
  /** No newline yet. */
  | { state: "more" }
  /** The header line, parsed (`value` is undefined when it is not JSON), and the bytes that followed it in the same chunks. */
  | { state: "line"; value: unknown; rest: Uint8Array }
  /** No newline within `MAX_BYTE_HEADER_BYTES`. */
  | { state: "too_long" };

/**
 * Reads the one header line at the start of a stream from the chunks a transport hands over,
 * keeping at most `MAX_BYTE_HEADER_BYTES`. Whatever followed the newline is the start of the
 * body and comes back as `rest`.
 */
export class HeaderReader {
  readonly #limit: number;
  #buffer = new Uint8Array(0);
  #done = false;

  constructor(limit: number = MAX_BYTE_HEADER_BYTES) {
    this.#limit = limit;
  }

  push(chunk: Uint8Array): HeaderStep {
    if (this.#done) throw new Error("the header was already read");
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    const end = joined.indexOf(0x0a);
    if (end < 0) {
      if (joined.length >= this.#limit) {
        this.#done = true;
        return { state: "too_long" };
      }
      this.#buffer = joined;
      return { state: "more" };
    }
    this.#done = true;
    if (end + 1 > this.#limit) return { state: "too_long" };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined.subarray(0, end)));
    } catch {
      value = undefined;
    }
    return { state: "line", value, rest: joined.slice(end + 1) };
  }
}
