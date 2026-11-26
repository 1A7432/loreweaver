// What the room is handed by the engine, as plain functions: the Keeper turn and the record
// of commands players ran. The room never imports the engine; the composition root passes
// `runKeeperTurn` and `recordPlayerAction` (`agent/turn`), and a test passes a script.
import { AsyncLocalStorage } from "node:async_hooks";

import type { RoomContext } from "../agent/context.ts";
import type { TurnEnvironment, TurnInput, TurnPorts, TurnResult } from "../agent/turn/types.ts";
import type { RoomWriter } from "../infra/store.ts";

/** One Keeper turn (`agent/turn` `runKeeperTurn`). */
export type RunKeeperTurn = (context: RoomContext, input: TurnInput, ports: TurnPorts, env: TurnEnvironment) => Promise<TurnResult>;

/** A command a player ran, for the Keeper's next prompt. */
export interface PlayerActionEntry {
  /** Who ran it, as the table knows them. */
  readonly actor: string;
  /** The command's id. */
  readonly action: string;
  /** What the table saw. */
  readonly text: string;
}

/** Record one (`agent/turn` `recordPlayerAction`): refused with a code over a cap, never cut. */
export type RecordPlayerAction = (context: RoomContext, entry: PlayerActionEntry) => { readonly ok: true } | { readonly ok: false; readonly code: string };

/**
 * The piece of work a call into a room's worker is made for. The room runs each piece of
 * work (a turn, a command, a background pass) inside `runAsWork`, and the worker hands the
 * current `Work` back with each checkpoint (`RoomWorkerOptions.token`): the checkpoint is
 * then written through THAT work's writer, so one made by work of a past generation is
 * refused instead of landing in the new one. The turn engine calls the worker itself and
 * knows nothing of this; the work is carried by the async context the room started it in.
 */
export class Work {
  readonly writer: RoomWriter;

  constructor(writer: RoomWriter) {
    this.writer = writer;
  }
}

const current = new AsyncLocalStorage<Work>();

/** Run `body` as work of `writer`: worker calls made inside it carry that writer. */
export function runAsWork<T>(writer: RoomWriter, body: () => T): T {
  return current.run(new Work(writer), body);
}

/** The work in whose async context the caller runs, or undefined outside any. */
export function currentWork(): Work | undefined {
  return current.getStore();
}
