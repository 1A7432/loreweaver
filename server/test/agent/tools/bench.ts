// A room for the Keeper's tools: an in-memory store with every document type the tools
// touch registered, the three built-in rule packs, and helpers to seat a character, build
// a turn's catalogue and call a tool the way the turn engine will.
import type { Who } from "loreweaver/module";

import type { RoomContext, Services } from "../../../src/agent/context.ts";
import {
  buildCatalog,
  type CatalogInput,
  type ModuleCommand,
  type ToolDeps,
  type ToolOutcome,
  TurnCatalog,
  TurnLedger,
} from "../../../src/agent/tools/index.ts";
import {
  characterData,
  characterDocumentType,
  CHARACTER_TYPE,
  claimableDocument,
  createCharacter,
  seatingData,
  seatingDocument,
  SEATING_ID,
  SEATING_TYPE,
} from "../../../src/core/characters/index.ts";
import { chronicleRecordDocumentType, plotThreadDocumentType } from "../../../src/core/chronicle/index.ts";
import { clockOwnerDocument, gameClockDocument, initiativeDocument } from "../../../src/core/clock/index.ts";
import { DocumentTypes, type JsonObject } from "../../../src/core/documents/model.ts";
import { RawDocuments } from "../../../src/core/documents/raw.ts";
import { DocumentViews } from "../../../src/core/documents/views.ts";
import { loreEntryDocumentType, loreOverlayDocumentType } from "../../../src/core/lore/index.ts";
import { keeperNotesDocument, npcIntentsDocument, sceneDocument } from "../../../src/core/notes/index.ts";
import { npcDocument } from "../../../src/core/npcs/index.ts";
import type { RandomSource } from "../../../src/core/random.ts";
import { relationshipsDocumentType } from "../../../src/core/relationships/index.ts";
import { builtInPacks, type RulePack, RulePackRegistry } from "../../../src/core/rulepacks/index.ts";
import type { SheetSpec } from "../../../src/core/sheets/index.ts";
import { moduleVariablesDocument, variableTreeDocument } from "../../../src/core/variables/index.ts";
import { ScriptedLLM } from "../../../src/infra/llm/index.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { type RoomWriter, Store } from "../../../src/infra/store.ts";
import { testClock } from "../../helpers.ts";

export const ROOM = "room-1";

/** Answers queued values first (clamped into the asked range), then the low end. */
export class QueueRandom implements RandomSource {
  readonly #values: number[];

  constructor(values: readonly number[] = []) {
    this.#values = [...values];
  }

  push(...values: number[]): void {
    this.#values.push(...values);
  }

  nextInt(lo: number, hi: number, step = 1): number {
    const value = this.#values.shift() ?? lo;
    const clamped = Math.min(hi, Math.max(lo, value));
    return lo + step * Math.floor((clamped - lo) / step);
  }
}

export interface Bench {
  readonly store: Store;
  readonly services: Services;
  readonly packs: RulePackRegistry;
  readonly random: QueueRandom;
  pack(id: string): RulePack;
  /** A new turn's writer. */
  writer(): RoomWriter;
  context(options?: { writer?: RoomWriter; who?: Who; pack?: string | null; locale?: string; variant?: string | null }): RoomContext;
  /** Store a character (coc7 by default) owned by `owner`, and seat the owner on it. */
  addCharacter(id: string, name: string, options?: { owner?: string; pack?: string; sheet?: JsonObject; seat?: boolean }): void;
  catalog(options?: Partial<CatalogInput>): TurnCatalog;
  call(catalog: TurnCatalog, name: string, args: Readonly<Record<string, unknown>>, options?: { context?: RoomContext; ledger?: TurnLedger }): Promise<ToolOutcome>;
  put(type: string, id: string, data: JsonObject, meta?: JsonObject): void;
}

export const ADA: Who = { member: { id: "m-ada", name: "Ada", role: "player" }, character: { id: "ada", name: "Ada" } };
export const NOBODY: Who = { member: { id: "m-eve", name: "Eve", role: "player" }, character: null };

export function bench(): Bench {
  const store = new Store(openDatabase(":memory:"));
  const packs = new RulePackRegistry(builtInPacks());
  const specFor = (id: string): SheetSpec | null => packs.get(id)?.sheet ?? null;
  const types = new DocumentTypes();
  for (const type of [
    characterDocumentType(specFor),
    seatingDocument,
    claimableDocument,
    gameClockDocument,
    clockOwnerDocument,
    initiativeDocument,
    keeperNotesDocument,
    sceneDocument,
    npcIntentsDocument,
    npcDocument,
    chronicleRecordDocumentType,
    plotThreadDocumentType,
    loreEntryDocumentType,
    loreOverlayDocumentType,
    variableTreeDocument,
    moduleVariablesDocument,
    relationshipsDocumentType,
  ]) {
    types.register(type as Parameters<DocumentTypes["register"]>[0]);
  }
  const llm = new ScriptedLLM([]);
  const services: Services = {
    store,
    types,
    documents: new RawDocuments(store, types),
    views: new DocumentViews(store, types),
    packs,
    models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm },
    clock: testClock(),
    report: () => {},
  };
  const random = new QueueRandom();
  let current: RoomWriter | null = null;
  const writer = (): RoomWriter => {
    current = store.beginTurn(ROOM);
    return current;
  };
  const pack = (id: string): RulePack => {
    const found = packs.get(id);
    if (found === null) throw new Error(`no pack ${id}`);
    return found;
  };
  const self: Bench = {
    store,
    services,
    packs,
    random,
    pack,
    writer,
    context: (options = {}) => ({
      services,
      room: ROOM,
      turn: (options.writer ?? current ?? writer()).turn,
      writer: options.writer ?? current ?? writer(),
      locale: options.locale ?? "en",
      pack: options.pack === null ? null : pack(options.pack ?? "coc7"),
      variant: options.variant ?? null,
      who: options.who ?? ADA,
      random,
    }),
    addCharacter: (id, name, options = {}) => {
      const packId = options.pack ?? "coc7";
      const sheet = options.sheet ?? {
        name,
        attributes: { STR: 50, CON: 60, SIZ: 60, DEX: 70, APP: 50, INT: 70, POW: 60, EDU: 70, LUC: 50 },
        skills: { 侦查: 60 },
      };
      const made = createCharacter(pack(packId).sheet, { ...sheet, name }, { owner: options.owner ?? `m-${id}` });
      if (!made.ok) throw new Error(made.code);
      const w = current ?? writer();
      services.documents.put(w, CHARACTER_TYPE, id, characterData(made.data));
      if (options.seat !== false) {
        const existing = services.documents.get(ROOM, SEATING_TYPE, SEATING_ID);
        const seats = existing === null ? [] : (existing.data.seats as JsonObject[]);
        services.documents.put(w, SEATING_TYPE, SEATING_ID, seatingData({ seats: [...seats, { member: options.owner ?? `m-${id}`, character: id, memberName: name }] as never }));
      }
    },
    catalog: (options = {}) =>
      buildCatalog({
        unlocked: options.unlocked ?? new Set(),
        keeperOwnsClock: options.keeperOwnsClock ?? true,
        pack: options.pack === undefined ? pack("coc7") : options.pack,
        commands: options.commands ?? ([] as ModuleCommand[]),
        deps: options.deps ?? ({} as ToolDeps),
      }),
    call: (catalog, name, args, options = {}) =>
      catalog.dispatch(options.context ?? self.context(), { name, input: { valid: true, value: args } }, options.ledger ?? new TurnLedger()),
    put: (type, id, data, meta = {}) => {
      services.documents.put(current ?? writer(), type, id, data, meta);
    },
  };
  return self;
}

/** The stored data of a document, or null. */
export function stored(bench: Bench, type: string, id: string): JsonObject | null {
  return bench.services.documents.get(ROOM, type, id)?.data ?? null;
}
