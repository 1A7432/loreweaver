// Building a running server out of its parts.
//
// `composeHub` joins the pieces that do not depend on where they came from — the store,
// the model clients, the worker spawner — into a `Hub`; `openServer` makes those parts from
// `Settings` and a data directory and puts the transport in front. The self-test composes
// with scripted parts through the same `composeHub`, so what it proves about a compiled
// binary is true of the server that binary serves.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { LaneModels, Services } from "../agent/context.ts";
import { recallStorages, type RecallDeps } from "../agent/recall.ts";
import { servicesOn } from "../agent/services.ts";
import type { GenerateImage } from "../agent/tools/index.ts";
import { recordPlayerAction, runKeeperTurn } from "../agent/turn/index.ts";
import { builtInPacks, RulePackRegistry } from "../core/rulepacks/index.ts";
import { builtInSkillRegistry } from "../core/skills/index.ts";
import { CommandRegistry } from "../gateway/commands/index.ts";
import { Hub } from "../gateway/hub.ts";
import { parseReviewList, REVIEW_OFF, type ReviewFilter } from "../gateway/review.ts";
import type { Settings } from "../infra/config.ts";
import { type Clock, systemClock } from "../infra/ids.ts";
import { ImageGenError, OpenAICompatibleImageGen } from "../infra/imagegen/index.ts";
import { RoomStorages } from "../infra/lifecycle/storages.ts";
import { createLLM, type LLMClient, LLMError } from "../infra/llm/index.ts";
import { MediaStore } from "../infra/media/index.ts";
import { ensurePrivateDir, writePrivateFile } from "../infra/private_files.ts";
import { OpenAIEmbeddings, VectorIndex } from "../infra/recall/index.ts";
import { openDatabase } from "../infra/runtime/sqlite.ts";
import { spawnWorker, type WorkerHandle } from "../infra/runtime/worker.ts";
import { Store } from "../infra/store.ts";
import { IrohServer } from "../net/iroh.ts";
import { Keystore } from "../net/keystore.ts";

/**
 * The window assumed for a model this server has no figure for. Deliberately small: a
 * window guessed too large never folds and ends in the provider refusing the prompt; one
 * guessed too small only folds early. The operator states the real one with
 * `TRPG_LLM__CONTEXT_WINDOW`, and `openServer` says so when it falls back to this.
 */
export const FALLBACK_CONTEXT_WINDOW = 32_000;

/** How often idle room workers are looked for, and how long idle is. */
const EVICT_EVERY_MS = 60_000;
const WORKER_IDLE_MS = 10 * 60_000;
/** Pictures the Keeper may ask for per room per hour (the 2.6 default). */
const KEEPER_IMAGES_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
/** The room the first admin key of a fresh data directory belongs to. */
export const FIRST_ROOM = "main";

/** A lane with no model configured: every call fails as a provider that refuses the key. */
class UnconfiguredLLM implements LLMClient {
  chat(): Promise<never> {
    return Promise.reject(new LLMError({ code: "auth", retryable: false }));
  }
}

export interface HubParts {
  readonly settings: Settings;
  readonly store: Store;
  readonly models: LaneModels;
  /** The Keeper model's context window, in tokens. */
  readonly contextWindow: number;
  readonly clock: Clock;
  readonly report: (room: string, text: string) => void;
  readonly spawnWorker: () => WorkerHandle;
  /** The module entry files enabled in a room. */
  readonly modulesFor: (room: string) => readonly string[];
  readonly review: ReviewFilter;
  readonly recall?: RecallDeps;
  readonly generateImage?: GenerateImage;
  readonly packs?: RulePackRegistry;
  readonly defaultRulePack?: string | null;
}

export function composeHub(parts: HubParts): { readonly hub: Hub; readonly services: Services } {
  const { settings } = parts;
  const services = servicesOn({
    store: parts.store,
    packs: parts.packs ?? new RulePackRegistry(builtInPacks()),
    models: parts.models,
    clock: parts.clock,
    report: parts.report,
  });
  const hub = new Hub({
    services,
    env: {
      skills: builtInSkillRegistry(),
      ...(parts.recall === undefined ? {} : { recall: parts.recall }),
      ...(parts.generateImage === undefined ? {} : { generateImage: parts.generateImage }),
      settings: {
        maxRounds: settings.turn.maxRounds,
        contextWindow: parts.contextWindow,
        foldEnabled: settings.chronicle.enabled,
        fold: {
          trigger: settings.chronicle.trigger,
          floor: settings.chronicle.floor,
          emergency: settings.chronicle.emergency,
          lagTurns: settings.chronicle.lagTurns,
          summaryMaxChars: settings.chronicle.summaryMaxChars,
        },
      },
    },
    commands: (modules) => new CommandRegistry({ modules }),
    runTurn: runKeeperTurn,
    recordPlayerAction,
    defaultLocale: settings.locale,
    defaultRulePack: parts.defaultRulePack ?? null,
    review: parts.review,
    lanes: {
      scribe: settings.scribe.enabled,
      director: settings.director.enabled,
      directorSettings: {
        imagesEnabled: settings.director.images && settings.imagegen !== undefined,
        maxImages: settings.director.maxImages,
        pregenPerBeat: settings.director.pregenPerBeat,
      },
    },
    // A room's presentation kit comes from its installed packs; until packs install, no room has one.
    kitFor: () => null,
    spawnWorker: parts.spawnWorker,
    modulesFor: parts.modulesFor,
    workerTimeoutMs: settings.modules.callTimeoutMs,
  });
  return { hub, services };
}

export interface ServerOptions {
  /** `n0`: the public relays. `local`: loopback only (tests). */
  readonly mode: "n0" | "local";
  /** The room worker's entry file (`roomWorkerEntry()`). */
  readonly workerEntry: string;
  /** For the operator's log; defaults to standard error. */
  readonly report?: (room: string, text: string) => void;
}

export interface RunningServer {
  /** What a client dials. */
  readonly ticket: string;
  /** An admin key minted because the data directory had none; shown once, here. */
  readonly firstKey: { readonly room: string; readonly key: string } | null;
  /** Things the operator should know at start-up, as stable codes. */
  readonly notes: readonly string[];
  readonly hub: Hub;
  readonly keystore: Keystore;
  close(): Promise<void>;
}

/** A start-up refusal the operator must fix: stable code, no half-configured server. */
export class StartupError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`startup: ${code}`);
    this.name = "StartupError";
    this.code = code;
  }
}

/**
 * The word filter from settings: the inline list and the file's lines together. A list
 * that cannot be read is a refusal to start — an operator who asked for a filter must not
 * get an unfiltered server.
 */
function reviewFrom(settings: Settings): ReviewFilter {
  const parts: string[] = [];
  if (settings.review.wordlist !== undefined) parts.push(settings.review.wordlist);
  if (settings.review.wordlistPath !== undefined) {
    if (!existsSync(settings.review.wordlistPath)) throw new StartupError("review_wordlist_missing");
    parts.push(readFileSync(settings.review.wordlistPath, "utf8").split(/\r?\n/u).join(","));
  }
  if (parts.length === 0) return REVIEW_OFF;
  const parsed = parseReviewList(parts.join(","));
  if (!parsed.ok) throw new StartupError(`review_wordlist_${parsed.code}`);
  return parsed.filter;
}

/** The transport's secret key: the same identity, and so the same ticket, across restarts. */
function transportSecret(dataDir: string): Uint8Array {
  const path = join(dataDir, "transport.key");
  if (existsSync(path)) {
    const stored = readFileSync(path);
    if (stored.length === 32) return new Uint8Array(stored);
  }
  const secret = crypto.getRandomValues(new Uint8Array(32));
  writePrivateFile(path, secret);
  return secret;
}

export interface OpenData {
  readonly store: Store;
  readonly media: MediaStore;
  /** Absent: recall by meaning is off. */
  readonly recall: RecallDeps | undefined;
}

/**
 * The data directory, opened: the database, the media store and the vector index, with the
 * storages a reset or a delete must clear registered on the store. The server and the
 * operator's commands open it the same way, so neither can forget a storage.
 */
export function openData(settings: Settings, clock: Clock = systemClock): OpenData {
  ensurePrivateDir(settings.dataDir);
  const db = openDatabase(join(settings.dataDir, "loreweaver.db"));
  const media = new MediaStore(settings.dataDir, db, { clock });
  const storages = new RoomStorages().register({
    name: "media",
    lifecycle: { reset: "all" },
    clear: (room) => {
      media.deleteRoom(room);
    },
  });
  let recall: RecallDeps | undefined;
  if (settings.embeddings !== undefined) {
    const index = new VectorIndex(settings.embeddings.dimensions, db);
    for (const storage of recallStorages(index)) storages.register(storage);
    recall = { embeddings: new OpenAIEmbeddings(settings.embeddings), index };
  }
  return { store: new Store(db, { undoDepth: settings.store.undoDepth, storages }), media, recall };
}

/** The key file of a data directory. */
export function keystoreIn(dataDir: string): Keystore {
  return new Keystore(join(dataDir, "keys.json"));
}

export async function openServer(settings: Settings, options: ServerOptions): Promise<RunningServer> {
  const notes: string[] = [];
  // Before anything is opened: a refusal here leaves nothing behind.
  const review = reviewFrom(settings);
  const clock = systemClock;
  const report = options.report ?? ((room: string, text: string): void => console.error(`[${room}] ${text}`));
  const { store, media, recall } = openData(settings, clock);
  if (recall === undefined) notes.push("recall_off");

  // Model clients: one per lane that names its own endpoint, the Keeper's otherwise.
  let keeper: LLMClient;
  let contextWindow = FALLBACK_CONTEXT_WINDOW;
  if (settings.llm === undefined) {
    keeper = new UnconfiguredLLM();
    notes.push("model_not_configured");
  } else {
    const configured = createLLM(settings.llm);
    keeper = configured;
    if (configured.contextWindow === undefined) notes.push("context_window_unknown");
    else contextWindow = configured.contextWindow;
  }
  const lane = (own: Settings["lanes"]["npc"]): LLMClient => (own === undefined ? keeper : createLLM(own));
  const models: LaneModels = {
    keeper,
    npc: lane(settings.lanes.npc),
    scribe: lane(settings.lanes.scribe),
    director: lane(settings.lanes.director),
    memory: lane(settings.lanes.memory),
  };

  // The Keeper's `generate_image`: make, store as the room's media, count against the hour.
  let generateImage: GenerateImage | undefined;
  if (settings.imagegen !== undefined) {
    const client = new OpenAICompatibleImageGen(settings.imagegen);
    const made = new Map<string, number[]>();
    generateImage = async (request) => {
      const now = clock.now();
      const recent = (made.get(request.room) ?? []).filter((at) => now - at < HOUR_MS);
      if (recent.length >= KEEPER_IMAGES_PER_HOUR) return { ok: false, code: "rate_limited" };
      made.set(request.room, [...recent, now]);
      try {
        const image = await client.generate({ prompt: request.prompt });
        const stored = await media.registerServerBlob({ room: request.room, bytes: image.bytes, mime: image.mime, name: request.caption, audience: "room" });
        if (!stored.ok) return { ok: false, code: stored.code };
        const { hash, mime, size, name } = stored.record;
        return { ok: true, media: { hash, mime, size, name, from: "server" } };
      } catch (error) {
        return { ok: false, code: error instanceof ImageGenError ? error.code : "unknown" };
      }
    };
  }

  const { hub } = composeHub({
    settings,
    store,
    models,
    contextWindow,
    clock,
    report,
    spawnWorker: () => spawnWorker(options.workerEntry),
    // Modules reach a room through an installed pack; until packs install, no room has one.
    modulesFor: () => [],
    review,
    ...(recall === undefined ? {} : { recall }),
    ...(generateImage === undefined ? {} : { generateImage }),
  });

  const fresh = !existsSync(join(settings.dataDir, "keys.json"));
  const keystore = keystoreIn(settings.dataDir);
  const firstKey = fresh ? { room: FIRST_ROOM, key: keystore.mint({ room: FIRST_ROOM, name: "Admin", role: "admin" }).key } : null;

  const server = new IrohServer({ keystore, room: (id) => hub.room(id) }, { mode: options.mode, secretKey: transportSecret(settings.dataDir) });
  const ticket = await server.start();
  const evictor = setInterval(() => {
    void hub.evictIdle(WORKER_IDLE_MS);
  }, EVICT_EVERY_MS);

  return {
    ticket,
    firstKey,
    notes,
    hub,
    keystore,
    close: async () => {
      clearInterval(evictor);
      await server.close();
      await hub.close();
      store.close();
    },
  };
}
