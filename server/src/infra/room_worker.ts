// The main thread's handle on a room's worker. Calls go out one at a time, in order.
// A call that outlives its timeout ends the thread: every waiting call is refused, and
// the next call starts a new worker and reloads the modules from their last checkpoints.
import type { Json, TurnStartEvent } from "loreweaver/module";

import type { WorkerHandle } from "./runtime/worker.ts";
import type { EventValue, LoadValue, WorkerRequest, WorkerResponse } from "./worker_protocol.ts";

export class WorkerTimeout extends Error {
  constructor(op: string, ms: number) {
    super(`room worker: ${op} did not answer within ${ms} ms; the worker was terminated`);
    this.name = "WorkerTimeout";
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Running {
  readonly handle: WorkerHandle;
  /** Settles when the modules have loaded; rejects when one of them could not. */
  ready: Promise<void>;
}

export class RoomWorker {
  readonly #spawn: () => WorkerHandle;
  readonly #timeoutMs: number;
  readonly #paths: readonly string[];
  readonly #checkpoints = new Map<string, Json>();
  readonly #onCheckpoint: (module: string, snapshot: Json) => void;
  #loaded: readonly string[] = [];
  #running: Running | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #nextId = 0;
  #settle: ((response: WorkerResponse) => void) | null = null;

  /**
   * `checkpoints` are the saved states by module id (from the store) of a room that has
   * run before; `onCheckpoint` is told each new one, to persist it.
   */
  constructor(
    spawn: () => WorkerHandle,
    modulePaths: readonly string[],
    options: {
      readonly timeoutMs: number;
      readonly checkpoints?: ReadonlyMap<string, Json>;
      readonly onCheckpoint?: (module: string, snapshot: Json) => void;
    },
  ) {
    this.#spawn = spawn;
    this.#paths = modulePaths;
    this.#timeoutMs = options.timeoutMs;
    this.#onCheckpoint = options.onCheckpoint ?? (() => undefined);
    for (const [module, snapshot] of options.checkpoints ?? []) this.#checkpoints.set(module, snapshot);
  }

  /** The ids of the modules the current worker loaded, in dispatch order. */
  get loaded(): readonly string[] {
    return this.#loaded;
  }

  turnStart(event: TurnStartEvent): Promise<EventValue> {
    return this.#enqueue(async () => {
      const value = (await this.#exchange({ op: "turnStart", event })) as EventValue;
      for (const [module, snapshot] of Object.entries(value.checkpoints)) {
        this.#checkpoints.set(module, snapshot);
        this.#onCheckpoint(module, snapshot);
      }
      return value;
    });
  }

  /** Stop the worker. The next call starts a fresh one from the checkpoints. */
  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (running) await running.handle.terminate();
  }

  #enqueue<T>(body: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(body);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #exchange(request: DistributiveOmit<WorkerRequest, "id">): Promise<LoadValue | EventValue> {
    const running = this.#ensure();
    if (request.op !== "load") await running.ready;
    return this.#send(running, request);
  }

  #ensure(): Running {
    if (this.#running) return this.#running;
    const handle = this.#spawn();
    handle.onMessage((message) => {
      this.#settle?.(message as WorkerResponse);
    });
    const running: Running = { handle, ready: Promise.resolve() };
    this.#running = running;
    const snapshots = Object.fromEntries(this.#checkpoints);
    running.ready = this.#send(running, { op: "load", paths: this.#paths, snapshots }).then((value) => {
      this.#loaded = (value as LoadValue).modules.map((module) => module.id);
    });
    running.ready.catch(() => undefined);
    return running;
  }

  #send(running: Running, request: DistributiveOmit<WorkerRequest, "id">): Promise<LoadValue | EventValue> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle = null;
        if (this.#running === running) this.#running = null;
        void running.handle.terminate();
        reject(new WorkerTimeout(request.op, this.#timeoutMs));
      }, this.#timeoutMs);
      this.#settle = (response) => {
        if (response.id !== id) return;
        clearTimeout(timer);
        this.#settle = null;
        if (response.ok) resolve(response.value);
        else reject(new Error(response.error));
      };
      running.handle.post({ ...request, id } as WorkerRequest);
    });
  }
}
