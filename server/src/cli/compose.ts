// Building a running server out of its parts.
//
// `composeHub` joins the pieces that do not depend on where they came from — the store,
// the model clients, the worker spawner — into a `Hub`; `openServer` makes those parts from
// `Settings` and a data directory and puts the transport in front. The self-test composes
// with scripted parts through the same `composeHub`, so what it proves about a compiled
// binary is true of the server that binary serves.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { LaneModels, Services } from "../agent/context.ts";
import { recallStorages, type RecallDeps } from "../agent/recall.ts";
import type { DirectorImageDeps } from "../agent/lanes/director.ts";
import { servicesOn } from "../agent/services.ts";
import type { GenerateImage } from "../agent/tools/index.ts";
import { recordPlayerAction, runKeeperTurn } from "../agent/turn/index.ts";
import { builtInPacks, RulePackRegistry } from "../core/rulepacks/index.ts";
import { CommandRegistry, type KeyBook, ROOM_LOCALE } from "../gateway/commands/index.ts";
import { Hub } from "../gateway/hub.ts";
import { ModelSettings } from "../gateway/model_settings.ts";
import { loadInstalledPacks } from "../gateway/pack_install.ts";
import { assemblePacks, RoomPacks } from "../gateway/packs.ts";
import { parseReviewList, REVIEW_OFF, type ReviewFilter } from "../gateway/review.ts";
import { Uploads } from "../gateway/uploads.ts";
import type { Settings } from "../infra/config.ts";
import { type Clock, systemClock } from "../infra/ids.ts";
import { ImageGenError, type ImageGenerator, RASTER_MIMES } from "../infra/imagegen/index.ts";
import { RoomStorages } from "../infra/lifecycle/storages.ts";
import { DEFAULT_MEDIA_LIMITS, MediaStore } from "../infra/media/index.ts";
import { ensurePrivateDir, writePrivateFile } from "../infra/private_files.ts";
import { OpenAIEmbeddings, VectorIndex } from "../infra/recall/index.ts";
import { openDatabase } from "../infra/runtime/sqlite.ts";
import { spawnWorker, type WorkerHandle } from "../infra/runtime/worker.ts";
import { ServerSettings } from "../infra/server_settings.ts";
import { Store } from "../infra/store.ts";
import { IrohServer } from "../net/iroh.ts";
import { Keystore } from "../net/keystore.ts";

/** The window assumed for a Keeper model this server has no figure for (`openServer` says so when it falls back to it). */
export { FALLBACK_CONTEXT_WINDOW } from "../gateway/model_settings.ts";

/** How often idle room workers are looked for, and how long idle is. */
const EVICT_EVERY_MS = 60_000;
const WORKER_IDLE_MS = 10 * 60_000;
/** Pictures the Keeper may ask for per room per hour (the 2.6 default). */
const KEEPER_IMAGES_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
/** The room the first admin key of a fresh data directory belongs to. */
export const FIRST_ROOM = "main";

export interface HubParts {
  readonly settings: Settings;
  readonly store: Store;
  readonly models: LaneModels;
  /** The Keeper model's context window, in tokens. */
  readonly contextWindow: number;
  readonly clock: Clock;
  readonly report: (room: string, text: string) => void;
  readonly spawnWorker: () => WorkerHandle;
  /**
   * The installed packs and the server's skills: a room's modules, kit, skills and pack
   * cards come from the packs it enabled. Default: none installed, the built-in skills.
   */
  readonly roomPacks?: RoomPacks;
  /** Overrides the module entry files of a room (a harness's own); default: the room's enabled packs'. */
  readonly modulesFor?: (room: string) => readonly string[];
  readonly review: ReviewFilter;
  readonly recall?: RecallDeps;
  readonly generateImage?: GenerateImage;
  /** The Stage Director's pictures for a room, now; null while there is no image client. */
  readonly directorImages?: (room: string) => DirectorImageDeps | null;
  readonly packs?: RulePackRegistry;
  readonly defaultRulePack?: string | null;
  /** The media store: members' uploads and fetches over the byte channel, `uploads` and `import`. Absent: none. */
  readonly media?: MediaStore;
  /**
   * The model lanes at run time (`model`, `imagegen`, `admin/model`); `models` should then be
   * its `liveModels()`. Absent: `models` for the server's life, and those commands unavailable.
   */
  readonly modelSettings?: ModelSettings;
  /** The access keys (`key`, `admin/keys`). Absent: neither. */
  readonly keys?: KeyBook;
}

export function composeHub(parts: HubParts): { readonly hub: Hub; readonly services: Services } {
  const { settings } = parts;
  // One object for members' files, shared by the rooms (the byte channel) and the command
  // table (`uploads`, `import`), so both see the same offers and import files.
  const uploads = parts.media === undefined ? null : new Uploads(parts.media);
  const roomPacks = parts.roomPacks ?? RoomPacks.none();
  const store = parts.store;
  const roomLocale = (room: string): string => store.stateGet(room, ROOM_LOCALE) ?? settings.locale;
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
      skills: roomPacks.skillRegistry,
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
    commands: (modules, keys) => new CommandRegistry({ modules, uploads, recall: parts.recall ?? null, packs: roomPacks, models: parts.modelSettings ?? null, keys }),
    runTurn: runKeeperTurn,
    recordPlayerAction,
    defaultLocale: settings.locale,
    defaultRulePack: parts.defaultRulePack ?? null,
    review: parts.review,
    lanes: {
      scribe: settings.scribe.enabled,
      director: settings.director.enabled,
      directorSettings: {
        // Whether the operator allows them; whether a client exists is asked at each pass.
        imagesEnabled: settings.director.images && parts.directorImages !== undefined,
        maxImages: settings.director.maxImages,
        pregenPerBeat: settings.director.pregenPerBeat,
      },
    },
    // A room's presentation kit, modules and pack cards come from the packs it enabled.
    kitFor: (room) => roomPacks.kitFor(store, room, roomLocale(room)),
    spawnWorker: parts.spawnWorker,
    modulesFor: parts.modulesFor ?? ((room) => roomPacks.modulesFor(store, room)),
    packs: roomPacks,
    workerTimeoutMs: settings.modules.callTimeoutMs,
    ...(uploads === null ? {} : { uploads }),
    ...(parts.modelSettings === undefined ? {} : { models: parts.modelSettings }),
    ...(parts.keys === undefined ? {} : { keys: parts.keys }),
    ...(parts.directorImages === undefined ? {} : { images: parts.directorImages }),
  });
  return { hub, services };
}

/**
 * The Stage Director's pictures for a room: the image client as it is NOW (an admin may
 * switch it at run time; null means none, and the pass shows the pack's own picture), the
 * room's own media to read a subject's reference from and to keep the picture in. A picture
 * it makes is the room's, like one the Keeper asked for.
 */
export function directorImagesFrom(client: () => ImageGenerator | null, media: MediaStore): (room: string) => DirectorImageDeps | null {
  return (room) => {
    const now = client();
    if (now === null) return null;
    return {
      generate: async (request, signal) => {
        // The reference is a pack's picture; only a raster one can condition a picture.
        const mime = RASTER_MIMES.find((known) => known === request.reference.mime);
        if (mime === undefined) throw new ImageGenError("bad_request");
        return now.generate({ prompt: request.prompt, reference: { bytes: request.reference.bytes, mime } }, signal);
      },
      // A subject's reference picture is a pack asset the room registered, whatever its audience.
      readAsset: async (asset) => (await media.read(room, asset.hash, "admin"))?.bytes ?? null,
      storeImage: async (bytes, mime, name) => {
        const stored = await media.registerServerBlob({ room, bytes, mime, name, audience: "room" });
        return stored.ok ? { hash: stored.record.hash, mime: stored.record.mime, size: stored.record.size } : null;
      },
    };
  };
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
  /** The model lanes and image generation, with the admins' run-time overrides. */
  readonly models: ModelSettings;
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
  /** Server-wide settings an admin changes at run time (the model overrides); no room's lifecycle touches them. */
  readonly serverSettings: ServerSettings;
  readonly media: MediaStore;
  /** The storages a lifecycle operation tells (more may be registered once the server is composed). */
  readonly storages: RoomStorages;
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
  const path = join(settings.dataDir, "loreweaver.db");
  const db = openDatabase(path);
  // The database holds API keys an admin set at run time (`infra/server_settings.ts`): the
  // owner's alone, like the key file. SQLite gives its journal files the database's mode.
  chmodSync(path, 0o600);
  const limits = { ...DEFAULT_MEDIA_LIMITS, audio: { maxFileBytes: settings.media.audioMaxFileBytes, roomQuotaBytes: settings.media.audioRoomQuotaBytes } };
  const media = new MediaStore(settings.dataDir, db, { clock, limits });
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
  return { store: new Store(db, { undoDepth: settings.store.undoDepth, storages }), serverSettings: new ServerSettings(db), media, storages, recall };
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
  const { store, serverSettings, media, storages, recall } = openData(settings, clock);
  if (recall === undefined) notes.push("recall_off");

  // Installed packs: validated again from disk; their rule systems and skills join the
  // built-ins (first claim wins), the rest is per room. A room's admin may install more from
  // chat (`pack install`): it joins these registries in place, without a restart.
  const installed = loadInstalledPacks(settings.dataDir);
  const assembled = assemblePacks(installed.packs);
  notes.push(...installed.notes, ...assembled.notes);
  const roomPacks = new RoomPacks({
    packs: installed.packs,
    skills: assembled.skills,
    ruleSystems: assembled.ruleSystems,
    media,
    report,
    install: { dataDir: settings.dataDir, fetch: (url, init) => fetch(url, init) },
  });
  // A reset of everything (or a load) clears the room's media, kit assets included: put the
  // enabled packs' pictures and sounds back right after, for the room plays on with them.
  storages.register({
    name: "pack_assets",
    lifecycle: { reset: "all" },
    clear: (room, event) => {
      if (event.kind === "delete") return;
      void roomPacks.registerAssets(room, store);
    },
  });

  // Model clients: the operator's settings with the admins' run-time overrides on top; one
  // per lane that names its own endpoint, the Keeper's otherwise. Rebuilt on every change.
  const modelSettings = new ModelSettings(settings, serverSettings);
  const initial = modelSettings.snapshot();
  if (!initial.configured) notes.push("model_not_configured");
  else if (!initial.contextWindowKnown) notes.push("context_window_unknown");
  if (modelSettings.unusableOverrides.length > 0) notes.push("model_override_unusable");

  // The Keeper's `generate_image`: make, store as the room's media, count against the hour.
  // The image client is looked up at each picture: an admin may switch it at run time.
  const made = new Map<string, number[]>();
  const generateImage: GenerateImage = async (request) => {
    const client = modelSettings.image();
    if (client === null) return { ok: false, code: "not_configured" };
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

  const directorImages = directorImagesFrom(() => modelSettings.image(), media);

  const fresh = !existsSync(join(settings.dataDir, "keys.json"));
  const keystore = keystoreIn(settings.dataDir);
  const firstKey = fresh ? { room: FIRST_ROOM, key: keystore.mint({ room: FIRST_ROOM, name: "Admin", role: "admin" }, clock.now()).key } : null;

  const { hub } = composeHub({
    settings,
    store,
    models: modelSettings.liveModels(),
    contextWindow: initial.contextWindow,
    clock,
    report,
    spawnWorker: () => spawnWorker(options.workerEntry),
    roomPacks,
    packs: assembled.ruleSystems,
    review,
    media,
    ...(recall === undefined ? {} : { recall }),
    generateImage,
    directorImages,
    modelSettings,
    keys: keystore,
  });

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
    models: modelSettings,
    close: async () => {
      clearInterval(evictor);
      await server.close();
      await hub.close();
      store.close();
    },
  };
}
