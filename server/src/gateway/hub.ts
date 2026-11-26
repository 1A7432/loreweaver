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
    const paths = this.#deps.modulesFor(id);
    // A room with no content code has no worker at all.
    let worker: RoomWorker | null = null;
    if (paths.length > 0) {
      worker = new RoomWorker(this.#deps.spawnWorker, paths, {
        timeoutMs: this.#deps.workerTimeoutMs,
        checkpoints: this.#deps.store.moduleStates(id) as Map<string, Json>,
        onCheckpoint: (module, snapshot) => {
          this.#deps.store.setModuleState(id, module, snapshot);
        },
      });
      this.#workers.set(id, worker);
    }
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

  /** Stop every worker thread. */
  async close(): Promise<void> {
    await Promise.all([...this.#workers.values()].map((worker) => worker.stop()));
    this.#workers.clear();
    this.#rooms.clear();
  }
}
