// A room: its members, its log, and the lock that makes it do one thing at a time.
import type { EventFrame, EventKind, EventPayloads, ServerFrame, SignalFrame } from "loreweaver-protocol/v3";

import type { TurnDeps, TurnSink } from "../agent/turn.ts";
import { runTurn } from "../agent/turn.ts";
import type { Clock } from "../infra/ids.ts";
import { Mutex } from "../infra/mutex.ts";
import type { RoomMeta, RoomWriter, Store, StoredEvent } from "../infra/store.ts";

export interface Member {
  readonly id: string;
  readonly name: string;
  send(frame: ServerFrame): void;
}

export function eventFrame(event: StoredEvent): EventFrame {
  const frame = { type: "event", seq: event.seq, id: event.id, ts: event.ts, kind: event.kind, data: event.data };
  return (event.turn === undefined ? frame : { ...frame, turn: event.turn }) as EventFrame;
}

export class Room {
  readonly id: string;
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #turnDeps: TurnDeps;
  readonly #members = new Set<Member>();
  readonly #lock = new Mutex();
  readonly #onProblem: (room: string, text: string) => void;

  constructor(
    id: string,
    store: Store,
    clock: Clock,
    turnDeps: TurnDeps,
    onProblem: (room: string, text: string) => void,
  ) {
    this.id = id;
    this.#store = store;
    this.#clock = clock;
    this.#turnDeps = turnDeps;
    this.#onProblem = onProblem;
  }

  get meta(): RoomMeta {
    return this.#store.room(this.id);
  }

  join(member: Member): void {
    this.#members.add(member);
  }

  leave(member: Member): void {
    this.#members.delete(member);
  }

  eventsAfter(after: number, limit: number): StoredEvent[] {
    return this.#store.eventsAfter(this.id, after, limit);
  }

  eventsBefore(before: number, limit: number): StoredEvent[] {
    return this.#store.eventsBefore(this.id, before, limit);
  }

  /**
   * Append to the log, then send to everyone: what is sent is what was stored. A turn's
   * events go through that turn's writer; anything else through a writer for the room as
   * it is now.
   */
  publish<K extends EventKind>(kind: K, id: string, data: EventPayloads[K], writer?: RoomWriter): void {
    const draft = { id, ts: this.#clock.now(), kind, data };
    const stored =
      writer === undefined
        ? this.#store.writer(this.id).appendEvent(draft)
        : writer.appendEvent({ ...draft, turn: writer.turn });
    this.#broadcast(eventFrame(stored));
  }

  signal(frame: SignalFrame): void {
    this.#broadcast(frame);
  }

  /**
   * A player's line: it enters the log at once, and its Keeper turn queues behind any
   * turn already running. Resolves when that turn has finished.
   */
  say(member: Member, text: string): Promise<void> {
    // The turn is allocated when the line is ACCEPTED, here and synchronously, not when
    // its Keeper turn gets the lock: the line then carries its turn number, so a reply is
    // paired with the line it answers by `turn` alone, a turn whose reply never landed is
    // simply a turn with one event, and an undo of the turn takes the line with it. The
    // counter lives in the store, so a restart continues it.
    const writer = this.#store.beginTurn(this.id);
    this.publish("narrative", this.#clock.id(), { speaker: "player", name: member.name, member: member.id, text, format: "plain" }, writer);
    return this.#lock.run(async () => {
      await runTurn(this.#turnDeps, this.#sink(writer), { room: this.id, turn: writer.turn, speaker: member.name, text });
    });
  }

  #sink(writer: RoomWriter): TurnSink {
    return {
      narrate: (id, _turn, data) => {
        this.publish("narrative", id, data, writer);
      },
      draft: (id, text) => {
        this.signal({ type: "signal", kind: "draft", data: { id, text } });
      },
      discardDraft: (id) => {
        this.signal({ type: "signal", kind: "draft", data: { id, discard: true } });
      },
      busy: (actor) => {
        this.signal({ type: "signal", kind: "turn", data: { status: "busy", actor } });
      },
      idle: () => {
        this.signal({ type: "signal", kind: "turn", data: { status: "idle" } });
      },
      problem: (text) => {
        this.#onProblem(this.id, text);
      },
    };
  }

  #broadcast(frame: ServerFrame): void {
    for (const member of this.#members) member.send(frame);
  }
}
