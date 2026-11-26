// Every room this server runs, created on first use.
import type { Json } from "loreweaver/module";

import type { Clock } from "../infra/ids.ts";
import type { LLMClient } from "../infra/llm/index.ts";
import { RoomWorker } from "../infra/room_worker.ts";
import type { WorkerHandle } from "../infra/runtime/worker.ts";
import type { Store } from "../infra/store.ts";
import { Room } from "./room.ts";

export interface HubDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly llm: LLMClient;
  readonly systemPrompt: string;
  /** Start a room worker thread. */
  readonly spawnWorker: () => WorkerHandle;
  /** The module entry files enabled in a room. */
  readonly modulesFor: (room: string) => readonly string[];
  /** How long one call into a room's worker may take before the worker is ended. */
  readonly workerTimeoutMs: number;
  /**
   * Rooms whose worker stops after every mutating call, so each call cold-starts from the
   * checkpoints (dev rooms: a lossy `save()` shows at once). Default: none.
   */
  readonly workerColdStart?: (room: string) => boolean;
  readonly onProblem: (room: string, text: string) => void;
}

export class Hub {
  readonly #deps: HubDeps;
  readonly #rooms = new Map<string, Room>();
  readonly #workers = new Map<string, RoomWorker>();

  constructor(deps: HubDeps) {
    this.#deps = deps;
  }

  room(id: string): Room {
    const existing = this.#rooms.get(id);
    if (existing) return existing;
    // A room with content code gets its worker now; one without has none until its lore
    // needs one (`workerForLore`).
    const worker = this.#deps.modulesFor(id).length > 0 ? (this.#workers.get(id) ?? this.#worker(id)) : null;
    const room = new Room(
      id,
      this.#deps.store,
      this.#deps.clock,
      { llm: this.#deps.llm, clock: this.#deps.clock, worker, systemPrompt: this.#deps.systemPrompt },
      this.#deps.onProblem,
    );
    this.#rooms.set(id, room);
    return room;
  }

  /**
   * The room's worker for the lore exchange, started on demand.
   *
   * Which rooms need a worker: a room with modules (known when the room is first used,
   * from `modulesFor`), and a room whose lore assembly has at least one enabled entry to
   * scan. The second test costs nothing extra: the lore step reads the room's entries to
   * build its request anyway, and calls this only when one is enabled (a room with no lore
   * never starts a thread). A room that has both shares ONE worker — one thread per room,
   * one queue (decision 21). The worker is kept like any other: idle eviction and `close`
   * stop it, and the next call starts a fresh one.
   */
  workerForLore(id: string): RoomWorker {
    return this.#workers.get(id) ?? this.#worker(id);
  }

  #worker(id: string): RoomWorker {
    const worker = new RoomWorker(this.#deps.spawnWorker, this.#deps.modulesFor(id), {
      timeoutMs: this.#deps.workerTimeoutMs,
      coldStart: this.#deps.workerColdStart?.(id) ?? false,
      now: () => this.#deps.clock.now(),
      checkpoints: this.#deps.store.moduleStates(id) as Map<string, Json>,
      onCheckpoint: (module, snapshot) => {
        this.#deps.store.writer(id).setModuleState(module, snapshot);
      },
    });
    this.#workers.set(id, worker);
    return worker;
  }

  /**
   * Stop the worker threads that have been idle longer than `maxIdleMs`; the next call
   * into such a room starts a fresh worker from its checkpoints. The caller decides when
   * to run this. Resolves to the rooms whose worker was stopped.
   */
  async evictIdle(maxIdleMs: number): Promise<string[]> {
    const stopped: string[] = [];
    await Promise.all(
      [...this.#workers].map(async ([room, worker]) => {
        if (!worker.running || worker.idleMs() <= maxIdleMs) return;
        if (await worker.stopIfIdle(maxIdleMs)) stopped.push(room);
      }),
    );
    return stopped.sort();
  }

  /** Stop every worker thread. */
  async close(): Promise<void> {
    await Promise.all([...this.#workers.values()].map((worker) => worker.stop()));
    this.#workers.clear();
    this.#rooms.clear();
  }
}
