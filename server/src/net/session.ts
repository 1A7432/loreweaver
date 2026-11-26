// One connection, whatever carries it. A transport hands this class parsed JSON values
// and a way to send frames back; everything the protocol says about a connection lives
// here.
import {
  decodeClientFrame,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  protocolMajor,
  type CallFrame,
  type ErrorBody,
  type HelloFrame,
  type ServerFrame,
} from "loreweaver-protocol/v3";

import { eventFrame, type Member, type Room } from "../gateway/room.ts";
import { t } from "../infra/i18n.ts";
import { SERVER_VERSION } from "../infra/version.ts";
import { memberId, type Keystore } from "./keystore.ts";

/** How many missed events a reconnect is sent at once; the rest is fetched by page. */
export const RESUME_LIMIT = 200;
export const PAGE_LIMIT = 100;

export interface SessionDeps {
  readonly keystore: Keystore;
  readonly room: (id: string) => Room;
  /** The language of rooms on this server until rooms carry their own setting. */
  readonly roomLocale: string;
}

export interface Connection {
  send(frame: ServerFrame): void;
  close(): void;
}

export class Session {
  readonly #deps: SessionDeps;
  readonly #connection: Connection;
  #locale = "en";
  #joined: { room: Room; member: Member; role: string } | null = null;

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
      if (joined.role === "observer") {
        this.#refuse(frame.rid, "forbidden");
        return;
      }
      this.#connection.send({ type: "result", rid: frame.rid, ok: true });
      void joined.room.say(joined.member, frame.text);
      return;
    }
    this.#call(joined.room, frame);
  }

  /** The transport reports the connection gone. */
  closed(): void {
    if (this.#joined) this.#joined.room.leave(this.#joined.member);
    this.#joined = null;
  }

  #hello(frame: HelloFrame): void {
    this.#locale = frame.locale;
    if (protocolMajor(frame.protocol) !== PROTOCOL_MAJOR) {
      this.#error("protocol_mismatch", true, { server: PROTOCOL_VERSION, client: frame.protocol });
      return;
    }
    const record = this.#deps.keystore.lookup(frame.key);
    if (!record) {
      this.#error("bad_key", true);
      return;
    }
    const room = this.#deps.room(record.room);
    const member: Member = {
      id: memberId(frame.key),
      name: frame.name ?? record.name,
      send: (out) => {
        this.#connection.send(out);
      },
    };
    const meta = room.meta;
    this.#connection.send({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      server: { name: "loreweaver", version: SERVER_VERSION },
      room: { id: room.id, locale: this.#deps.roomLocale },
      you: { id: member.id, name: member.name, role: record.role },
      features: [],
      epoch: meta.epoch,
      head: meta.head,
    });
    // Same generation: send what was missed. Another generation (or a first visit):
    // the client holds nothing valid, so it gets the newest stretch of the log.
    const oldest = Math.max(0, meta.head - RESUME_LIMIT);
    const resume = frame.resume;
    const after = resume !== undefined && resume.epoch === meta.epoch ? Math.max(resume.after, oldest) : oldest;
    // Replay and join happen in one uninterrupted stretch (the store is synchronous),
    // so no live event can land between two replayed ones or be missed.
    for (const event of room.eventsAfter(after, RESUME_LIMIT)) this.#connection.send(eventFrame(event));
    room.join(member);
    this.#joined = { room, member, role: record.role };
  }

  #call(room: Room, frame: CallFrame): void {
    if (frame.method === "log.page") {
      const before = frame.params.before;
      const limit = frame.params.limit ?? PAGE_LIMIT;
      if (!Number.isSafeInteger(before) || !Number.isSafeInteger(limit) || (limit as number) < 1) {
        this.#refuse(frame.rid, "invalid_params");
        return;
      }
      const events = room.eventsBefore(before as number, Math.min(limit as number, PAGE_LIMIT)).map(eventFrame);
      this.#connection.send({ type: "result", rid: frame.rid, ok: true, data: { events } });
      return;
    }
    this.#refuse(frame.rid, "unknown_method");
  }

  #refuse(rid: string, code: string): void {
    const error: ErrorBody = { code, message: t(this.#locale, `net.error.${code}`) };
    this.#connection.send({ type: "result", rid, ok: false, error });
  }

  #error(code: string, fatal: boolean, params: Record<string, string> = {}): void {
    this.#connection.send({ type: "error", code, message: t(this.#locale, `net.error.${code}`, params), fatal });
    if (fatal) this.#connection.close();
  }
}
