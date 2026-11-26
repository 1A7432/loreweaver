// The byte channel's server side (protocol 3.0 §8.6): one stream per GET or PUT, beside the
// control stream of the same connection. The wire shapes and limits are the protocol
// package's (`loreweaver-protocol/v3` `bytes.ts`); this file reads one stream and answers it.
//
// - What a member may fetch, and what an upload must be, is decided by the room (and under
//   it the media store): a hash in another room and one under an audience the member's role
//   may not see both answer `media_not_found`, exactly like a hash nobody holds.
// - A read is always bounded: the header by `MAX_BYTE_HEADER_BYTES`, a body by the size its
//   offer promised. Nothing past that is buffered; a peer that sends more is refused.
// - A stream that breaks a limit gets one error line and is closed. The connection and its
//   control stream are never touched from here, and a transfer never holds the room's lock.
import {
  BYTE_STALL_MS,
  decodeByteRequest,
  encodeByteLine,
  HeaderReader,
  MAX_BYTE_STREAMS,
  type ByteReply,
} from "loreweaver-protocol/v3";

import type { Member, Room } from "../gateway/room.ts";
import { t } from "../infra/i18n.ts";

/** The most the transport is asked for in one read, and the most written in one write. */
export const BYTE_CHUNK = 64 * 1024;

/** The receiving half of one stream, as the channel needs it. */
export interface ByteSource {
  /** The next chunk (at most `max` bytes), or null once the peer finished or the stream broke. */
  read(max: number): Promise<Uint8Array | null>;
  /** Tell the peer to stop sending (the stream is being refused). */
  stop(): void;
}

/** The sending half of one stream. */
export interface ByteSink {
  write(bytes: Uint8Array): Promise<void>;
  finish(): Promise<void>;
}

/** Who is on the other end: present only while the connection's session is joined to a room. */
export interface ByteAccess {
  readonly room: Room;
  readonly member: Member;
}

export interface ByteChannelOptions {
  /** How long a stream may go without receiving anything (default `BYTE_STALL_MS`). */
  readonly stallMs?: number;
  /** Byte streams open at once on the connection (default `MAX_BYTE_STREAMS`). */
  readonly maxStreams?: number;
}

const STALLED = Symbol("stalled");

/** A refusal on the stream, by its stable code. */
class Refused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** One connection's byte streams. */
export class ByteChannel {
  readonly #access: () => ByteAccess | null;
  readonly #locale: () => string;
  readonly #stallMs: number;
  readonly #maxStreams: number;
  #open = 0;

  /**
   * `access` answers who the connection is now (null before `hello` succeeded and after the
   * session ended); `locale` the language to refuse in when there is no member yet.
   */
  constructor(access: () => ByteAccess | null, locale: () => string, options: ByteChannelOptions = {}) {
    this.#access = access;
    this.#locale = locale;
    this.#stallMs = options.stallMs ?? BYTE_STALL_MS;
    this.#maxStreams = options.maxStreams ?? MAX_BYTE_STREAMS;
  }

  /** Byte streams being served now. */
  get open(): number {
    return this.#open;
  }

  /** Serve one stream to its end. Never throws. */
  async serve(source: ByteSource, sink: ByteSink): Promise<void> {
    if (this.#open >= this.#maxStreams) {
      source.stop();
      await this.#refuse(sink, "too_many_streams", this.#access());
      return;
    }
    this.#open += 1;
    let access: ByteAccess | null = null;
    try {
      const header = await this.#header(source);
      const decoded = decodeByteRequest(header.value);
      if (!decoded.ok) throw new Refused(decoded.code);
      access = this.#access();
      if (access === null) throw new Refused("not_open");
      const request = decoded.request;
      if (request.op === "get") await this.#get(access, request.hash, sink);
      else await this.#put(access, request.upload_id, header.rest, source, sink);
    } catch (error) {
      const code = error instanceof Refused ? error.code : "byte_failed";
      source.stop();
      await this.#refuse(sink, code, access ?? this.#access());
    } finally {
      this.#open -= 1;
    }
  }

  async #get(access: ByteAccess, hash: string, sink: ByteSink): Promise<void> {
    const found = await access.room.fetchMedia(access.member, hash);
    if (found === undefined) throw new Refused("media_not_found");
    const { record, bytes } = found;
    await this.#reply(sink, { op: "get", ok: true, hash: record.hash, size: record.size, mime: record.mime, name: record.name }, bytes);
  }

  async #put(access: ByteAccess, uploadId: string, rest: Uint8Array, source: ByteSource, sink: ByteSink): Promise<void> {
    const { room, member } = access;
    const size = room.uploadSize(member, uploadId);
    if (size === undefined) throw new Refused("media_unknown_upload");
    const body = new Uint8Array(size);
    let filled = 0;
    try {
      // More than offered in the very first chunk: refused before anything is kept.
      if (rest.length > size) throw new Refused("media_size_mismatch");
      body.set(rest);
      filled = rest.length;
      while (filled < size) {
        const chunk = await this.#read(source, Math.min(BYTE_CHUNK, size - filled));
        if (chunk === null || filled + chunk.length > size) throw new Refused("media_size_mismatch");
        body.set(chunk, filled);
        filled += chunk.length;
      }
      // The peer finishes its side after the body; one byte more is one byte too many.
      if ((await this.#read(source, 1)) !== null) throw new Refused("media_size_mismatch");
    } catch (error) {
      room.abandonUpload(member, uploadId);
      throw error;
    }
    const stored = await room.receiveUpload(member, uploadId, body);
    if (!stored.ok) throw new Refused(stored.code);
    const { record } = stored;
    await this.#reply(sink, { op: "put", ok: true, hash: record.hash, size: record.size, mime: record.mime, name: record.name });
  }

  /** The header line, read within the header limit and the stall timeout. */
  async #header(source: ByteSource): Promise<{ value: unknown; rest: Uint8Array }> {
    const reader = new HeaderReader();
    for (;;) {
      const chunk = await this.#read(source, BYTE_CHUNK);
      if (chunk === null) throw new Refused("bad_request");
      const step = reader.push(chunk);
      if (step.state === "too_long") throw new Refused("header_too_long");
      if (step.state === "line") return step;
    }
  }

  /** One read, given up on (as `stalled`) when nothing arrives in time. */
  async #read(source: ByteSource, max: number): Promise<Uint8Array | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<typeof STALLED>((resolve) => {
      timer = setTimeout(() => resolve(STALLED), this.#stallMs);
    });
    try {
      const chunk = await Promise.race([source.read(max), stalled]);
      if (chunk === STALLED) throw new Refused("stalled");
      return chunk;
    } finally {
      clearTimeout(timer);
    }
  }

  async #reply(sink: ByteSink, header: ByteReply, body?: Uint8Array): Promise<void> {
    try {
      await sink.write(encodeByteLine(header));
      if (body !== undefined) {
        for (let at = 0; at < body.length; at += BYTE_CHUNK) await sink.write(body.subarray(at, at + BYTE_CHUNK));
      }
    } finally {
      await sink.finish().catch(() => undefined);
    }
  }

  async #refuse(sink: ByteSink, code: string, access: ByteAccess | null): Promise<void> {
    const locale = access?.member.locale ?? this.#locale();
    await this.#reply(sink, { ok: false, code, message: t(locale, `net.error.${code}`) }).catch(() => undefined);
  }
}
