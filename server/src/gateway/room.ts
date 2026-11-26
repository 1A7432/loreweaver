// A room: its members, its log, the lock that makes it do one thing at a time, and what
// happens around a Keeper turn.
//
// Two entrances (protocol 3.0 §8.3): `input` (a typed line: speech or a text command) and
// `run` (`command.run`). Each answers its caller exactly once, through the `Reply` it was
// handed.
//
// - SPEECH is accepted at once, synchronously: the turn is begun (`store.beginTurn`), the
//   line's `narrative` event and its inline rolls' `dice` events are published under that
//   turn, the caller is answered — and only then does the Keeper turn queue behind the
//   room's lock. The turn number is allocated when the line is ACCEPTED, so the line, its
//   reply and an undo of the turn all agree on it (§12 ruling 1).
// - A COMMAND queues behind the same lock, in arrival order with speech, and opens no turn:
//   it writes through a writer of the room's latest turn (undoing that turn takes the
//   command back). Its events go to the table, its answer to the caller alone.
// - A ROOM-LIFECYCLE command (undo, reset, import) does not wait for the lock. It is one
//   synchronous store operation that moves the room's generation; a turn suspended at a
//   model call, a queued line, a Scribe pass still computing — all of them hold writers of
//   the old generation and fail to commit by themselves (§11.5). Waiting for the lock would
//   let an admin's undo sit behind a five-minute turn it is meant to cancel.
//
// After a Keeper turn, still under the lock (§12 3.2 step 14): usage is recorded, the module
// views are rendered for the viewers subscribed to one, views are refreshed, `idle` is sent;
// the Scribe pass is scheduled on the room's ordered chain with the turn's own context; and
// when a module asked for narration now (decision 35), ONE facts turn runs before the lock
// is released. Nothing under the lock ever waits for the chain.
import type { EventKind, EventPayloads, EventFrame, Role, ServerFrame, SignalFrame, SignalKind, SignalPayloads, ViewFrame, ViewListing } from "loreweaver-protocol/v3";
import type { Who } from "loreweaver/module";

import type { RoomContext, Services } from "../agent/context.ts";
import { decideNarrateNow, NARRATE_NOW, narrateNowEnabled, type TextReview } from "../agent/effects.ts";
import type { DirectorImageDeps } from "../agent/lanes/director.ts";
import { readDirectorImageState } from "../agent/lanes/director.ts";
import type { RoomKit } from "../agent/lanes/presentation.ts";
import { readScribeSnapshot } from "../agent/lanes/scribe.ts";
import { type ClockInfo, describeModules, dispatchRender } from "../agent/modules.ts";
import type { TurnEnvironment, TurnInput, TurnPorts, TurnResult } from "../agent/turn/types.ts";
import { SeededRandom } from "../core/random.ts";
import type { RulePack } from "../core/rulepacks/index.ts";
import { liftsOutputFilter, readEnabledSkills } from "../core/skills/index.ts";
import { t, translate } from "../infra/i18n.ts";
import { StaleGeneration } from "../infra/lifecycle/errors.ts";
import { Mutex } from "../infra/mutex.ts";
import type { RoomWorker } from "../infra/room_worker.ts";
import type { RoomMeta, RoomWriter, StoredEvent } from "../infra/store.ts";
import type { OrderedChains } from "./chain.ts";
import {
  COMMANDS_CATALOG,
  type CommandEvent,
  type CommandOutcome,
  type CommandRegistry,
  type InputOutcome,
  inlineRolls,
  KEEPER_MUTED,
  MAX_INLINE_ROLLS,
  ROOM_LOCALE,
  ROOM_RULE_PACK,
  ROOM_RULE_VARIANT,
  splitCommand,
  whoIn,
} from "./commands/index.ts";
import { rollInline } from "./commands/engine/dice.ts";
import { actorName } from "./commands/support.ts";
import type { CommandCall } from "./commands/types.ts";
import { type RecordPlayerAction, type RunKeeperTurn, runAsWork } from "./keeper.ts";
import { type LaneSettings, runLanePass } from "./lanes.ts";
import { eventIdOf, moduleRoom } from "./module_commands.ts";
import type { RateLimiter } from "./rate_limit.ts";
import { type ReviewFilter, reviewFact, reviewNarrative } from "./review.ts";
import {
  BUILT_IN_VIEWS,
  type Delivery,
  listedModuleViews,
  mergeModuleViews,
  type ModuleViewSet,
  NO_MODULE_VIEWS,
  type OnlineMember,
  recordUsage,
  RoomViews,
  type ViewerContext,
  viewerContext,
  type ViewInputs,
  viewerKey,
  type ViewProblem,
  type ViewSource,
  whoOf,
} from "./views/index.ts";

/** One connection in a room. A person with two connections is two members with one `id`. */
export interface Member {
  /** This connection's own id, unique on the server. */
  readonly connection: string;
  /** The member's stable id (derived from their key). */
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  /** The member's own language: results and views addressed to them are in it. */
  readonly locale: string;
  send(frame: ServerFrame): void;
}

/**
 * The one answer to an input or a call. A refusal carries a stable code; its `message`, when
 * present, is already in the caller's language (a command's), otherwise the session words
 * the code from its catalog.
 */
export type Answer = { readonly ok: true; readonly text?: string; readonly data?: unknown } | { readonly ok: false; readonly code: string; readonly message?: string };

export type Reply = (answer: Answer) => void;

/** What a room is given by its hub: the server's services and the room's own worker. */
export interface RoomHost {
  readonly services: Services;
  readonly env: TurnEnvironment;
  readonly registry: CommandRegistry;
  readonly runTurn: RunKeeperTurn;
  readonly recordPlayerAction: RecordPlayerAction;
  /** The language of a room that never chose one. */
  readonly defaultLocale: string;
  /** The rule system of a room that never chose one; null for none. */
  readonly defaultRulePack: string | null;
  readonly review: ReviewFilter;
  readonly lanes: LaneSettings;
  readonly images: DirectorImageDeps | null;
  readonly limiter: RateLimiter;
  readonly chains: OrderedChains;
  kitFor(room: string): RoomKit | null;
  /** The room's worker when it has modules; null otherwise. */
  moduleWorker(room: string): RoomWorker | null;
  loreWorker(room: string): RoomWorker;
  /** Start the room's worker over from the stored checkpoints (after a lifecycle operation). */
  reloadWorker(room: string): void;
}

export function eventFrame(event: StoredEvent): EventFrame {
  const frame = { type: "event", seq: event.seq, id: event.id, ts: event.ts, kind: event.kind, data: event.data };
  return (event.turn === undefined ? frame : { ...frame, turn: event.turn }) as EventFrame;
}

/** What a command's events looked like at the table, for the Keeper's next prompt. */
export function tableText(events: readonly CommandEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.kind === "narrative") lines.push(event.data.text);
    else if (event.kind === "dice") {
      const label = event.data.outcome === undefined ? "" : ` (${event.data.outcome.label})`;
      lines.push(`${event.data.actor}: ${event.data.expr} = ${event.data.total}${label}`);
    } else if (event.kind === "media") lines.push(event.data.name);
  }
  return lines.join("\n");
}

const BUILT_IN_NAMES: ReadonlySet<string> = new Set(BUILT_IN_VIEWS.map((view) => view.name));

function staleResult(): TurnResult {
  return { status: "stale", reply: null, replyId: null, usage: { inputTokens: 0, outputTokens: 0 }, usageEstimated: false, toolsCalled: [], contentWrites: new Set(), keeperRecordedChronicle: false, narrateNowRequested: false, problems: [] };
}

/** A line accepted for a Keeper turn. */
interface Accepted {
  readonly member: Member;
  readonly writer: RoomWriter;
  /** The line's event id: the player action the turn answers. */
  readonly action: string;
  readonly text: string;
}

export class Room {
  readonly id: string;
  readonly #host: RoomHost;
  readonly #members = new Map<string, Member>();
  readonly #lock = new Mutex();
  /** View refreshes, one at a time: a slower earlier one must never overwrite a newer value. */
  readonly #viewQueue = new Mutex();
  readonly views = new RoomViews();
  /** The module views of the last render; null until described (and after a lifecycle operation). */
  #moduleViews: ModuleViewSet | null = null;
  #moduleClock: ClockInfo | null = null;
  /** The player action each command context was made for (the module seam reads it). */
  readonly #actions = new WeakMap<RoomContext, string>();
  /** Turns in flight: aborted when the room's generation moves under them. */
  readonly #inFlight = new Set<AbortController>();

  constructor(id: string, host: RoomHost) {
    this.id = id;
    this.#host = host;
  }

  get meta(): RoomMeta {
    return this.#host.services.store.room(this.id);
  }

  /** The room's language: everything sent to the table is written in it. */
  get locale(): string {
    return this.#host.services.store.stateGet(this.id, ROOM_LOCALE) ?? this.#host.defaultLocale;
  }

  /** The room's rule system, or null. */
  get pack(): RulePack | null {
    const id = this.#host.services.store.stateGet(this.id, ROOM_RULE_PACK) ?? this.#host.defaultRulePack;
    return id === null ? null : this.#host.services.packs.get(id);
  }

  /** The clock a module keeps, from the last render. */
  get moduleClock(): ClockInfo | null {
    return this.#moduleClock;
  }

  /** The player action a command context was made for. */
  actionOf(context: RoomContext): string {
    return this.#actions.get(context) ?? `${this.id}:${context.turn}`;
  }

  /** The output review for module text bound for this room's table. */
  reviewFactFor(context: RoomContext): TextReview {
    const unfiltered = this.#unfiltered();
    return (text) => reviewFact(this.#host.review, { unfiltered }, text, context.locale);
  }

  eventsAfter(after: number, limit: number): StoredEvent[] {
    return this.#host.services.store.eventsAfter(this.id, after, limit);
  }

  eventsBefore(before: number, limit: number): StoredEvent[] {
    return this.#host.services.store.eventsBefore(this.id, before, limit);
  }

  /** Settles when everything queued so far under the lock, and every view refresh, has run (tests, shutdown). */
  async settled(): Promise<void> {
    await this.#lock.run(() => Promise.resolve());
    await this.#viewQueue.run(() => Promise.resolve());
  }

  // --- members ------------------------------------------------------------------------

  join(member: Member): void {
    this.#members.set(member.connection, member);
    this.views.open(member.connection, this.#viewerOf(member));
    // Who is online is part of `party`: everyone's views may have changed.
    void this.refreshViews();
  }

  leave(member: Member): void {
    if (!this.#members.delete(member.connection)) return;
    this.views.close(member.connection);
    void this.refreshViews();
  }

  // --- the two entrances --------------------------------------------------------------

  /** A line `member` typed. */
  input(member: Member, text: string, reply: Reply): void {
    if (!this.#host.limiter.allow(member.id)) {
      reply({ ok: false, code: "rate_limited" });
      return;
    }
    const registry = this.#host.registry;
    const probe = this.#context(member, this.#host.services.store.writer(this.id), "probe");
    const parsed = registry.textCommand(probe, text, member.locale);
    if (parsed !== null && !("id" in parsed)) {
      reply({ ok: false, code: parsed.code, message: parsed.message });
      return;
    }
    // A `module/command` word is a module command, which only the dispatcher knows.
    const id = parsed?.id ?? (splitCommand(text)?.word.includes("/") === true ? (splitCommand(text)?.word ?? null) : null);
    if (id === null) {
      const accepted = this.#accept(member, text, reply);
      if (accepted !== null) void this.#lock.run(() => this.#turnFor(accepted));
      return;
    }
    this.#dispatch(member, id, (context) => registry.input(context, text, member.locale), reply);
  }

  /** `command.run {id, args}` from `member`. */
  run(member: Member, id: string, args: unknown, reply: Reply): void {
    if (!this.#host.limiter.allow(member.id)) {
      reply({ ok: false, code: "rate_limited" });
      return;
    }
    this.#dispatch(member, id, async (context) => ({ kind: "command", id, outcome: await this.#host.registry.run(context, id, args, member.locale) }), reply);
  }

  #dispatch(member: Member, id: string, execute: (context: RoomContext) => Promise<InputOutcome>, reply: Reply): void {
    const probe = this.#context(member, this.#host.services.store.writer(this.id), "probe");
    const lifecycle = this.#host.registry.spec(probe, id)?.lifecycle === true;
    const job = (): Promise<void> => this.#command(member, id, execute, reply, !lifecycle);
    if (lifecycle) void job();
    else void this.#lock.run(job);
  }

  // --- speech -------------------------------------------------------------------------

  /** Accept a line: begin its turn, publish it and its inline rolls, answer the caller. */
  #accept(member: Member, text: string, reply: Reply): Accepted | null {
    if (member.role === "observer") {
      reply({ ok: false, code: "observer_speech" });
      return null;
    }
    const { store, clock } = this.#host.services;
    const writer = store.beginTurn(this.id);
    const action = clock.id();
    const context = this.#context(member, writer, action);
    this.#publish(writer, "narrative", action, { speaker: "player", name: actorName(context), member: member.id, text, format: "plain" }, true);
    const failures: string[] = [];
    const exprs = inlineRolls(text);
    const call = this.#call(context, member.locale);
    if (exprs.length > MAX_INLINE_ROLLS) failures.push(call.say("error.too_many_inline_rolls", { limit: MAX_INLINE_ROLLS }));
    else {
      for (const expr of exprs) {
        const rolled = rollInline(call, expr);
        if (rolled.ok) this.#publish(writer, rolled.event.kind, clock.id(), rolled.event.data, true);
        else failures.push(call.say("inline.failed", { expr: rolled.expr, code: rolled.code }));
      }
    }
    reply(failures.length === 0 ? { ok: true } : { ok: true, text: failures.join("\n") });
    return { member, writer, action, text };
  }

  /** The Keeper turn of an accepted line; runs under the lock. */
  async #turnFor(accepted: Accepted): Promise<void> {
    // Undone, reset or replaced while the line waited: there is nothing to answer.
    if (!accepted.writer.current()) return;
    if (this.#muted()) return;
    const context = this.#context(accepted.member, accepted.writer, accepted.action);
    await this.#keeperTurn(context, { work: "action", action: accepted.action, text: accepted.text, speaker: actorName(context) });
  }

  // --- commands -----------------------------------------------------------------------

  async #command(member: Member, id: string, execute: (context: RoomContext) => Promise<InputOutcome>, reply: Reply, locked: boolean): Promise<void> {
    const { store, clock } = this.#host.services;
    const writer = store.writer(this.id);
    const action = clock.id();
    const context = this.#context(member, writer, action);
    this.#actions.set(context, action);
    let input: InputOutcome;
    try {
      input = await runAsWork(writer, () => execute(context));
    } catch (error) {
      this.#report(`command ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      reply({ ok: false, code: "command_failed" });
      return;
    }
    if (input.kind === "speech") {
      // The room changed under a queued line (its rule system no longer has the word): it is
      // speech after all, accepted now, and this job already holds the lock.
      const accepted = this.#accept(member, input.text, reply);
      if (accepted === null) return;
      if (locked) await this.#turnFor(accepted);
      else void this.#lock.run(() => this.#turnFor(accepted));
      return;
    }
    const outcome = input.outcome;
    if (!outcome.ok) {
      reply({ ok: false, code: outcome.code, message: outcome.message });
      return;
    }
    if (outcome.lifecycle !== undefined) {
      await this.#afterLifecycle(outcome);
      reply(this.#answer(outcome));
      return;
    }
    const published = this.#publishOutcome(writer, outcome);
    reply(this.#answer(outcome));
    if (published && outcome.events.length > 0) {
      try {
        const recorded = this.#host.recordPlayerAction(context, { actor: actorName(context), action: input.id ?? id, text: tableText(outcome.events) });
        if (!recorded.ok) this.#report(`player action ${id} not recorded: ${recorded.code}`);
      } catch (error) {
        if (!(error instanceof StaleGeneration)) throw error;
      }
    }
    await this.refreshViews();
    if (locked && published) await this.#maybeNarrateNow(context, action, actorName(context));
  }

  /** Publish a command's events (turn-less) and signals; false when the room moved on meanwhile. */
  #publishOutcome(writer: RoomWriter, outcome: Extract<CommandOutcome, { ok: true }>): boolean {
    const clock = this.#host.services.clock;
    try {
      for (const event of outcome.events) this.#publish(writer, event.kind, eventIdOf(event) ?? clock.id(), event.data, false);
    } catch (error) {
      if (error instanceof StaleGeneration) return false;
      throw error;
    }
    for (const signal of outcome.signals) this.#broadcast({ type: "signal", kind: signal.kind, data: signal.data } as SignalFrame);
    return true;
  }

  #answer(outcome: Extract<CommandOutcome, { ok: true }>): Answer {
    const answer: { ok: true; text?: string; data?: unknown } = { ok: true };
    if (outcome.text !== undefined) answer.text = outcome.text;
    if (outcome.data !== undefined) answer.data = outcome.data;
    return answer;
  }

  /**
   * Undo, reset or import moved the room to a new generation: the command's own writer is
   * void. Its event goes out through a writer of the new generation; whatever the old
   * generation still has in flight fails to commit by itself.
   */
  async #afterLifecycle(outcome: Extract<CommandOutcome, { ok: true }>): Promise<void> {
    const lifecycle = outcome.lifecycle;
    if (lifecycle === undefined) return;
    // Model requests of turns of the old generation can stop now: nothing they produce lands.
    for (const controller of this.#inFlight) controller.abort();
    const fresh = this.#host.services.store.writer(this.id);
    const events: readonly CommandEvent[] =
      // An import announces itself as a reset of everything: the clients' copy of the log is void.
      lifecycle.kind === "import" && outcome.events.length === 0 ? [{ kind: "reset", data: { scope: "all", epoch: lifecycle.epoch } }] : outcome.events;
    this.#publishOutcome(fresh, { ...outcome, events });
    this.#moduleViews = null;
    this.#moduleClock = null;
    this.#host.reloadWorker(this.id);
    await this.refreshViews();
  }

  // --- a Keeper turn and what follows it ----------------------------------------------

  async #keeperTurn(context: RoomContext, input: Omit<TurnInput, "signal">, decide = true): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    this.#signal(context.writer, "turn", { status: "busy", actor: input.speaker });
    let result: TurnResult;
    try {
      result = await runAsWork(context.writer, () => this.#host.runTurn(context, { ...input, signal: controller.signal }, this.#ports(context), this.#host.env));
    } catch (error) {
      if (error instanceof StaleGeneration) result = staleResult();
      else {
        this.#report(`turn ${context.turn} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.#signal(context.writer, "notice", { level: "warn", code: "turn_failed", text: t(context.locale, "net.notice.turn_failed") });
        result = { ...staleResult(), status: "failed", code: "turn_failed" };
      }
    } finally {
      this.#inFlight.delete(controller);
    }
    for (const problem of result.problems) this.#report(`turn ${context.turn}: ${problem}`);
    const current = context.writer.current();
    if (current && result.status !== "stale") {
      try {
        recordUsage(context, { ...result.usage, estimated: result.usageEstimated });
      } catch (error) {
        if (!(error instanceof StaleGeneration)) throw error;
      }
    }
    await this.#renderModules();
    await this.refreshViews();
    this.#broadcast({ type: "signal", kind: "turn", data: { status: "idle" } });
    if (!context.writer.current()) return;
    if (result.status === "replied") this.#scheduleLanes(context, input, result);
    if (decide) await this.#maybeNarrateNow(context, input.action, input.speaker);
  }

  /**
   * At the end of the work for a player action: the one narrate-now turn it may open
   * (decision 35). Never from inside a facts turn; off when the room switched it off.
   */
  async #maybeNarrateNow(context: RoomContext, action: string, speaker: string): Promise<void> {
    const { store } = this.#host.services;
    if (!context.writer.current()) return;
    const stored = store.stateGet(this.id, NARRATE_NOW);
    const decision = decideNarrateNow(stored, action, narrateNowEnabled(store, this.id));
    if (decision.state !== stored) {
      if (decision.state === null) context.writer.stateDelete(NARRATE_NOW);
      else context.writer.statePut(NARRATE_NOW, decision.state);
    }
    if (!decision.open || this.#muted()) return;
    const writer = store.beginTurn(this.id);
    const facts = this.#contextFor(context.who, writer, `${action}:facts`);
    await this.#keeperTurn(facts, { work: "facts_turn", action, text: "", speaker }, false);
  }

  #ports(context: RoomContext): TurnPorts {
    const unfiltered = this.#unfiltered();
    const review = this.#host.review;
    const writer = context.writer;
    return {
      publish: <K extends EventKind>(kind: K, id: string, data: EventPayloads[K]): void => {
        this.#publish(writer, kind, id, data, true);
      },
      signal: <K extends SignalKind>(kind: K, data: SignalPayloads[K]): void => {
        this.#signal(writer, kind, data);
      },
      moduleWorker: () => this.#host.moduleWorker(this.id),
      loreWorker: () => this.#host.loreWorker(this.id),
      reviewNarrative: (text) => reviewNarrative(review, { unfiltered }, text, context.locale),
      reviewFact: (text) => reviewFact(review, { unfiltered }, text, context.locale),
    };
  }

  /** Schedule the Scribe (and maybe the Director) for a turn that replied; reads now, runs later. */
  #scheduleLanes(context: RoomContext, input: Omit<TurnInput, "signal">, result: TurnResult): void {
    const host = this.#host;
    if (!host.lanes.scribe) return;
    const { services } = context;
    const reply = result.reply ?? "";
    const scribe = readScribeSnapshot(services, this.id, context.locale, {
      player: input.text,
      reply,
      toolsCalled: result.toolsCalled,
      moduleWrites: result.contentWrites,
      keeperRecordedChronicle: result.keeperRecordedChronicle,
    });
    const kit = host.lanes.director ? host.kitFor(this.id) : null;
    const director = kit === null ? null : { kit, images: readDirectorImageState(services.store, this.id) };
    const vetoRoom = moduleRoom(services, this.id, context.turn, this.#moduleClock);
    void host.chains.schedule(this.id, async () => {
      await runLanePass(
        { context, scribe, player: input.text, reply, vetoRoom, director },
        {
          settings: host.lanes,
          images: host.images,
          moduleWorker: () => host.moduleWorker(this.id),
          refreshViews: () => this.refreshViews(),
          broadcastEvent: (event) => {
            this.#broadcast(eventFrame(event));
          },
          broadcastAudio: (audio) => {
            this.#broadcast({ type: "signal", kind: "audio", data: audio });
          },
          report: (text) => {
            this.#report(text);
          },
        },
      );
    });
  }

  // --- views --------------------------------------------------------------------------

  /** `view.list` for `member`. */
  async viewList(member: Member): Promise<ViewListing[]> {
    return this.views.list(member.connection, await this.#modules());
  }

  /** `view.subscribe`: the new values (to send after the answer) and what was refused. */
  viewSubscribe(member: Member, names: readonly string[]): Promise<Delivery> {
    return this.#viewQueue.run(async () => {
      const delivery = await this.views.subscribe(member.connection, names, await this.#inputs());
      // A module view's value comes from a render for its viewer: render, then send it.
      if (!names.some((name) => !BUILT_IN_NAMES.has(name))) return delivery;
      await this.#renderModules();
      const more = (await this.views.refresh(await this.#inputs(), [member.connection])).get(member.connection);
      return more === undefined ? delivery : { frames: [...delivery.frames, ...more.frames], problems: [...delivery.problems, ...more.problems] };
    });
  }

  /** `view.unsubscribe`: queued with every other view operation, so they apply in order. */
  viewUnsubscribe(member: Member, names: readonly string[]): Promise<string[]> {
    return this.#viewQueue.run(() => Promise.resolve(this.views.unsubscribe(member.connection, names)));
  }

  /** `view.get`: the view recomputed now. */
  viewGet(member: Member, name: string): Promise<ViewFrame | ViewProblem> {
    return this.#viewQueue.run(async () => {
      if (!BUILT_IN_NAMES.has(name)) {
        const viewer = this.views.subscriptions.viewer(member.connection);
        if (viewer !== null) await this.#renderModules([viewer]);
      }
      return this.views.get(member.connection, name, await this.#inputs());
    });
  }

  /**
   * Recompute every connection's views and send what changed. A member whose seat or
   * character changed gets their new viewer first. Queued: refreshes never overlap.
   */
  refreshViews(): Promise<void> {
    return this.#viewQueue.run(async () => {
      for (const member of this.#members.values()) {
        const viewer = this.#viewerOf(member);
        const now = this.views.subscriptions.viewer(member.connection);
        if (now === null || viewerKey(now) !== viewerKey(viewer)) this.views.setViewer(member.connection, viewer);
      }
      const deliveries = await this.views.refresh(await this.#inputs());
      for (const [connection, delivery] of deliveries) {
        const member = this.#members.get(connection);
        if (member === undefined) continue;
        for (const frame of delivery.frames) member.send(frame);
        for (const problem of delivery.problems) this.#report(`view ${problem.name}: ${problem.code}`);
      }
    });
  }

  #viewerOf(member: Member): ViewerContext {
    return viewerContext(this.#host.services, this.id, { id: member.id, name: member.name, role: member.role }, member.locale);
  }

  #online(): OnlineMember[] {
    const seen = new Map<string, OnlineMember>();
    for (const member of this.#members.values()) if (!seen.has(member.id)) seen.set(member.id, { id: member.id, name: member.name, role: member.role });
    return [...seen.values()];
  }

  async #inputs(): Promise<ViewInputs> {
    const host = this.#host;
    const source: ViewSource = {
      services: host.services,
      room: this.id,
      locale: this.locale,
      pack: this.pack,
      online: this.#online(),
      commands: { registry: host.registry, contextFor: (who) => this.#contextFor(who, host.services.store.writer(this.id), "view") },
      moduleClock: this.#moduleClock,
    };
    return { source, modules: await this.#modules(), at: this.meta.head };
  }

  /** The module views as last rendered, or as listed by the modules when none was. */
  async #modules(): Promise<ModuleViewSet> {
    if (this.#moduleViews !== null) return this.#moduleViews;
    const worker = this.#host.moduleWorker(this.id);
    if (worker === null) return NO_MODULE_VIEWS;
    const described = await describeModules(worker);
    for (const problem of described.problems) this.#report(problem);
    const listed = listedModuleViews(described.modules);
    this.#moduleViews = listed;
    return listed;
  }

  /**
   * Render the module views for the viewers subscribed to one (and `extra`): one read-only
   * exchange. It also reads the clock a module keeps.
   */
  async #renderModules(extra: readonly ViewerContext[] = []): Promise<void> {
    const worker = this.#host.moduleWorker(this.id);
    if (worker === null) return;
    const seen = new Set<string>();
    const viewers = [...this.views.moduleViewers(), ...extra].filter((viewer) => {
      const key = viewerKey(viewer);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const described = await describeModules(worker);
    const outcome = await dispatchRender(worker, viewers.map(whoOf), moduleRoom(this.#host.services, this.id, this.meta.turn, this.#moduleClock));
    for (const problem of [...described.problems, ...outcome.problems]) this.#report(problem);
    this.#moduleClock = outcome.clock;
    const merged = mergeModuleViews(outcome, viewers, described.modules);
    for (const problem of merged.problems) this.#report(problem);
    this.#moduleViews = merged;
  }

  // --- contexts -----------------------------------------------------------------------

  #who(member: Member): Who {
    return whoIn(this.#host.services, this.id, { id: member.id, name: member.name, role: member.role }, this.locale);
  }

  #context(member: Member, writer: RoomWriter, input: string): RoomContext {
    return this.#contextFor(this.#who(member), writer, input);
  }

  /**
   * One piece of work's context. The randomness is seeded from persisted values only — the
   * room, its generation, the turn, the input's id — so a replay of the same input rolls the
   * same.
   */
  #contextFor(who: Who, writer: RoomWriter, input: string): RoomContext {
    const { store } = this.#host.services;
    const pack = this.pack;
    const stored = store.stateGet(this.id, ROOM_RULE_VARIANT);
    // A ladder the system does not declare grades by the default, as `rule` says.
    const variant = stored !== null && pack?.resolution?.variants.has(stored) === true ? stored : null;
    return {
      services: this.#host.services,
      room: this.id,
      turn: writer.turn,
      writer,
      locale: this.locale,
      pack,
      variant,
      who,
      random: new SeededRandom(`${this.id}:${writer.epoch}:${writer.turn}:${input}`),
    };
  }

  #call(context: RoomContext, locale: string): CommandCall {
    return {
      context,
      locale,
      word: null,
      say: (key, params = {}) => translate(COMMANDS_CATALOG, locale, key, params),
      tell: (key, params = {}) => translate(COMMANDS_CATALOG, context.locale, key, params),
    };
  }

  #muted(): boolean {
    return this.#host.services.store.stateGet(this.id, KEEPER_MUTED) === true;
  }

  #unfiltered(): boolean {
    return liftsOutputFilter(this.#host.env.skills, readEnabledSkills(this.#host.services.store, this.id));
  }

  // --- the table ----------------------------------------------------------------------

  /** Append through `writer` (with its turn when `withTurn`), then send what was stored. */
  #publish<K extends EventKind>(writer: RoomWriter, kind: K, id: string, data: EventPayloads[K], withTurn: boolean): void {
    const draft = { id, ts: this.#host.services.clock.now(), kind, data };
    const stored = writer.appendEvent(withTurn ? { ...draft, turn: writer.turn } : draft);
    this.#broadcast(eventFrame(stored));
  }

  /** A signal for the table, unless the work sending it belongs to a past generation. */
  #signal<K extends SignalKind>(writer: RoomWriter, kind: K, data: SignalPayloads[K]): void {
    if (writer.current()) this.#broadcast({ type: "signal", kind, data } as SignalFrame);
  }

  #broadcast(frame: ServerFrame): void {
    for (const member of this.#members.values()) member.send(frame);
  }

  #report(text: string): void {
    this.#host.services.report(this.id, text);
  }
}
