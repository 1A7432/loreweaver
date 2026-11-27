// A server for the room's tests: a real store, registry, views and session, a scripted Keeper
// turn (each test decides what a turn does, and may hold one open), scripted Scribe and
// Director models, and an optional real module worker.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventFrame, ResultFrame, ServerFrame, SignalFrame, ViewFrame } from "loreweaver-protocol/v3";

import type { RoomContext } from "../../src/agent/context.ts";
import type { DirectorImageDeps } from "../../src/agent/lanes/director.ts";
import type { RecallDeps } from "../../src/agent/recall.ts";
import { type InstalledKit, mergeRoomKit, parsePresentationKit, type RoomKit } from "../../src/agent/lanes/presentation.ts";
import { servicesOn } from "../../src/agent/services.ts";
import type { TurnEnvironment, TurnInput, TurnPorts, TurnResult } from "../../src/agent/turn/types.ts";
import { selftestEnvironment } from "../../src/cli/selftest.ts";
import { builtInPacks, RulePackRegistry } from "../../src/core/rulepacks/index.ts";
import { CommandRegistry } from "../../src/gateway/commands/index.ts";
import { Hub } from "../../src/gateway/hub.ts";
import type { PlayerActionEntry } from "../../src/gateway/keeper.ts";
import { type LaneSettings, LANES_OFF } from "../../src/gateway/lanes.ts";
import type { ModelSettings } from "../../src/gateway/model_settings.ts";
import type { RateLimitSettings } from "../../src/gateway/rate_limit.ts";
import type { RoomPacks } from "../../src/gateway/packs.ts";
import { REVIEW_OFF } from "../../src/gateway/review.ts";
import { Uploads } from "../../src/gateway/uploads.ts";
import { type Responder, type ScriptedReply, ScriptedLLM } from "../../src/infra/llm/index.ts";
import { DEFAULT_MEDIA_LIMITS, type MediaLimits, MediaStore } from "../../src/infra/media/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { spawnWorker, type WorkerHandle } from "../../src/infra/runtime/worker.ts";
import { Store } from "../../src/infra/store.ts";
import { Keystore } from "../../src/net/keystore.ts";
import { fixtureModule, testClock, Wire, WORKER_ENTRY } from "../helpers.ts";

export const ROOM = "table";

export const KEYS = { ada: "ada-key", bao: "bao-key", root: "root-key", eve: "eve-key" } as const;

/** A promise the test resolves by hand. */
export interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** One call of the turn function, as the room made it. */
export interface TurnCall {
  readonly context: RoomContext;
  readonly input: TurnInput;
  readonly ports: TurnPorts;
  /** The turn environment the room handed this turn. */
  readonly env: TurnEnvironment;
}

export type TurnScript = (call: TurnCall) => Promise<TurnResult> | TurnResult;

export function result(status: TurnResult["status"], reply: string | null = null, replyId: string | null = null): TurnResult {
  return {
    status,
    reply,
    replyId,
    usage: { inputTokens: 100, outputTokens: 10 },
    usageEstimated: false,
    toolsCalled: [],
    contentWrites: new Set(),
    keeperRecordedChronicle: false,
    narrateNowRequested: false,
    problems: [],
  };
}

/** Publish the Keeper's reply and say so. */
export function reply(call: TurnCall, text: string): TurnResult {
  const id = `reply-${call.context.turn}-${call.input.work}`;
  call.ports.publish("narrative", id, { speaker: "kp", text, format: "markdown" });
  return result("replied", text, id);
}

/** The scripted Keeper: each turn takes the next script, or replies `Reply N` by default. */
export class Keeper {
  readonly calls: TurnCall[] = [];
  readonly #scripts: TurnScript[] = [];

  next(...scripts: TurnScript[]): void {
    this.#scripts.push(...scripts);
  }

  readonly run = async (context: RoomContext, input: TurnInput, ports: TurnPorts, env: TurnEnvironment): Promise<TurnResult> => {
    const call = { context, input, ports, env };
    this.calls.push(call);
    // As the engine's first step does: one `busy` per turn, the engine's (the room sends none).
    ports.signal("turn", { status: "busy", actor: input.speaker });
    const script = this.#scripts.shift();
    return script === undefined ? reply(call, `Reply ${this.calls.length}`) : script(call);
  };
}

/** A kit with something to stage. */
export function testKit(): RoomKit {
  const parsed = parsePresentationKit({ version: 2, style: { keywords: { en: "ink wash" } }, subjects: [{ id: "quay", kind: "location", name: "The quay" }], templates: ["letter", "text"] });
  if (!parsed.ok) throw new Error(parsed.code);
  const installed: InstalledKit = { packId: "pack", kit: parsed.kit, assets: new Map() };
  return mergeRoomKit([installed], "en").kit;
}

export interface BenchOptions {
  readonly modules?: readonly string[];
  readonly lanes?: LaneSettings;
  readonly kit?: RoomKit | null;
  readonly scribe?: readonly ScriptedReply[] | Responder;
  readonly director?: readonly ScriptedReply[] | Responder;
  readonly system?: string | null;
  readonly rateLimit?: RateLimitSettings;
  /** The Stage Director's pictures: fixed deps, or asked per pass as the server does (null: no image client now). */
  readonly images?: DirectorImageDeps | ((room: string) => DirectorImageDeps | null);
  /** Told every op posted to the room worker, as it is posted. */
  readonly onPost?: (op: string) => void;
  /** A media store (in a temporary directory) behind the byte channel, `uploads` and `import`; these limits when given. */
  readonly media?: boolean | Partial<MediaLimits>;
  /** Recall by meaning, for the lore a world import writes. */
  readonly recall?: RecallDeps;
  /** Installed packs (given the bench's media store, when it has one): modules, kit, skills and cards come from the room's enabled packs. */
  readonly packs?: (media: MediaStore | null) => RoomPacks;
  /** The model lanes at run time (`model`, `imagegen`, `admin/model`); each piece of work pins a snapshot. */
  readonly models?: ModelSettings;
}

export const LANES_ON: LaneSettings = { scribe: true, director: true, directorSettings: { imagesEnabled: false, maxImages: 0, pregenPerBeat: 0 } };

export class RoomBench {
  readonly store: Store;
  readonly hub: Hub;
  readonly keeper = new Keeper();
  readonly reports: string[] = [];
  readonly actions: PlayerActionEntry[] = [];
  readonly scribe: ScriptedLLM;
  readonly director: ScriptedLLM;
  readonly keystore = new Keystore();
  /** Members' files, when the bench was made with `media`. */
  readonly uploads: Uploads | null = null;
  readonly media: MediaStore | null = null;
  readonly packs: RoomPacks | null = null;
  readonly #mediaDir: string | null = null;

  constructor(options: BenchOptions = {}) {
    const db = openDatabase(":memory:");
    this.store = new Store(db);
    if (options.media !== undefined && options.media !== false) {
      this.#mediaDir = mkdtempSync(join(tmpdir(), "loreweaver-room-media-"));
      const limits = options.media === true ? DEFAULT_MEDIA_LIMITS : { ...DEFAULT_MEDIA_LIMITS, ...options.media };
      this.media = new MediaStore(this.#mediaDir, db, { clock: testClock(), limits });
      this.uploads = new Uploads(this.media);
    }
    const packs = options.packs?.(this.media) ?? null;
    this.packs = packs;
    const uploads = this.uploads;
    this.scribe = new ScriptedLLM(options.scribe ?? (() => "{}"));
    this.director = new ScriptedLLM(options.director ?? (() => "{}"));
    const unused = new ScriptedLLM([]);
    const services = servicesOn({
      store: this.store,
      // With packs installed, their rule systems join the built-ins as the server's would.
      packs: packs === null ? new RulePackRegistry(builtInPacks()) : packs.ruleSystemRegistry,
      models: { keeper: unused, npc: unused, scribe: this.scribe, director: this.director, memory: unused },
      clock: testClock(),
      report: (_room, text) => {
        this.reports.push(text);
      },
    });
    const spawn = (): WorkerHandle => {
      const inner = spawnWorker(WORKER_ENTRY);
      return {
        post: (message) => {
          options.onPost?.((message as { op: string }).op);
          inner.post(message);
        },
        onMessage: (listener) => {
          inner.onMessage(listener);
        },
        terminate: () => inner.terminate(),
      };
    };
    const modules = (options.modules ?? []).map(fixtureModule);
    const store = this.store;
    this.hub = new Hub({
      services,
      env: packs === null ? selftestEnvironment() : { ...selftestEnvironment(), skills: packs.skillRegistry },
      commands: (seam, keys) => new CommandRegistry({ modules: seam, uploads, recall: options.recall ?? null, packs, keys, models: options.models ?? null }),
      runTurn: this.keeper.run,
      recordPlayerAction: (_context, entry) => {
        this.actions.push(entry);
        return { ok: true };
      },
      defaultLocale: "en",
      defaultRulePack: options.system === undefined ? "coc7" : options.system,
      review: REVIEW_OFF,
      lanes: options.lanes ?? LANES_OFF,
      kitFor: (room) => (packs === null || options.kit !== undefined ? (options.kit ?? null) : packs.kitFor(store, room, "en")),
      ...(options.images === undefined ? {} : { images: typeof options.images === "function" ? options.images : () => options.images as DirectorImageDeps }),
      rateLimit: options.rateLimit ?? { capacity: 10_000, refillPerSecond: 10_000 },
      spawnWorker: spawn,
      modulesFor: (room) => (packs === null || options.modules !== undefined ? modules : packs.modulesFor(store, room)),
      ...(packs === null ? {} : { packs }),
      workerTimeoutMs: 5000,
      ...(uploads === null ? {} : { uploads }),
      keys: this.keystore,
      ...(options.models === undefined ? {} : { models: options.models }),
    });
    this.keystore.add(KEYS.ada, { room: ROOM, name: "Ada", role: "player" });
    this.keystore.add(KEYS.bao, { room: ROOM, name: "Bao", role: "player" });
    this.keystore.add(KEYS.root, { room: ROOM, name: "Root", role: "admin" });
    this.keystore.add(KEYS.eve, { room: ROOM, name: "Eve", role: "observer" });
  }

  /** A connection that has said hello with `key`. */
  join(key: string, extra: Record<string, unknown> = {}): Wire {
    const wire = new Wire({ keystore: this.keystore, room: (id) => this.hub.room(id) });
    wire.hello(key, extra);
    return wire;
  }

  /** Everything queued under the room's lock, every view refresh and every after-turn pass, done. */
  async settled(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.hub.room(ROOM).settled();
      await this.hub.lanesIdle(ROOM);
    }
  }

  async close(): Promise<void> {
    await this.settled();
    await this.hub.close();
    this.store.close();
    if (this.#mediaDir !== null) rmSync(this.#mediaDir, { recursive: true, force: true });
  }
}

export function events(frames: readonly ServerFrame[]): EventFrame[] {
  return frames.filter((frame): frame is EventFrame => frame.type === "event");
}

export function results(frames: readonly ServerFrame[]): ResultFrame[] {
  return frames.filter((frame): frame is ResultFrame => frame.type === "result");
}

export function views(frames: readonly ServerFrame[], name?: string): ViewFrame[] {
  return frames.filter((frame): frame is ViewFrame => frame.type === "view" && (name === undefined || frame.name === name));
}

export function signals(frames: readonly ServerFrame[], kind?: string): SignalFrame[] {
  return frames.filter((frame): frame is SignalFrame => frame.type === "signal" && (kind === undefined || frame.kind === kind));
}

export function resultFor(frames: readonly ServerFrame[], rid: string): ResultFrame | undefined {
  return results(frames).find((frame) => frame.rid === rid);
}

/** The Scribe's answer, as its model writes one. */
export function scribeReply(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}
