// A room for the turn engine's tests: an in-memory store with every document type and the
// built-in rule packs, one scripted model per lane (each scriptable per test), fake ports
// that record what was published and signalled, and helpers to seed the log and the state.
import type { EventKind, EventPayloads, SignalKind, SignalPayloads } from "loreweaver-protocol/v3";
import type { Who } from "loreweaver/module";

import type { RoomContext, Services } from "../../../src/agent/context.ts";
import type { TextReview } from "../../../src/agent/effects.ts";
import { runKeeperTurn } from "../../../src/agent/turn/index.ts";
import type { TurnEnvironment, TurnInput, TurnPorts, TurnResult, TurnSettings } from "../../../src/agent/turn/types.ts";
import { DEFAULT_FOLD_SETTINGS } from "../../../src/core/chronicle/index.ts";
import type { JsonObject } from "../../../src/core/documents/model.ts";
import { RawDocuments } from "../../../src/core/documents/raw.ts";
import { DocumentViews } from "../../../src/core/documents/views.ts";
import type { RandomSource } from "../../../src/core/random.ts";
import { allDocumentTypes } from "../../../src/core/registry.ts";
import { builtInPacks, RulePackRegistry } from "../../../src/core/rulepacks/index.ts";
import { builtInSkillRegistry } from "../../../src/core/skills/index.ts";
import { type ChatMessage, type ChatOptions, type Responder, type ScriptedReply, ScriptedLLM } from "../../../src/infra/llm/index.ts";
import type { RoomWorker } from "../../../src/infra/room_worker.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { type RoomWriter, Store } from "../../../src/infra/store.ts";
import { testClock } from "../../helpers.ts";

export const ROOM = "turn-room";
export const ADA: Who = { member: { id: "m-ada", name: "Ada", role: "player" }, character: null };

/** Always the same draw, clamped into range: `1d100` rolls `value`. */
export class FixedRandom implements RandomSource {
  readonly #value: number;

  constructor(value = 42) {
    this.#value = value;
  }

  nextInt(lo: number, hi: number, step = 1): number {
    const clamped = Math.min(hi, Math.max(lo, this.#value));
    return lo + step * Math.floor((clamped - lo) / step);
  }
}

export interface Published {
  readonly kind: string;
  readonly id: string;
  readonly turn: number | undefined;
  readonly data: Record<string, unknown>;
}

export interface Signalled {
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

type Source = readonly ScriptedReply[] | Responder;

/** A scripted lane whose script a test may replace at any time. */
export class Lane {
  readonly llm: ScriptedLLM;
  #queue: ScriptedReply[] = [];
  #responder: Responder | null = null;

  constructor() {
    this.llm = new ScriptedLLM((messages, options) => this.#next(messages, options));
  }

  script(source: Source): void {
    if (typeof source === "function") {
      this.#responder = source;
      this.#queue = [];
    } else {
      this.#responder = null;
      this.#queue = [...source];
    }
  }

  get requests() {
    return this.llm.requests;
  }

  #next(messages: readonly ChatMessage[], options: ChatOptions): ScriptedReply | Promise<ScriptedReply> {
    if (this.#responder !== null) return this.#responder(messages, options);
    const next = this.#queue.shift();
    if (next === undefined) throw new Error("lane: no reply left for this call");
    return next;
  }
}

export interface TurnOptions {
  readonly work?: TurnInput["work"];
  readonly speaker?: string;
  readonly who?: Who;
  readonly signal?: AbortSignal;
  readonly worker?: RoomWorker | null;
  readonly loreWorker?: RoomWorker;
  readonly reviewNarrative?: TextReview;
  readonly reviewFact?: TextReview;
  readonly random?: RandomSource;
}

export interface Ran {
  readonly result: TurnResult;
  readonly writer: RoomWriter;
  readonly context: RoomContext;
  /** What this turn published and signalled, in order. */
  readonly events: readonly Published[];
  readonly signals: readonly Signalled[];
}

const PASS: TextReview = (text) => ({ text, allowed: true });

export class Harness {
  readonly store: Store;
  readonly services: Services;
  readonly packs: RulePackRegistry;
  readonly keeper = new Lane();
  readonly memory = new Lane();
  readonly npc = new Lane();
  readonly events: Published[] = [];
  readonly signals: Signalled[] = [];
  readonly reports: string[] = [];
  settings: TurnSettings;
  env: Omit<TurnEnvironment, "settings">;
  #seedWriter: RoomWriter | null = null;

  constructor(settings: Partial<TurnSettings> = {}) {
    this.store = new Store(openDatabase(":memory:"));
    this.packs = new RulePackRegistry(builtInPacks());
    const types = allDocumentTypes(this.packs);
    this.services = {
      store: this.store,
      types,
      documents: new RawDocuments(this.store, types),
      views: new DocumentViews(this.store, types),
      packs: this.packs,
      models: { keeper: this.keeper.llm, npc: this.npc.llm, scribe: new ScriptedLLM([]), director: new ScriptedLLM([]), memory: this.memory.llm },
      clock: testClock(),
      report: (_room, text) => {
        this.reports.push(text);
      },
    };
    this.settings = { maxRounds: 12, contextWindow: 200_000, foldEnabled: true, fold: DEFAULT_FOLD_SETTINGS, ...settings };
    this.env = { skills: builtInSkillRegistry() };
  }

  /** A writer for seeding (the room's current turn). */
  seedWriter(): RoomWriter {
    const writer = this.#seedWriter;
    if (writer !== null && writer.current() && writer.turn === this.store.room(ROOM).turn) return writer;
    this.#seedWriter = this.store.writer(ROOM);
    return this.#seedWriter;
  }

  put(type: string, id: string, data: JsonObject): void {
    this.services.documents.put(this.seedWriter(), type, id, data);
  }

  /** A completed past turn in the log: the player's line and the Keeper's reply. */
  exchange(line: string, reply: string, speaker = "Ada"): number {
    const writer = this.store.beginTurn(ROOM);
    const ts = this.services.clock.now();
    writer.appendEvent({ id: this.services.clock.id(), ts, kind: "narrative", turn: writer.turn, data: { speaker: "player", name: speaker, text: line, format: "plain" } });
    writer.appendEvent({ id: this.services.clock.id(), ts, kind: "narrative", turn: writer.turn, data: { speaker: "kp", text: reply, format: "markdown" } });
    return writer.turn;
  }

  context(writer: RoomWriter, options: TurnOptions = {}): RoomContext {
    const pack = this.packs.get("coc7");
    return {
      services: this.services,
      room: ROOM,
      turn: writer.turn,
      writer,
      locale: "en",
      pack,
      variant: null,
      who: options.who ?? ADA,
      random: options.random ?? new FixedRandom(),
    };
  }

  ports(writer: RoomWriter, options: TurnOptions, sink: { events: Published[]; signals: Signalled[] }): TurnPorts {
    return {
      publish: <K extends EventKind>(kind: K, id: string, data: EventPayloads[K]) => {
        const stored = writer.appendEvent({ id, ts: this.services.clock.now(), kind, turn: writer.turn, data });
        const record: Published = { kind, id, turn: stored.turn, data: data as unknown as Record<string, unknown> };
        sink.events.push(record);
        this.events.push(record);
      },
      signal: <K extends SignalKind>(kind: K, data: SignalPayloads[K]) => {
        const record: Signalled = { kind, data: data as unknown as Record<string, unknown> };
        sink.signals.push(record);
        this.signals.push(record);
      },
      moduleWorker: () => options.worker ?? null,
      loreWorker: () => {
        if (options.loreWorker === undefined) throw new Error("no lore worker in this test");
        return options.loreWorker;
      },
      reviewNarrative: options.reviewNarrative ?? PASS,
      reviewFact: options.reviewFact ?? PASS,
    };
  }

  /** Accept a player's line (or open a facts turn) and run the Keeper's turn for it. */
  async turn(text: string, options: TurnOptions = {}): Promise<Ran> {
    const writer = this.store.beginTurn(ROOM);
    const work = options.work ?? "action";
    const speaker = options.speaker ?? "Ada";
    let action = `facts-${writer.turn}`;
    if (work === "action") {
      action = this.services.clock.id();
      writer.appendEvent({ id: action, ts: this.services.clock.now(), kind: "narrative", turn: writer.turn, data: { speaker: "player", name: speaker, text, format: "plain" } });
    }
    return this.run(writer, { work, action, text: work === "action" ? text : "", speaker, ...(options.signal === undefined ? {} : { signal: options.signal }) }, options);
  }

  async run(writer: RoomWriter, input: TurnInput, options: TurnOptions = {}): Promise<Ran> {
    const sink = { events: [] as Published[], signals: [] as Signalled[] };
    const context = this.context(writer, options);
    const result = await runKeeperTurn(context, input, this.ports(writer, options, sink), { ...this.env, settings: this.settings });
    return { result, writer, context, events: sink.events, signals: sink.signals };
  }

  /** Every payload this harness's ports carried, as one JSON text (for leak checks). */
  wire(): string {
    return JSON.stringify([this.events, this.signals]);
  }
}

/** The text of every message of a request, joined. */
export function promptText(messages: readonly ChatMessage[]): string {
  return messages.map((message) => message.content).join("\n\n");
}

/** A fake room worker answering from functions; unset exchanges answer as a worker with no listener would. */
export interface FakeModule {
  readonly id: string;
  readonly events?: { turnStart?: boolean; toolUse?: boolean; replyPhase?: boolean };
  readonly commands?: readonly Record<string, unknown>[];
  readonly clock?: boolean;
  readonly turnStart?: (event: Record<string, unknown>) => unknown;
  readonly toolUse?: (event: Record<string, unknown>) => unknown;
  readonly replyPhase?: (event: Record<string, unknown>) => unknown;
  readonly command?: (request: Record<string, unknown>) => unknown;
}

export function fakeWorker(module: FakeModule): RoomWorker {
  const descriptions = [
    {
      id: module.id,
      events: { turnStart: false, toolUse: false, replyPhase: false, ...module.events },
      commands: module.commands ?? [],
      views: [],
      clock: module.clock ?? false,
      characters: false,
    },
  ];
  const fake = {
    descriptions,
    describe: async () => descriptions,
    turnStart: async (event: Record<string, unknown>) => module.turnStart?.(event) ?? { effects: [] },
    toolUse: async (event: Record<string, unknown>) => module.toolUse?.(event) ?? { effects: [] },
    replyPhase: async (event: Record<string, unknown>) => module.replyPhase?.(event) ?? { effects: [] },
    command: async (request: Record<string, unknown>) => module.command?.(request) ?? { outcome: { status: "failed" } },
  };
  return fake as unknown as RoomWorker;
}

/** A fake lore worker. */
export function fakeLoreWorker(answer: (request: Record<string, unknown>) => unknown): RoomWorker {
  return { assembleLore: async (request: Record<string, unknown>) => answer(request) } as unknown as RoomWorker;
}

export function fact(module: string, text: string, to: "table" | "keeper", narrateNow = false): Record<string, unknown> {
  return { module, kind: "fact", text, to, importance: "normal", narrateNow };
}
