// One connection, whatever carries it. A transport hands this class parsed JSON values
// and a way to send frames back; everything the protocol says about a connection lives
// here: the hello and its welcome, resuming the log, the one `result` per `input` and
// `call` matched by `rid`, and connection-level errors. What a member does in the room is
// the room's (`gateway/room.ts`); text a person reads here comes from this layer's catalog
// (`locales/*/net.json`), in the MEMBER's language (decision 32).
import {
  type CallFrame,
  charCount,
  decodeClientFrame,
  type ErrorBody,
  type HelloFrame,
  MAX_OFFER_NAME_CHARS,
  MAX_VIEW_NAMES,
  PAGE_LIMIT,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  protocolMajor,
  RESUME_LIMIT,
  type ServerFrame,
  UPLOAD_PURPOSES,
  type UploadPurpose,
} from "loreweaver-protocol/v3";

import type { Answer, Member, Room } from "../gateway/room.ts";
import type { UploadOffer } from "../gateway/uploads.ts";
import { eventFrame } from "../gateway/room.ts";
import { catalogLocale, t } from "../infra/i18n.ts";
import { SERVER_VERSION } from "../infra/version.ts";
import type { ByteAccess } from "./bytes.ts";
import { memberId, type Keystore } from "./keystore.ts";

/** A name a client gives itself in `hello`, in code points. */
export const MAX_MEMBER_NAME_CHARS = 64;
/** A command id in `command.run`, in code points (a module id, a slash, a command name). */
export const MAX_COMMAND_ID_CHARS = 200;
/** A MIME type in `media.offer`, in characters (the store accepts only short, known ones). */
export const MAX_OFFER_MIME_CHARS = 128;
/** The `sha256` of `media.offer`, in characters (the store accepts exactly 64 hex digits). */
export const MAX_OFFER_HASH_CHARS = 128;

export interface SessionDeps {
  readonly keystore: Keystore;
  readonly room: (id: string) => Room;
}

export interface Connection {
  send(frame: ServerFrame): void;
  close(): void;
}

let connections = 0;

function isStringList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string");
}

/**
 * `media.offer`'s params, when their shapes are right; whether the offer is ACCEPTABLE (type,
 * size, hash format, quota, rate) is the media store's to say, with its own codes.
 */
function readOffer(params: Record<string, unknown>): UploadOffer | null {
  const { name, mime, size, sha256 } = params;
  const purpose = params.purpose ?? "share";
  if (typeof name !== "string" || charCount(name) > MAX_OFFER_NAME_CHARS) return null;
  if (typeof mime !== "string" || mime.length > MAX_OFFER_MIME_CHARS) return null;
  if (typeof sha256 !== "string" || sha256.length > MAX_OFFER_HASH_CHARS) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
  if (typeof purpose !== "string" || !(UPLOAD_PURPOSES as readonly string[]).includes(purpose)) return null;
  return { name, mime, size, sha256, purpose: purpose as UploadPurpose };
}

export class Session {
  readonly #deps: SessionDeps;
  readonly #connection: Connection;
  #locale = "en";
  #joined: { room: Room; member: Member } | null = null;
  #ended = false;

  constructor(deps: SessionDeps, connection: Connection) {
    this.#deps = deps;
    this.#connection = connection;
  }

  /** Handle one inbound value (already parsed from JSON). */
  receive(raw: unknown): void {
    const decoded = decodeClientFrame(raw);
    if (!decoded.ok) {
      if (decoded.rid !== undefined) this.#refuse(decoded.rid, decoded.code);
      else this.#error(decoded.code, this.#joined === null);
      return;
    }
    const frame = decoded.frame;
    if (frame.type === "ping") {
      this.#connection.send({ type: "pong", t: frame.t });
      return;
    }
    if (frame.type === "hello") {
      if (this.#joined === null) this.#hello(frame);
      else this.#error("bad_frame", false);
      return;
    }
    const joined = this.#joined;
    if (joined === null) {
      this.#error("hello_first", true);
      return;
    }
    if (frame.type === "input") {
      joined.room.input(joined.member, frame.text, this.#replier(frame.rid));
      return;
    }
    this.#call(joined.room, joined.member, frame);
  }

  /** The transport reports the connection gone. */
  closed(): void {
    this.#ended = true;
    if (this.#joined) this.#joined.room.leave(this.#joined.member);
    this.#joined = null;
  }

  /** The language this connection is answered in. */
  get locale(): string {
    return this.#locale;
  }

  /** Who may use the byte channel on this connection: the joined member, only while the session lasts. */
  byteAccess(): ByteAccess | null {
    return this.#ended ? null : this.#joined;
  }

  #hello(frame: HelloFrame): void {
    this.#locale = catalogLocale(frame.locale);
    if (protocolMajor(frame.protocol) !== PROTOCOL_MAJOR) {
      this.#error("protocol_mismatch", true, { server: PROTOCOL_VERSION, client: frame.protocol });
      return;
    }
    const record = this.#deps.keystore.lookup(frame.key);
    if (!record) {
      this.#error("bad_key", true);
      return;
    }
    const asked = frame.name?.trim() ?? "";
    if (charCount(asked) > MAX_MEMBER_NAME_CHARS) {
      this.#error("bad_name", true, { limit: MAX_MEMBER_NAME_CHARS });
      return;
    }
    const room = this.#deps.room(record.room);
    const id = memberId(frame.key);
    const member: Member = {
      connection: `${id}#${++connections}`,
      id,
      name: asked === "" ? record.name : asked,
      role: record.role,
      locale: this.#locale,
      send: (out) => {
        this.#connection.send(out);
      },
    };
    const meta = room.meta;
    this.#connection.send({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      server: { name: "loreweaver", version: SERVER_VERSION },
      room: { id: room.id, locale: room.locale },
      you: { id: member.id, name: member.name, role: member.role },
      features: [],
      epoch: meta.epoch,
      head: meta.head,
    });
    // Same generation: send what was missed. Another generation (or a first visit): the
    // client holds nothing valid — the welcome's epoch tells it so — and it gets the newest
    // stretch of the log.
    const oldest = Math.max(0, meta.head - RESUME_LIMIT);
    const resume = frame.resume;
    const after = resume !== undefined && resume.epoch === meta.epoch ? Math.max(resume.after, oldest) : oldest;
    // Replay and join happen in one uninterrupted stretch (the store is synchronous),
    // so no live event can land between two replayed ones or be missed.
    for (const event of room.eventsAfter(after, RESUME_LIMIT)) this.#connection.send(eventFrame(event));
    room.join(member);
    this.#joined = { room, member };
  }

  #call(room: Room, member: Member, frame: CallFrame): void {
    const params = frame.params;
    switch (frame.method) {
      case "command.run": {
        const id = params.id;
        if (typeof id !== "string" || id === "" || charCount(id) > MAX_COMMAND_ID_CHARS) {
          this.#refuse(frame.rid, "invalid_params");
          return;
        }
        room.run(member, id, params.args ?? {}, this.#replier(frame.rid));
        return;
      }
      case "view.list":
        void room.viewList(member).then((views) => {
          this.#ok(frame.rid, { views });
        });
        return;
      case "view.subscribe": {
        const names = params.names;
        if (!isStringList(names, MAX_VIEW_NAMES)) {
          this.#refuse(frame.rid, "invalid_params");
          return;
        }
        void room.viewSubscribe(member, names).then((delivery) => {
          // The answer first; the current values follow as view frames.
          this.#ok(frame.rid, { problems: delivery.problems });
          for (const view of delivery.frames) this.#connection.send(view);
        });
        return;
      }
      case "view.unsubscribe": {
        const names = params.names;
        if (!isStringList(names, MAX_VIEW_NAMES)) {
          this.#refuse(frame.rid, "invalid_params");
          return;
        }
        void room.viewUnsubscribe(member, names).then((removed) => {
          this.#ok(frame.rid, { removed });
        });
        return;
      }
      case "view.get": {
        const name = params.name;
        if (typeof name !== "string") {
          this.#refuse(frame.rid, "invalid_params");
          return;
        }
        void room.viewGet(member, name).then((view) => {
          if ("code" in view) this.#refuse(frame.rid, view.code);
          else this.#ok(frame.rid, { name: view.name, rev: view.rev, at: view.at, data: view.data });
        });
        return;
      }
      case "log.page": {
        const before = params.before;
        const limit = params.limit ?? PAGE_LIMIT;
        // Over the limit is refused, not cut to it: a client that asked for 500 and got 100
        // would take the page for the whole of what there was.
        if (!Number.isSafeInteger(before) || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > PAGE_LIMIT) {
          this.#refuse(frame.rid, "invalid_params");
          return;
        }
        const events = room.eventsBefore(before as number, limit as number).map(eventFrame);
        this.#ok(frame.rid, { events });
        return;
      }
      case "media.offer": {
        const offer = readOffer(params);
        if (offer === null) {
          this.#refuse(frame.rid, "invalid_params");
          return;
        }
        this.#replier(frame.rid)(room.offerUpload(member, offer));
        return;
      }
      default:
        this.#refuse(frame.rid, "unknown_method");
    }
  }

  /** The one answer to `rid`, from the room. */
  #replier(rid: string): (answer: Answer) => void {
    let answered = false;
    return (answer) => {
      if (answered) return;
      answered = true;
      if (answer.ok) {
        const result: { type: "result"; rid: string; ok: true; text?: string; data?: unknown } = { type: "result", rid, ok: true };
        if (answer.text !== undefined) result.text = answer.text;
        if (answer.data !== undefined) result.data = answer.data;
        this.#connection.send(result);
      } else {
        this.#refuse(rid, answer.code, answer.message);
      }
    };
  }

  #ok(rid: string, data: unknown): void {
    this.#connection.send({ type: "result", rid, ok: true, data });
  }

  #refuse(rid: string, code: string, message?: string): void {
    const error: ErrorBody = { code, message: message ?? t(this.#locale, `net.error.${code}`) };
    this.#connection.send({ type: "result", rid, ok: false, error });
  }

  #error(code: string, fatal: boolean, params: Record<string, string | number> = {}): void {
    this.#connection.send({ type: "error", code, message: t(this.#locale, `net.error.${code}`, params), fatal });
    if (fatal) {
      this.#ended = true;
      this.#connection.close();
    }
  }
}
