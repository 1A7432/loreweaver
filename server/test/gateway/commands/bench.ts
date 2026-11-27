// A room to run commands in: an in-memory store, every document type registered, the three
// built-in rule packs, and a context per member.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RoomContext, Services } from "../../../src/agent/context.ts";
import type { RecallDeps } from "../../../src/agent/recall.ts";
import { characterDocumentType, claimableDocument, seatingDocument } from "../../../src/core/characters/index.ts";
import { campaignSummaryDocumentType, chronicleRecordDocumentType, plotThreadDocumentType } from "../../../src/core/chronicle/index.ts";
import { clockOwnerDocument, gameClockDocument, initiativeDocument } from "../../../src/core/clock/index.ts";
import { DocumentTypes, DocumentViews } from "../../../src/core/documents/index.ts";
import { RawDocuments } from "../../../src/core/documents/raw.ts";
import { tableHabitsDocumentType } from "../../../src/core/habits/index.ts";
import { loreEntryDocumentType, loreOverlayDocumentType, loreTimersDocumentType } from "../../../src/core/lore/index.ts";
import { keeperNotesDocument, npcIntentsDocument, sceneDocument } from "../../../src/core/notes/index.ts";
import { npcDocument } from "../../../src/core/npcs/index.ts";
import { SeededRandom } from "../../../src/core/random.ts";
import { relationshipsDocumentType } from "../../../src/core/relationships/index.ts";
import { builtInPacks, RulePackRegistry } from "../../../src/core/rulepacks/index.ts";
import { moduleVariablesDocument, variableTreeDocument } from "../../../src/core/variables/index.ts";
import { CommandRegistry, type CommandOutcome, type CommandSuccess, type KeyAdmin, type ModuleCommands, ROOM_RULE_VARIANT, whoIn } from "../../../src/gateway/commands/index.ts";
import { ModelSettings } from "../../../src/gateway/model_settings.ts";
import { ServerSettings } from "../../../src/infra/server_settings.ts";
import { Keystore } from "../../../src/net/keystore.ts";
import { Uploads } from "../../../src/gateway/uploads.ts";
import type { Clock } from "../../../src/infra/ids.ts";
import { type MediaLimits, MediaStore } from "../../../src/infra/media/index.ts";
import { type LLMClient, ScriptedLLM } from "../../../src/infra/llm/index.ts";
import type { ReviewFilter } from "../../../src/gateway/review.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { Store } from "../../../src/infra/store.ts";

export const ROOM = "table";

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly role: "player" | "admin" | "observer";
}

export const ADA: Member = { id: "m-ada", name: "Ada", role: "player" };
export const BAO: Member = { id: "m-bao", name: "Bao", role: "player" };
export const ADMIN: Member = { id: "m-root", name: "Root", role: "admin" };
export const EVE: Member = { id: "m-eve", name: "Eve", role: "observer" };

export function fixedClock(): Clock {
  let ids = 0;
  let now = 1_700_000_000_000;
  return { id: () => `id-${++ids}`, now: () => now++ };
}

export interface Bench {
  readonly services: Services;
  readonly store: Store;
  readonly registry: CommandRegistry;
  readonly reports: string[];
  /** Members' files, when the bench was made with `media`. */
  readonly uploads: Uploads | null;
  /** The room's rule system for the next context; null for none. */
  system: string | null;
  /** A context for `member`, on a fresh turn unless `turn` says otherwise. */
  context(member: Member, options?: { readonly seed?: string; readonly newTurn?: boolean; readonly locale?: string }): RoomContext;
  /** Run a typed line as `member`. */
  input(member: Member, line: string, locale?: string): ReturnType<CommandRegistry["input"]>;
  /** Run `command.run` as `member`. */
  run(member: Member, id: string, args: unknown, locale?: string): Promise<CommandOutcome>;
  /** The model settings and keystore, when the bench was made with `admin`. */
  readonly models: ModelSettings | null;
  readonly keystore: Keystore | null;
}

/** Blob directories of benches made with `media`, removed when the test process ends. */
const mediaDirs: string[] = [];
process.on("exit", () => {
  for (const dir of mediaDirs) rmSync(dir, { recursive: true, force: true });
});

export interface BenchOptions {
  readonly system?: string | null;
  readonly modules?: ModuleCommands;
  readonly seed?: string;
  readonly resetConfirmMs?: number;
  /** A media store (in a temporary directory) behind `uploads` and `import`; with these limits when given. */
  readonly media?: boolean | MediaLimits;
  readonly recall?: RecallDeps;
  /** Model settings (an OpenAI Keeper, scripted clients) and an in-memory keystore with one admin key, behind `model`, `imagegen` and `key`. */
  readonly admin?: boolean;
  /** The model every lane of `services.models` talks to (`genchar`, a character import); default: one with no reply. */
  readonly model?: LLMClient;
  /** The operator's word filter for the command table; default: off. */
  readonly review?: ReviewFilter;
  /** Model settings with no model configured at all (not with `admin`). */
  readonly noModel?: boolean;
}

/** The Keeper's key in an `admin` bench's settings. */
export const ENV_KEY = "sk-env-keeper-0123456789";

export function bench(options: BenchOptions = {}): Bench {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  const packs = new RulePackRegistry(builtInPacks());
  const types = new DocumentTypes()
    .register(characterDocumentType((id) => packs.get(id)?.sheet ?? null))
    .register(seatingDocument)
    .register(claimableDocument)
    .register(npcDocument)
    .register(loreEntryDocumentType)
    .register(loreOverlayDocumentType)
    .register(loreTimersDocumentType)
    .register(tableHabitsDocumentType)
    .register(variableTreeDocument)
    .register(moduleVariablesDocument)
    .register(chronicleRecordDocumentType)
    .register(campaignSummaryDocumentType)
    .register(plotThreadDocumentType)
    .register(relationshipsDocumentType)
    .register(initiativeDocument)
    .register(gameClockDocument)
    .register(clockOwnerDocument)
    .register(sceneDocument)
    .register(keeperNotesDocument)
    .register(npcIntentsDocument);
  const llm = options.model ?? new ScriptedLLM([]);
  const reports: string[] = [];
  const services: Services = {
    store,
    types,
    documents: new RawDocuments(store, types),
    views: new DocumentViews(store, types),
    packs,
    models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm },
    clock: fixedClock(),
    report: (_room, text) => {
      reports.push(text);
    },
  };
  let uploads: Uploads | null = null;
  if (options.media !== undefined && options.media !== false) {
    const dir = mkdtempSync(join(tmpdir(), "loreweaver-bench-media-"));
    mediaDirs.push(dir);
    uploads = new Uploads(new MediaStore(dir, db, { clock: fixedClock(), ...(options.media === true ? {} : { limits: options.media }) }));
  }
  let models: ModelSettings | null = null;
  let keystore: Keystore | null = null;
  let keys: KeyAdmin | null = null;
  if (options.noModel === true) models = new ModelSettings({ lanes: {} }, new ServerSettings(db));
  if (options.admin === true) {
    models = new ModelSettings({ llm: { preset: "openai", apiKey: ENV_KEY, model: "gpt-5.5" }, lanes: {} }, new ServerSettings(db), { llm: () => ({ client: new ScriptedLLM([]) }), image: () => ({ generate: () => Promise.reject(new Error("no pictures in tests")) }) });
    keystore = new Keystore();
    keystore.add("root-key-0123456789abcdef", { room: ROOM, name: "Root", role: "admin" });
    keystore.add("ada-key-0123456789abcdef", { room: ROOM, name: "Ada", role: "player" });
    keys = { book: keystore, online: () => new Set() };
  }
  const registry = new CommandRegistry({
    models,
    keys,
    modules: options.modules ?? null,
    uploads,
    recall: options.recall ?? null,
    ...(options.review === undefined ? {} : { review: options.review }),
    ...(options.resetConfirmMs === undefined ? {} : { resetConfirmMs: options.resetConfirmMs }),
  });
  let seeds = 0;
  const self: Bench = {
    services,
    store,
    registry,
    reports,
    uploads,
    system: options.system === undefined ? "coc7" : options.system,
    models,
    keystore,
    context(member, contextOptions = {}) {
      const writer = contextOptions.newTurn === false ? store.writer(ROOM) : store.beginTurn(ROOM);
      const pack = self.system === null ? null : packs.get(self.system);
      return {
        services,
        room: ROOM,
        turn: writer.turn,
        writer,
        locale: contextOptions.locale ?? "en",
        pack,
        variant: store.stateGet(ROOM, ROOM_RULE_VARIANT),
        who: whoIn(services, ROOM, member, "en"),
        random: new SeededRandom(contextOptions.seed ?? `${options.seed ?? "bench"}:${++seeds}`),
      };
    },
    // As the gateway does: a room-lifecycle command runs on the room's current turn, any
    // other command on a turn of its own.
    input(member, line, locale = "en") {
      const probe = self.context(member, { newTurn: false });
      const parsed = registry.textCommand(probe, line, locale);
      const lifecycle = parsed !== null && "id" in parsed && registry.spec(probe, parsed.id)?.lifecycle === true;
      return registry.input(lifecycle ? probe : self.context(member), line, locale);
    },
    run(member, id, args, locale = "en") {
      const probe = self.context(member, { newTurn: false });
      return registry.run(registry.spec(probe, id)?.lifecycle === true ? probe : self.context(member), id, args, locale);
    },
  };
  return self;
}

export function ok(outcome: CommandOutcome): CommandSuccess {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
  return outcome;
}

export function code(outcome: CommandOutcome): string {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.code;
}
