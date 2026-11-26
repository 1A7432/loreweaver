// The main thread's handle on a room's worker. Calls go out one at a time, in order.
// A call that outlives its timeout ends the thread; the next call starts a new worker and
// reloads the modules from their last checkpoints, so calls queued behind a hung one are
// not lost.
//
// One method per exchange point of a turn, each one round trip. The static descriptions
// the modules gave at load are kept for the life of this handle (they depend on the module
// files alone), so an exchange no module handles is answered here without a round trip —
// even when the worker is not running, without starting one.
import type { Json, ReplyPhaseEvent, RoomSnapshot, ToolUseEvent, TurnStartEvent, Who } from "loreweaver/module";

import type { WorkerHandle } from "./runtime/worker.ts";
import type {
  CallValue,
  CommandRequest,
  CommandValue,
  LoadValue,
  LoreRequest,
  ModuleDescription,
  RenderValue,
  TurnStartValue,
  WorkerOp,
  WorkerRequest,
  WorkerResponse,
  WorkerValues,
} from "./worker_protocol.ts";

export class WorkerTimeout extends Error {
  constructor(op: string, ms: number) {
    super(`room worker: ${op} did not answer within ${ms} ms; the worker was terminated`);
    this.name = "WorkerTimeout";
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Request = DistributiveOmit<WorkerRequest, "id">;

interface Running {
  readonly handle: WorkerHandle;
  /** Settles when the modules have loaded; rejects when one of them could not. */
  ready: Promise<void>;
}

interface InFlight {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RoomWorkerOptions {
  /** How long one call may take before the whole worker is ended. */
  readonly timeoutMs: number;
  /** Saved states by module id (from the store) of a room that has run before. */
  readonly checkpoints?: ReadonlyMap<string, Json>;
  /**
   * Told each new checkpoint, to persist it, with the `token` of the call that produced it
   * (undefined when no `token` option was given).
   */
  readonly onCheckpoint?: (module: string, snapshot: Json, token: unknown) => void;
  /**
   * Read synchronously when a call is MADE (not when it reaches the thread) and handed back
   * with that call's checkpoints: an opaque name for the piece of work that asked. The
   * caller uses it to write a checkpoint through the writer of the work that made the call,
   * so a call of a generation that has since passed cannot land in the new one.
   */
  readonly token?: () => unknown;
  /**
   * End the worker after every mutating call, so the next call cold-starts from the
   * checkpoints. Dev rooms use it: a `save()` that drops state shows at once.
   */
  readonly coldStart?: boolean;
  /** Milliseconds, for idle time. Default `Date.now`. */
  readonly now?: () => number;
}

function emptyCall(): CallValue {
  return { effects: [], checkpoints: {}, failures: [], refused: [], broken: [] };
}

export class RoomWorker {
  readonly #spawn: () => WorkerHandle;
  readonly #timeoutMs: number;
  readonly #paths: readonly string[];
  readonly #checkpoints = new Map<string, Json>();
  readonly #onCheckpoint: (module: string, snapshot: Json, token: unknown) => void;
  readonly #token: () => unknown;
  readonly #coldStart: boolean;
  readonly #now: () => number;
  #descriptions: readonly ModuleDescription[] | null = null;
  #running: Running | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #nextId = 0;
  #inFlight: InFlight | null = null;
  #pending = 0;
  #lastActive: number;

  constructor(spawn: () => WorkerHandle, modulePaths: readonly string[], options: RoomWorkerOptions) {
    this.#spawn = spawn;
    this.#paths = modulePaths;
    this.#timeoutMs = options.timeoutMs;
    this.#onCheckpoint = options.onCheckpoint ?? (() => undefined);
    this.#token = options.token ?? (() => undefined);
    this.#coldStart = options.coldStart ?? false;
    this.#now = options.now ?? Date.now;
    this.#lastActive = this.#now();
    for (const [module, snapshot] of options.checkpoints ?? []) this.#checkpoints.set(module, snapshot);
  }

  /** The ids of the loaded modules, in dispatch order; empty before the first load. */
  get loaded(): readonly string[] {
    return (this.#descriptions ?? []).map((module) => module.id);
  }

  /** The modules' static descriptions, as the worker reported them; null before the first load. */
  get descriptions(): readonly ModuleDescription[] | null {
    return this.#descriptions;
  }

  /** Whether a worker thread is alive right now. */
  get running(): boolean {
    return this.#running !== null;
  }

  /** The last checkpoint of every module that has one. */
  get checkpoints(): ReadonlyMap<string, Json> {
    return this.#checkpoints;
  }

  /** How long no call has been running or queued, in ms; 0 while one is. */
  idleMs(): number {
    return this.#pending > 0 ? 0 : Math.max(0, this.#now() - this.#lastActive);
  }

  /** The static descriptions, loading the modules first if they never were. */
  describe(): Promise<readonly ModuleDescription[]> {
    const token = this.#token();
    return this.#enqueue(() => this.#describeNow(token));
  }

  /** The turn-start exchange. A module claiming the clock is read inside it. */
  turnStart(event: TurnStartEvent): Promise<TurnStartValue> {
    return this.#call({ op: "turnStart", event }, (module) => module.events.turnStart, () => ({ ...emptyCall(), clock: null }), true);
  }

  /** The veto exchange for one tool round: all of its calls at once. Read-only. */
  toolUse(event: ToolUseEvent): Promise<CallValue> {
    return this.#call({ op: "toolUse", event }, (module) => module.events.toolUse, emptyCall, false);
  }

  replyPhase(event: ReplyPhaseEvent): Promise<CallValue> {
    return this.#call({ op: "replyPhase", event }, (module) => module.events.replyPhase, emptyCall, true);
  }

  /** One command. A command no loaded module declares is refused without a round trip. */
  command(request: CommandRequest): Promise<CommandValue> {
    return this.#call(
      { op: "command", request },
      (module) => module.id === request.module && module.commands.some((command) => command.name === request.command),
      () => ({ ...emptyCall(), outcome: { status: "refused", reason: "unknown" } }),
      true,
    );
  }

  /**
   * Every read-only output (views, command availability, characters, clock) for these
   * viewers, all seeing the same room.
   */
  render(viewers: readonly Who[], room: RoomSnapshot): Promise<RenderValue> {
    return this.#call(
      { op: "render", request: { viewers, room } },
      (module) =>
        module.characters || module.clock || (viewers.length > 0 && (module.views.length > 0 || module.commands.some((command) => command.available))),
      () => ({ viewers: viewers.map(() => ({ views: [], available: [] })), characters: [], clock: null, failures: [], broken: [] }),
      false,
    );
  }

  /**
   * The lore exchange: the worldbook scan with its template rendering, run as one job in
   * the worker. Read-only for modules — it touches no module state and returns no
   * checkpoint — and asked of every room that has lore, whether or not any module is
   * loaded: the worker is started for it when it is not running. Same queue and the same
   * timeout as every other call: a template that hangs the thread past `timeoutMs` ends
   * the worker, this call rejects with `WorkerTimeout`, and the next call starts a fresh
   * one from the checkpoints. The answer is unchecked; the caller validates it.
   */
  assembleLore(request: LoreRequest): Promise<unknown> {
    const token = this.#token();
    return this.#enqueue(() => this.#exchange({ op: "lore", request }, token));
  }

  /**
   * Start over from `checkpoints` (the store's, after an undo, a reset or an import, or
   * after a checkpoint of a past generation was refused): queued behind any call in
   * flight, it replaces the checkpoints this handle holds and ends the thread, so the next
   * call loads the modules from them. The static descriptions are kept.
   */
  reload(checkpoints: ReadonlyMap<string, Json>): Promise<void> {
    return this.#enqueue(async () => {
      this.#checkpoints.clear();
      for (const [module, snapshot] of checkpoints) this.#checkpoints.set(module, snapshot);
      await this.#terminate();
    }, false);
  }

  /**
   * Stop the worker if no call has run for more than `maxIdleMs`. Queued behind any call
   * in flight, so it never cuts one short. Resolves whether it stopped a worker.
   */
  stopIfIdle(maxIdleMs: number): Promise<boolean> {
    return this.#enqueue(async () => {
      if (!this.#running || this.#now() - this.#lastActive <= maxIdleMs) return false;
      await this.#terminate();
      return true;
    }, false);
  }

  /** Stop the worker now; a call in flight is refused. The next call starts a fresh one. */
  async stop(): Promise<void> {
    const inFlight = this.#inFlight;
    if (inFlight) {
      clearTimeout(inFlight.timer);
      this.#inFlight = null;
      inFlight.reject(new Error("room worker: stopped"));
    }
    await this.#terminate();
  }

  #call<Op extends Exclude<WorkerOp, "load" | "lore">>(
    request: Extract<Request, { op: Op }>,
    handles: (module: ModuleDescription) => boolean,
    empty: () => WorkerValues[Op],
    mutating: boolean,
  ): Promise<WorkerValues[Op]> {
    const token = this.#token();
    return this.#enqueue(async () => {
      const descriptions = await this.#describeNow(token);
      if (!descriptions.some(handles)) return empty();
      const value = (await this.#exchange(request, token)) as WorkerValues[Op];
      if ("checkpoints" in value) this.#absorb(value.checkpoints, token);
      // A module whose restore failed is in an unknown state: rebuild from checkpoints.
      if (value.broken.length > 0 || (mutating && this.#coldStart)) await this.#terminate();
      return value;
    });
  }

  async #describeNow(token: unknown): Promise<readonly ModuleDescription[]> {
    if (this.#descriptions) return this.#descriptions;
    await this.#ensure(token).ready;
    return this.#descriptions ?? [];
  }

  #absorb(checkpoints: Readonly<Record<string, Json>>, token: unknown): void {
    for (const [module, snapshot] of Object.entries(checkpoints)) {
      this.#checkpoints.set(module, snapshot);
      this.#onCheckpoint(module, snapshot, token);
    }
  }

  #enqueue<T>(body: () => Promise<T>, track = true): Promise<T> {
    if (track) this.#pending += 1;
    const result = this.#queue.then(body);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queue = settled;
    if (track) {
      void settled.then(() => {
        this.#pending -= 1;
        this.#lastActive = this.#now();
      });
    }
    return result;
  }

  async #exchange(request: Request, token: unknown): Promise<unknown> {
    const running = this.#ensure(token);
    await running.ready;
    return this.#send(running, request);
  }

  /** The running worker, started (and its modules loaded) for the call named by `token`. */
  #ensure(token: unknown): Running {
    if (this.#running) return this.#running;
    const handle = this.#spawn();
    handle.onMessage((message) => {
      this.#receive(message as WorkerResponse);
    });
    const running: Running = { handle, ready: Promise.resolve() };
    this.#running = running;
    const snapshots = Object.fromEntries(this.#checkpoints);
    running.ready = this.#send(running, { op: "load", paths: this.#paths, snapshots }).then(
      (value) => {
        const loaded = value as LoadValue;
        this.#descriptions = loaded.modules;
        this.#absorb(loaded.checkpoints, token);
      },
      async (error: unknown) => {
        // A load that failed is retried by the next call, on a new worker: in a dev room
        // the file may have been fixed in between.
        if (this.#running === running) await this.#terminate();
        throw error;
      },
    );
    running.ready.catch(() => undefined);
    return running;
  }

  #receive(response: WorkerResponse): void {
    const inFlight = this.#inFlight;
    if (!inFlight || response.id !== inFlight.id) return;
    clearTimeout(inFlight.timer);
    this.#inFlight = null;
    if (response.ok) inFlight.resolve(response.value);
    else inFlight.reject(new Error(response.error));
  }

  #send(running: Running, request: Request): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#inFlight?.id === id) this.#inFlight = null;
        if (this.#running === running) this.#running = null;
        void running.handle.terminate();
        reject(new WorkerTimeout(request.op, this.#timeoutMs));
      }, this.#timeoutMs);
      this.#inFlight = { id, resolve, reject, timer };
      running.handle.post({ ...request, id } as WorkerRequest);
    });
  }

  async #terminate(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (running) await running.handle.terminate();
  }
}
