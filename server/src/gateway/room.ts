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
// - A command that waits on the NETWORK first (`pack install` fetching an archive,
//   `spec.unlocked`) does not wait for the lock either: the fetch would hold up every line
//   behind it. Its handler still writes in one synchronous transaction once the fetch is
//   done, and the worker reload it asks for queues behind the lock like everything else.
//
// After a Keeper turn, still under the lock (§12 3.2 step 14): usage is recorded, the module
// views are rendered for the viewers subscribed to one, views are refreshed, `idle` is sent;
// the Scribe pass is scheduled on the room's ordered chain with the turn's own context; and
// when a module asked for narration now (decision 35), ONE facts turn runs before the lock
// is released. Nothing under the lock ever waits for the chain.
import type { EventKind, EventPayloads, EventFrame, MediaData, Role, ServerFrame, SignalFrame, SignalKind, SignalPayloads, ViewFrame, ViewListing } from "loreweaver-protocol/v3";
import type { RoomMember, Who } from "loreweaver/module";

import type { RoomContext, Services } from "../agent/context.ts";
import { decideNarrateNow, NARRATE_NOW, narrateNowEnabled, type TextReview } from "../agent/effects.ts";
import type { DirectorImageDeps } from "../agent/lanes/director.ts";
import { readDirectorImageState } from "../agent/lanes/director.ts";
import type { RoomKit } from "../agent/lanes/presentation.ts";
import { readScribeSnapshot } from "../agent/lanes/scribe.ts";
import { type ClockInfo, describeModules, dispatchRender } from "../agent/modules.ts";
import type { ModuleCharacter } from "../core/characters/index.ts";
import type { TurnEnvironment, TurnInput, TurnPorts, TurnResult } from "../agent/turn/types.ts";
import { SeededRandom } from "../core/random.ts";
import type { RulePack } from "../core/rulepacks/index.ts";
import { liftsOutputFilter, readEnabledSkills } from "../core/skills/index.ts";
import { t, translate } from "../infra/i18n.ts";
import { StaleGeneration } from "../infra/lifecycle/errors.ts";
import type { MediaRecord } from "../infra/media/index.ts";
import { Mutex } from "../infra/mutex.ts";
import type { RoomWorker } from "../infra/room_worker.ts";
import type { RoomMeta, RoomWriter, StoredEvent } from "../infra/store.ts";
import type { OrderedChains } from "./chain.ts";
import {
  COMMANDS_CATALOG,
  type CommandEvent,
  type KeyBook,
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
import type { ModelSettings } from "./model_settings.ts";
import { eventIdOf, moduleRoom, roomMembers } from "./module_commands.ts";
import type { RateLimiter } from "./rate_limit.ts";
import { type ReviewFilter, reviewFact, reviewNarrative } from "./review.ts";
import type { RoomPacks } from "./packs.ts";
import { addUpload, uploadFits } from "./audio.ts";
import { mediaData, type UploadOffer, type Uploads } from "./uploads.ts";
import {
  BUILT_IN_VIEWS,
  type Delivery,
  listedModuleViews,
  mergeModuleViews,
  type ModuleViewRequest,
  type ModuleViewSet,
  viewRefs,
  whoOf,
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
  /**
   * End this connection without ending the member's session for good: the client comes
   * back as after any dropped link. Used when the room was REPLACED under it (an import).
   */
  disconnect?(): void;
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
  /** Asked at each pass: an admin may switch image generation on, off or over at run time. */
  readonly images: (room: string) => DirectorImageDeps | null;
  readonly limiter: RateLimiter;
  readonly chains: OrderedChains;
  /** Members' files (the byte channel's gateway side); null on a server without a media store. */
  readonly uploads: Uploads | null;
  /** The installed packs (the `packs` view). */
  readonly packs: RoomPacks;
  /** The model lanes at run time; null: `services.models` for ever. */
  readonly models: ModelSettings | null;
  /** The access keys (`admin/keys`); null on a server without them. */
  readonly keys: KeyBook | null;
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
      // What the table saw, whole: the Keeper must know WHAT a player rolled for and how it
      // came out (who won a contest, what a sanity roll cost), or it narrates past the dice.
      const dice = event.data;
      if (dice.text !== undefined && dice.text !== "") lines.push(`${dice.actor}: ${dice.text}`);
      else {
        const what = dice.label === undefined || dice.label === "" ? "" : `${dice.label} `;
        const against = dice.target === undefined ? "" : ` vs ${dice.effectiveTarget ?? dice.target}`;
        const outcome = dice.outcome === undefined ? "" : ` (${dice.outcome.label})`;
        lines.push(`${dice.actor}: ${what}${dice.expr} = ${dice.total}${against}${outcome}`);
      }
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
  /**
   * The characters the modules offered at the last render, kept beside the module views and
   * the clock: what a seat on a module's character shows (`core/characters/module_characters.ts`).
   */
  #moduleCharacters: readonly ModuleCharacter[] = [];
  /** The player action each command context was made for (the module seam reads it). */
  readonly #actions = new WeakMap<RoomContext, string>();
  /** Turns in flight: aborted when the room's generation moves under them. */
  readonly #inFlight = new Set<AbortController>();
  /** Lines accepted whose Keeper turn has not started yet. */
  #waiting = 0;
  /** Whose line the Keeper is answering right now; null between turns. */
  #answering: string | null = null;
  /** The services and turn environment on the model snapshot of a version (see `#servicesNow`). */
  #pinned: { readonly version: number; readonly services: Services } | null = null;
  /** The turn environment that goes with each pinned services object (the Keeper model's context window). */
  readonly #envs = new WeakMap<Services, TurnEnvironment>();

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

  /**
   * A module command step's events, on the table now: turn-less, through the command's writer,
   * as a command's events are. False when the room moved on meanwhile.
   */
  publishCommandEvents(context: RoomContext, events: readonly CommandEvent[]): boolean {
    const clock = this.#host.services.clock;
    try {
      for (const event of events) this.#publish(context.writer, event.kind, eventIdOf(event) ?? clock.id(), event.data, false);
    } catch (error) {
      if (error instanceof StaleGeneration) return false;
      throw error;
    }
    return true;
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

  /** The oldest event number the log still holds; 0 when it is empty. */
  get first(): number {
    return this.#host.services.store.firstSeq(this.id);
  }

  /** Whose line the Keeper is answering right now, or null: what a member joining mid-turn is told. */
  get answering(): string | null {
    return this.#answering;
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

  /** The member ids connected now. */
  onlineIds(): ReadonlySet<string> {
    return new Set([...this.#members.values()].map((member) => member.id));
  }

  /** End the live connections of these members (a revoked key, a changed role) and take them out of the room. */
  #disconnect(ids: readonly string[]): void {
    const doomed = new Set(ids);
    for (const member of [...this.#members.values()]) {
      if (!doomed.has(member.id)) continue;
      member.disconnect?.();
      this.leave(member);
    }
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
    // A `module/command` word, or a word a module's text form takes, is a module command,
    // which only the dispatcher runs; it resolves the line under the lock (speech after all
    // when no module takes it).
    const id = parsed?.id ?? (registry.mayBeModuleText(probe, text) ? (splitCommand(text)?.word ?? null) : null);
    if (id === null) {
      const accepted = this.#accept(member, text, reply);
      if (accepted !== null) this.#queueTurn(accepted);
      return;
    }
    this.#dispatch(member, id, parsed?.args ?? {}, (context) => registry.input(context, text, member.locale), reply, parsed !== null);
  }

  /** `command.run {id, args}` from `member`. */
  run(member: Member, id: string, args: unknown, reply: Reply): void {
    if (!this.#host.limiter.allow(member.id)) {
      reply({ ok: false, code: "rate_limited" });
      return;
    }
    const hint = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Readonly<Record<string, unknown>>) : {};
    this.#dispatch(member, id, hint, async (context) => ({ kind: "command", id, outcome: await this.#host.registry.run(context, id, args, member.locale) }), reply);
  }

  /**
   * A command queues behind the room's lock — except a lifecycle command, and a command
   * that waits on the network for these arguments (`spec.unlocked`: `pack install`), which
   * run at once so the room goes on taking input. `args` is only that hint: the registry
   * validates the arguments as for any command.
   */
  #dispatch(member: Member, id: string, args: Readonly<Record<string, unknown>>, execute: (context: RoomContext) => Promise<InputOutcome>, reply: Reply, known = true): void {
    const probe = this.#context(member, this.#host.services.store.writer(this.id), "probe");
    // A module's word is no engine command, even when it spells an engine command's id.
    const spec = known ? this.#host.registry.spec(probe, id) : undefined;
    const unlocked = spec?.lifecycle === true || spec?.unlocked?.(args) === true;
    const job = (): Promise<void> => this.#command(member, id, execute, reply, !unlocked);
    if (unlocked) void job();
    else void this.#lock.run(job);
  }

  /**
   * The room's modules changed under it (a pack it enabled was installed again): module views
   * from scratch and the worker reloaded, queued behind any turn in flight, then the room's
   * pack media registered again and the views refreshed.
   */
  reloadModules(): void {
    void this.#lock.run(async () => {
      this.#moduleViews = null;
      this.#moduleClock = null;
      this.#moduleCharacters = [];
      this.#host.reloadWorker(this.id);
      await this.#host.packs.registerAssets(this.id, this.#host.services.store);
      await this.refreshViews();
    });
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

  /** Queue an accepted line's Keeper turn behind the lock. */
  #queueTurn(accepted: Accepted): void {
    this.#waiting++;
    void this.#lock.run(() => {
      this.#waiting--;
      return this.#turnFor(accepted);
    });
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
      else this.#queueTurn(accepted);
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
      // After the answer, so the admin who imported hears that it worked before the link goes.
      if (outcome.lifecycle.kind === "import") for (const each of [...this.#members.values()]) each.disconnect?.();
      return;
    }
    const published = this.#publishOutcome(writer, outcome);
    if (published && outcome.modulesChanged === true) {
      // Other modules now: a fresh worker with the new list, and module views from scratch.
      // A command run outside the lock never swaps the worker under a turn in flight: the
      // swap queues behind it.
      const swap = (): void => {
        this.#moduleViews = null;
        this.#moduleClock = null;
        this.#moduleCharacters = [];
        this.#host.reloadWorker(this.id);
      };
      if (locked) swap();
      else void this.#lock.run(() => Promise.resolve(swap()));
    }
    // What the command could only finish by waiting (indexing new lore for recall), after its
    // writes committed and its events went out; its lines join the caller's answer.
    const more = published && outcome.after !== undefined ? await this.#after(id, outcome.after) : [];
    reply(this.#answer(outcome, more));
    // After the answer, so the admin hears that it worked before a link goes (their own, too).
    if (published && outcome.disconnect !== undefined) this.#disconnect(outcome.disconnect);
    if (published && outcome.events.length > 0) {
      try {
        const recorded = this.#host.recordPlayerAction(context, { actor: actorName(context), action: input.id ?? id, text: tableText(outcome.events) });
        if (!recorded.ok) this.#report(`player action ${id} not recorded: ${recorded.code}`);
      } catch (error) {
        if (!(error instanceof StaleGeneration)) throw error;
      }
    }
    // A command may have changed what a module view shows — the module's own state, a variable,
    // a character — so the module views are rendered again for whoever watches one, and the
    // modules' characters read again (a seat, a resource); without this a panel stayed as it
    // was until the next Keeper turn. Once per command, however many steps it ran. (With no
    // rendering yet, the refresh below makes the first one.)
    if (published && this.#moduleViews !== null && (this.views.moduleRequests().length > 0 || (await this.#offersCharacters()))) await this.#renderModules();
    await this.refreshViews();
    if (locked && published) await this.#maybeNarrateNow(context, action, actorName(context));
  }

  /**
   * Publish a command's events (turn-less) and signals; false when the room moved on meanwhile.
   * Events a module command's steps already published (`published`) are not sent again.
   */
  #publishOutcome(writer: RoomWriter, outcome: Extract<CommandOutcome, { ok: true }>): boolean {
    const clock = this.#host.services.clock;
    if (outcome.published === true && !writer.current()) return false;
    try {
      for (const event of outcome.published === true ? [] : outcome.events) this.#publish(writer, event.kind, eventIdOf(event) ?? clock.id(), event.data, false);
    } catch (error) {
      if (error instanceof StaleGeneration) return false;
      throw error;
    }
    for (const signal of outcome.signals) this.#broadcast({ type: "signal", kind: signal.kind, data: signal.data } as SignalFrame);
    return true;
  }

  async #after(id: string, after: () => Promise<readonly string[]>): Promise<readonly string[]> {
    try {
      return await after();
    } catch (error) {
      this.#report(`command ${id}: the step after it failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  #answer(outcome: Extract<CommandOutcome, { ok: true }>, more: readonly string[] = []): Answer {
    const answer: { ok: true; text?: string; data?: unknown } = { ok: true };
    const lines = [...(outcome.text === undefined ? [] : [outcome.text]), ...more];
    if (lines.length > 0) answer.text = lines.join("\n");
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
    this.#publishOutcome(fresh, outcome);
    this.#moduleViews = null;
    this.#moduleClock = null;
    this.#moduleCharacters = [];
    this.#host.reloadWorker(this.id);
    if (lifecycle.kind === "import") {
      // The room was REPLACED: another log, another numbering. No event can say that to a
      // client holding the old one (an appended `reset` would follow the imported history
      // and clear it). Each member's connection is ended instead, and they come back as
      // after any dropped link: the welcome's new generation makes the client discard what
      // it held, and the replay hands it the room as it is now. (The caller does it, after
      // answering the admin who asked.)
      return;
    }
    await this.refreshViews();
  }

  // --- a Keeper turn and what follows it ----------------------------------------------

  async #keeperTurn(context: RoomContext, input: Omit<TurnInput, "signal">, decide = true): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    // The engine sends `busy` itself as its first step (one per turn, not two); the room
    // remembers who is being answered, for a member who connects mid-turn.
    this.#answering = input.speaker;
    let result: TurnResult;
    try {
      const env = this.#envs.get(context.services) ?? this.#host.env;
      result = await runAsWork(context.writer, () => this.#host.runTurn(context, { ...input, signal: controller.signal }, this.#ports(context), env));
    } catch (error) {
      if (error instanceof StaleGeneration) result = staleResult();
      else {
        this.#report(`turn ${context.turn} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.#signal(context.writer, "notice", { level: "warn", code: "turn_failed", text: t(context.locale, "net.notice.turn_failed") });
        result = { ...staleResult(), status: "failed", code: "turn_failed" };
      }
    } finally {
      this.#inFlight.delete(controller);
      this.#answering = null;
    }
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
    // "Now" means "without waiting for the next player action". When a line is already
    // waiting for the lock, its turn is next and reads the same pending facts: an extra turn
    // would only run ahead of a line that was accepted — and numbered — before it.
    if (this.#waiting > 0) return;
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
      members: () => this.members(),
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
    const vetoRoom = moduleRoom(services, this.id, context.turn, this.#moduleClock, this.members());
    void host.chains.schedule(this.id, async () => {
      // Pictures are on when the operator allows them AND an image client exists right now.
      const images = host.images(this.id);
      const lanes = images === null && host.lanes.directorSettings.imagesEnabled ? { ...host.lanes, directorSettings: { ...host.lanes.directorSettings, imagesEnabled: false } } : host.lanes;
      await runLanePass(
        { context, scribe, player: input.text, reply, vetoRoom, director },
        {
          settings: lanes,
          images,
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

  // --- files (the byte channel) ------------------------------------------------------
  //
  // A transfer never takes the room's lock and runs no content code. A finished share is
  // published at once, turn-less, the way a command's events are: its place in the log is
  // decided when it is appended, like every other event's.

  /**
   * `media.offer`: the call's answer. A share of bytes the room already holds is announced
   * again; an audio upload of bytes it holds goes into the library at once.
   */
  offerUpload(member: Member, offer: UploadOffer): Answer {
    const uploads = this.#host.uploads;
    if (uploads === null) return { ok: false, code: "media_unavailable" };
    // A full library refuses before any bytes travel (a player is refused for who they are first).
    if (offer.purpose === "audio" && member.role === "admin" && !uploadFits(this.#host.services.store, this.id, offer.sha256)) return { ok: false, code: "audio_library_full" };
    const outcome = uploads.offer(this.id, { id: member.id, role: member.role }, offer);
    if (!outcome.ok) return { ok: false, code: outcome.code };
    if (outcome.kind === "upload") return { ok: true, data: { upload_id: outcome.uploadId } };
    if (outcome.share) this.#shareMedia(member, outcome.record);
    if (outcome.audio) {
      const refused = this.#addAudio(member, outcome.record);
      if (refused !== null) return { ok: false, code: refused };
    }
    return { ok: true, data: { existing: mediaData(outcome.record) } };
  }

  /** The size `member`'s accepted offer promised, or undefined when `uploadId` is not theirs and waiting. */
  uploadSize(member: Member, uploadId: string): number | undefined {
    return this.#host.uploads?.pendingSize(member, uploadId);
  }

  /** The bytes of `uploadId` did not arrive whole: the offer is used up. */
  abandonUpload(member: Member, uploadId: string): void {
    this.#host.uploads?.abandon(member, uploadId);
  }

  /** The bytes of an accepted offer: stored by the media store, then announced when it is a share. */
  async receiveUpload(member: Member, uploadId: string, bytes: Uint8Array): Promise<{ readonly ok: true; readonly record: MediaRecord } | { readonly ok: false; readonly code: string }> {
    const uploads = this.#host.uploads;
    if (uploads === null) return { ok: false, code: "media_unavailable" };
    const received = await uploads.receive(this.id, member, uploadId, bytes);
    if (!received.ok) return received;
    if (received.share) this.#shareMedia(member, received.record);
    if (received.audio) {
      const refused = this.#addAudio(member, received.record);
      if (refused !== null) {
        // Another upload filled the library while these bytes travelled: they are not kept,
        // unless an enabled pack ships the same file.
        if (!this.#host.packs.shipsBytes(this.#host.services.store, this.id, received.record.hash)) uploads.media.remove(this.id, received.record.hash);
        return { ok: false, code: refused };
      }
    }
    return { ok: true, record: received.record };
  }

  /** Put an admin's uploaded sound into the room's audio library; the refusal code, or null. */
  #addAudio(member: Member, record: MediaRecord): string | null {
    const { store, clock } = this.#host.services;
    const writer = store.writer(this.id);
    try {
      const added = store.transaction(() => addUpload(writer, store, record, member.id, clock.now()));
      if (added === "full") return "audio_library_full";
    } catch (error) {
      // The room moved to another generation meanwhile (a reset or an import cleared its media too).
      if (error instanceof StaleGeneration) return "media_unknown_upload";
      throw error;
    }
    void this.refreshViews();
    return null;
  }

  /** A fetch by `member`: only what the room holds under an audience their role may see. */
  async fetchMedia(member: Member, hash: string): Promise<{ readonly record: MediaRecord; readonly bytes: Uint8Array } | undefined> {
    return (await this.#host.uploads?.read(this.id, member.role, hash)) ?? undefined;
  }

  /** The table sees a member's file arrive: a turn-less `media` event, and the Keeper hears of it. */
  #shareMedia(member: Member, record: MediaRecord): void {
    const { store, clock } = this.#host.services;
    const writer = store.writer(this.id);
    const data: MediaData = { ...mediaData(record), from: member.id };
    try {
      this.#publish(writer, "media", clock.id(), data, false);
      const context = this.#context(member, writer, `media:${record.hash}`);
      const recorded = this.#host.recordPlayerAction(context, { actor: actorName(context), action: "media", text: tableText([{ kind: "media", data }]) });
      if (!recorded.ok) this.#report(`shared file not recorded: ${recorded.code}`);
    } catch (error) {
      // The room moved to another generation meanwhile: the share is stored, the table was cleared.
      if (!(error instanceof StaleGeneration)) throw error;
    }
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
        if (viewer !== null) await this.#renderModules([{ viewer, views: [name] }]);
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
    return viewerContext(this.#host.services, this.id, { id: member.id, name: member.name, role: member.role }, member.locale, this.#moduleCharacters);
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
      moduleCharacters: this.#moduleCharacters,
      uploads: host.uploads?.enabled(this.id) ?? false,
      packs: host.packs,
      media: host.uploads?.media ?? null,
      admin: { models: host.models, keys: host.keys },
      keeperContext: this.#keeperContext(),
    };
    return { source, modules: await this.#modules(), at: this.meta.head };
  }

  /**
   * Every member of the room — every key of it, connected or not — sorted by id, so a module
   * call made over the same room state carries the same list. The cap is applied (and
   * reported) where a call is sent (`boundedSnapshot`).
   */
  members(): readonly RoomMember[] {
    return roomMembers(this.#host.keys, this.id);
  }

  /**
   * The module views as last rendered or, before any render, as the modules list them: the
   * listing comes from the load-time description and needs no render. When a module keeps
   * the clock, its first reading is taken then — a render that reads no view — so the `scene`
   * view shows it before any turn has run.
   */
  async #modules(): Promise<ModuleViewSet> {
    if (this.#moduleViews !== null) return this.#moduleViews;
    const worker = this.#host.moduleWorker(this.id);
    if (worker === null) return NO_MODULE_VIEWS;
    const described = await describeModules(worker);
    for (const problem of described.problems) this.#report(problem);
    // The clock and the characters are read by a render too: a seat shows its character's name and resources.
    if (this.views.moduleRequests().length > 0 || described.modules.some((module) => module.clock || module.characters)) {
      await this.#renderModules();
      if (this.#moduleViews !== null) return this.#moduleViews;
    }
    const listed = listedModuleViews(described.modules);
    this.#moduleViews = listed;
    return listed;
  }

  /** Whether a loaded module offers characters (its `characters()` is read at every render). */
  async #offersCharacters(): Promise<boolean> {
    const worker = this.#host.moduleWorker(this.id);
    if (worker === null) return false;
    return (await describeModules(worker)).modules.some((module) => module.characters);
  }

  /**
   * Render the module views each viewer subscribed to (and `extra`'s): one read-only
   * exchange, which computes nothing else of the views. It also reads the clock a module keeps.
   */
  async #renderModules(extra: readonly ModuleViewRequest[] = []): Promise<void> {
    const worker = this.#host.moduleWorker(this.id);
    if (worker === null) return;
    const requests = new Map<string, { viewer: ViewerContext; views: Set<string> }>();
    for (const request of [...this.views.moduleRequests(), ...extra]) {
      const key = viewerKey(request.viewer);
      const entry = requests.get(key) ?? { viewer: request.viewer, views: new Set<string>() };
      requests.set(key, entry);
      for (const name of request.views) entry.views.add(name);
    }
    const viewers = [...requests.values()];
    const described = await describeModules(worker);
    const room = moduleRoom(this.#host.services, this.id, this.meta.turn, this.#moduleClock, this.members());
    const outcome = await dispatchRender(
      worker,
      viewers.map((entry) => ({ who: whoOf(entry.viewer), views: viewRefs([...entry.views]) })),
      room,
    );
    for (const problem of [...described.problems, ...outcome.problems]) this.#report(problem);
    this.#moduleClock = outcome.clock;
    this.#moduleCharacters = outcome.characters;
    const merged = mergeModuleViews(
      outcome,
      viewers.map((entry) => entry.viewer),
      described.modules,
    );
    for (const problem of merged.problems) this.#report(problem);
    this.#moduleViews = merged;
  }

  // --- contexts -----------------------------------------------------------------------

  #who(member: Member): Who {
    return whoIn(this.#host.services, this.id, { id: member.id, name: member.name, role: member.role }, this.locale, this.#moduleCharacters);
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
    const services = this.#servicesNow();
    const pack = this.pack;
    const stored = store.stateGet(this.id, ROOM_RULE_VARIANT);
    // A ladder the system does not declare grades by the default, as `rule` says.
    const variant = stored !== null && pack?.resolution?.variants.has(stored) === true ? stored : null;
    return {
      services,
      room: this.id,
      turn: writer.turn,
      writer,
      locale: this.locale,
      pack,
      variant,
      who,
      random: new SeededRandom(`${this.id}:${writer.epoch}:${writer.turn}:${input}`),
      moduleCharacters: this.#moduleCharacters,
    };
  }

  /**
   * The services a new piece of work gets: the server's, with the model clients of the
   * snapshot current NOW. The work keeps them to its end — a turn in flight when an admin
   * switches the model finishes on the clients it started with, its NPC calls, fold and
   * Scribe pass included (they all reach the model through this context) — and the next
   * context is made on the new snapshot. One object per snapshot version, so contexts made
   * on the same version share it.
   */
  #servicesNow(): Services {
    const models = this.#host.models;
    if (models === null) return this.#host.services;
    const snapshot = models.snapshot();
    if (this.#pinned?.version === snapshot.version) return this.#pinned.services;
    const services: Services = { ...this.#host.services, models: snapshot.models };
    const env = this.#host.env;
    this.#envs.set(services, { ...env, settings: { ...env.settings, contextWindow: snapshot.contextWindow } });
    this.#pinned = { version: snapshot.version, services };
    return services;
  }

  /**
   * The Keeper model's context window as the room's next piece of work will take it: the
   * current model snapshot's (`#servicesNow`), or the server's setting when models do not
   * change at run time (the operator gave that window, so it counts as known).
   */
  #keeperContext(): { readonly window: number; readonly known: boolean } {
    const models = this.#host.models;
    if (models === null) return { window: this.#host.env.settings.contextWindow, known: true };
    const snapshot = models.snapshot();
    return { window: snapshot.contextWindow, known: snapshot.contextWindowKnown };
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
