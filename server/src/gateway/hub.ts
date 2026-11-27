// Every room this server runs, created on first use, and each room's worker.
//
// The hub is handed everything as plain values — the services, the turn environment, the
// command table, the turn function — so that the composition root (`serve`) and a test
// build it the same way. It owns one worker thread per room that needs one (a room with
// modules, or one whose lore asks — `workerForLore`), and writes each module checkpoint
// through the writer of the work whose call produced it (see `keeper.ts` `Work`): a
// checkpoint of a past generation is dropped and the worker starts over from the store.
import type { Json } from "loreweaver/module";

import type { Services } from "../agent/context.ts";
import type { DirectorImageDeps } from "../agent/lanes/director.ts";
import type { RoomKit } from "../agent/lanes/presentation.ts";
import type { TurnEnvironment } from "../agent/turn/types.ts";
import { RoomWorker } from "../infra/room_worker.ts";
import type { WorkerHandle } from "../infra/runtime/worker.ts";
import { OrderedChains } from "./chain.ts";
import type { CommandRegistry, KeyAdmin, KeyBook, ModuleCommands } from "./commands/index.ts";
import { currentWork, type RecordPlayerAction, type RunKeeperTurn, Work } from "./keeper.ts";
import type { LaneSettings } from "./lanes.ts";
import type { ModelSettings } from "./model_settings.ts";
import { RoomModuleCommands } from "./module_commands.ts";
import { RoomPacks } from "./packs.ts";
import { DEFAULT_RATE_LIMIT, RateLimiter, type RateLimitSettings } from "./rate_limit.ts";
import { type ReviewFilter } from "./review.ts";
import { Room, type RoomHost } from "./room.ts";
import type { Uploads } from "./uploads.ts";

export interface HubDeps {
  readonly services: Services;
  /** What a Keeper turn needs beyond the services (skills, recall, images, its settings). */
  readonly env: TurnEnvironment;
  /**
   * Build the server's command table around the module-command seam the hub provides
   * (`(modules) => new CommandRegistry({ modules })`): the seam needs the hub's rooms and
   * workers, the table is needed by the hub, so the hub makes the one call that joins them.
   * `keys` is the access keys with the rooms' presence (the `key` command); null without
   * `deps.keys`.
   */
  readonly commands: (modules: ModuleCommands, keys: KeyAdmin | null) => CommandRegistry;
  /** One Keeper turn (`agent/turn` `runKeeperTurn`). */
  readonly runTurn: RunKeeperTurn;
  /** The record of commands players ran (`agent/turn` `recordPlayerAction`). */
  readonly recordPlayerAction: RecordPlayerAction;
  /** The language of a room that never chose one. */
  readonly defaultLocale: string;
  /** The rule system of a room that never chose one; null (the default) for none. */
  readonly defaultRulePack?: string | null;
  /** The operator's word filter (`review.ts`; `REVIEW_OFF` for none). */
  readonly review: ReviewFilter;
  /** The after-turn lanes' switches. */
  readonly lanes: LaneSettings;
  /** A room's presentation kit (from its installed packs), or null for none. */
  readonly kitFor: (room: string) => RoomKit | null;
  /** The image client and media store for the Stage Director; absent: no new pictures. */
  /** What the Stage Director's pictures need, for a room, NOW; null while pictures are off or not configured. */
  readonly images?: (room: string) => DirectorImageDeps | null;
  /**
   * Members' files over the byte channel, on the server's media store (the same object the
   * command table's `uploads` and `import` are given). Absent: no uploads, no fetches.
   */
  readonly uploads?: Uploads;
  /** The installed packs (the `packs` view); default: none. Give the command table the same object. */
  readonly packs?: RoomPacks;
  /**
   * The model lanes and image generation at run time. Present: each piece of work in a room
   * runs on the snapshot current when its context was made, and every open room's views are
   * refreshed after a change. Absent: `services.models` as given, for the server's life.
   */
  readonly models?: ModelSettings;
  /** The access keys (the `key` command, `admin/keys`); absent: neither. */
  readonly keys?: KeyBook;
  /** Per-member input rate (default: a burst of 5, one every 2 s). */
  readonly rateLimit?: RateLimitSettings;
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
}

export class Hub {
  readonly registry: CommandRegistry;
  readonly #deps: HubDeps;
  readonly #rooms = new Map<string, Room>();
  readonly #workers = new Map<string, RoomWorker>();
  readonly #chains: OrderedChains;
  readonly #limiter: RateLimiter;
  readonly #packs: RoomPacks;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.#packs = deps.packs ?? RoomPacks.none();
    this.#chains = new OrderedChains((room, error) => {
      deps.services.report(room, `after-turn pass failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.#limiter = new RateLimiter(deps.rateLimit ?? DEFAULT_RATE_LIMIT, () => deps.services.clock.now());
    this.registry = deps.commands(
      new RoomModuleCommands({
        worker: (room) => this.moduleWorker(room),
        actionOf: (context) => this.room(context.room).actionOf(context),
        reviewFact: (context) => this.room(context.room).reviewFactFor(context),
        moduleClock: (room) => this.room(room).moduleClock,
      }),
      deps.keys === undefined ? null : { book: deps.keys, online: (room) => this.online(room) },
    );
    this.#packs.onInstalled((id) => {
      this.#packInstalled(id);
    });
    // A switch of model or image settings is the server's: every open room's admin views follow.
    deps.models?.onChange(() => {
      for (const room of this.#rooms.values()) void room.refreshViews();
    });
  }

  /** The member ids connected to `room` now (none for a room not open). */
  online(room: string): ReadonlySet<string> {
    return this.#rooms.get(room)?.onlineIds() ?? new Set();
  }

  /**
   * A pack was installed while the server runs (`pack install`): every room that has it
   * enabled reloads its modules — a new version takes effect for a room at that reload,
   * queued behind any turn in flight there. Every other open room only refreshes its views
   * (an admin's `packs` view lists every installed pack); its worker is not touched.
   */
  #packInstalled(id: string): void {
    const store = this.#deps.services.store;
    for (const room of new Set([...this.#rooms.keys(), ...this.#workers.keys()])) {
      const open = this.#rooms.get(room);
      if (!this.#packs.enabledIds(store, room).includes(id)) {
        if (open !== undefined) void open.refreshViews();
        continue;
      }
      if (open === undefined) this.#reload(room);
      else open.reloadModules();
    }
  }

  room(id: string): Room {
    const existing = this.#rooms.get(id);
    if (existing) return existing;
    const deps = this.#deps;
    const host: RoomHost = {
      services: deps.services,
      env: deps.env,
      registry: this.registry,
      runTurn: deps.runTurn,
      recordPlayerAction: deps.recordPlayerAction,
      defaultLocale: deps.defaultLocale,
      defaultRulePack: deps.defaultRulePack ?? null,
      review: deps.review,
      lanes: deps.lanes,
      images: deps.images ?? (() => null),
      limiter: this.#limiter,
      chains: this.#chains,
      uploads: deps.uploads ?? null,
      packs: this.#packs,
      models: deps.models ?? null,
      keys: deps.keys ?? null,
      kitFor: (room) => deps.kitFor(room),
      moduleWorker: (room) => this.moduleWorker(room),
      loreWorker: (room) => this.workerForLore(room),
      reloadWorker: (room) => {
        this.#reload(room);
      },
    };
    const room = new Room(id, host);
    this.#rooms.set(id, room);
    return room;
  }

  /** The room's worker when it has modules (started on its first call); null otherwise. */
  moduleWorker(id: string): RoomWorker | null {
    if (this.#deps.modulesFor(id).length === 0) return null;
    return this.#workers.get(id) ?? this.#worker(id);
  }

  /**
   * The room's worker for the lore exchange, started on demand.
   *
   * Which rooms need a worker: a room with modules, and a room whose lore assembly has at
   * least one enabled entry to scan (the lore step reads the room's entries to build its
   * request anyway, and calls this only when one is enabled: a room with no lore never
   * starts a thread). A room that has both shares ONE worker — one thread per room, one
   * queue (decision 21). The worker is kept like any other: idle eviction and `close` stop
   * it, and the next call starts a fresh one.
   */
  workerForLore(id: string): RoomWorker {
    return this.#workers.get(id) ?? this.#worker(id);
  }

  /** Settles when every after-turn pass scheduled for `room` so far has finished (tests, shutdown). */
  lanesIdle(room: string): Promise<void> {
    return this.#chains.idle(room);
  }

  #worker(id: string): RoomWorker {
    const store = this.#deps.services.store;
    const worker: RoomWorker = new RoomWorker(this.#deps.spawnWorker, this.#deps.modulesFor(id), {
      timeoutMs: this.#deps.workerTimeoutMs,
      coldStart: this.#deps.workerColdStart?.(id) ?? false,
      now: () => this.#deps.services.clock.now(),
      checkpoints: store.moduleStates(id) as Map<string, Json>,
      token: () => currentWork(),
      onCheckpoint: (module, snapshot, token) => {
        // Outside any work (a render, a description): the call changed nothing the store
        // lacks. The next mutating call's checkpoint carries it.
        if (!(token instanceof Work) || token.writer.room !== id) return;
        if (token.writer.current()) {
          token.writer.setModuleState(module, snapshot);
          return;
        }
        // Work of a past generation advanced the module: throw that state away.
        void worker.reload(store.moduleStates(id) as Map<string, Json>);
      },
    });
    this.#workers.set(id, worker);
    return worker;
  }

  /**
   * After a lifecycle operation, or after the room's enabled packs changed: the worker
   * starts over from the stored checkpoints. When the room's module list itself changed,
   * the handle (which keeps its modules' descriptions for its whole life) is retired and
   * the next call makes a new one with the new list.
   */
  #reload(id: string): void {
    const worker = this.#workers.get(id);
    if (worker === undefined) return;
    const paths = this.#deps.modulesFor(id);
    if (paths.length !== worker.paths.length || paths.some((path, index) => path !== worker.paths[index])) {
      this.#workers.delete(id);
      void worker.retire();
      return;
    }
    void worker.reload(this.#deps.services.store.moduleStates(id) as Map<string, Json>);
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
