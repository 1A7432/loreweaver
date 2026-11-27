// The Keeper's turn: the one function that runs a turn by calling the finished pieces in
// order (§12 3.2, steps 0–13). Step 14 — views, idle, the lock, the Scribe and the Stage
// Director, opening a narrate-now turn — is the room's, from the `TurnResult`.
//
//   0  sync   busy; the module worker
//   1  ↯W     describe the modules; `turnStart`
//   2  sync   apply its effects: variable writes, table facts (published BEFORE the reply),
//             Keeper facts to the pending list, blocks, dice, the injections record
//   3  ↯M ↯N  the routine fold (≤ 3 batches from the turn's ONE `FoldBudget`), each outcome
//             committed after re-reading, then the folded records indexed for recall
//   4  sync   the tool catalogue — once: tools and tool choice never change within a turn
//   5  ↯N     recall by meaning (embedding + vector search)
//   6  ↯W     the lore exchange
//   7  sync   commit lore (timers, template writes); read the snapshot; assemble; lay out
//   8  ↯M…    tool rounds: stream through the gate; overflow → recovery fold (same budget) →
//             rebuild from 4 with `advanceTimers: false` → ONE re-send; a tool round asks
//             the modules ONCE (↯W veto), runs the calls in the catalogue's grouping and
//             publishes their events in CALL order
//   9  ↯M…    the end-of-turn checks (≤ 5 rounds, unstreamed, the same veto)
//  10  ↯M     max rounds spent: the finalizer (no tools, no cache marks), else the fallback
//  11  sync   ONE commit block: `<UpdateVariable>` → textual tool calls stripped → review →
//             publish the `kp` narrative → clear what the prompt consumed → the meter
//  12  ↯W     `replyPhase` (the module sees the PUBLISHED reply)
//  13  sync   its effects; table facts reviewed; a narrate-now mark only recorded
//
// Suspension points are exactly the model calls, the worker exchanges and the embedding
// requests. After each one `checkpoint` re-checks the abort signal and the room's
// generation, and whatever is needed next is read again: nothing of the room (documents,
// variables, queued inputs) is held across an await. Messages, the ledger and the
// catalogue are the turn's own values.
//
// Endings: a rewound, reset or replaced room makes the writer (and `ports.publish`) throw
// `StaleGeneration` — status `stale`, nothing more written, nothing sent. The caller's
// signal — `aborted`. A provider failure never escapes: status `failed`, the draft
// discarded, a `notice`, no reply event. The whispers, pending facts and player actions
// the prompt read are cleared only in step 11, so a turn that ends any other way loses none.
import type { DiceData, NarrativeData } from "loreweaver-protocol/v3";
import type { JsonObject as ModuleJson, RollResult, VariableWrite as ModuleVariableWrite } from "loreweaver/module";
import { keeperMayRun } from "loreweaver/runner";

import { summaryThroughTurn, overflowReading } from "../../core/chronicle/index.ts";
import { DocumentRefused } from "../../core/documents/raw.ts";
import { npcDocument } from "../../core/npcs/index.ts";
import { activeSkills, readEnabledSkills, unlockedTools } from "../../core/skills/index.ts";
import { applyReplyUpdates, readVariableTree, VARIABLE_TREE_ID, VARIABLE_TREE_TYPE, variableTreeData, type VarMap } from "../../core/variables/index.ts";
import { diceRoller, type MacroContext, readVariable, substituteMacros } from "../../core/worldbook/index.ts";
import { StaleGeneration } from "../../infra/lifecycle/errors.ts";
import { type AssistantMessage, type ChatMessage, type ChatOptions, type ChatResult, LLMError, type ToolDefinition, type ToolResultMessage, withLane } from "../../infra/llm/index.ts";
import type { RoomWorker } from "../../infra/room_worker.ts";
import { readOpening } from "../card_import.ts";
import type { RoomContext } from "../context.ts";
import { applyModuleEffects, type EffectEvent, PENDING_FACTS, type PendingFact, readPendingFacts } from "../effects.ts";
import { FoldBudget, isContextOverflow, prepareFoldCommit, recoveryFold, routineFold, type FoldRequest } from "../lanes/fold.ts";
import { voiceNpc } from "../lanes/npc_actor.ts";
import { WHISPERS_KEY, type Whisper } from "../lanes/scribe.ts";
import { commitLore, loreVariables, runLoreStep } from "../lore_step.ts";
import { type Applied, describeModules, dispatchReplyPhase, dispatchToolUse, dispatchTurnStart, type ModuleInfo, runModuleCommand, type ToolVerdict } from "../modules.ts";
import { assembleKeeperPrompt, keeperMessages, moveInTurnBreakpoint, type PlayerAction } from "../prompt/index.ts";
import { indexChronicleRecords, recall } from "../recall.ts";
import {
  buildCatalog,
  type CallRequest,
  commandId,
  concurrencyGroups,
  mergeBookkeeping,
  type ModuleCommand,
  type ModuleCommandRun,
  NO_BOOKKEEPING,
  type RunCommandRequest,
  subsystemTools,
  type TableEvent,
  type ToolDeps,
  type ToolOutcome,
  TurnLedger,
  type TurnCatalog,
  type VoiceNpcRequest,
  type VoiceNpcResult,
} from "../tools/index.ts";
import { turnText } from "./catalog.ts";
import { type CheckAsk, diceToolNames, runTurnChecks, turnChecksFor, type TurnToolCall } from "./checks.ts";
import { ReplyStreamGate } from "./gate.ts";
import {
  PLAYER_ACTIONS,
  readContextReading,
  readPlayerActions,
  withoutConsumed,
  writeContextReading,
} from "./records.ts";
import {
  clockReading,
  commandLine,
  FACTS_TURN_LINE,
  keeperOwnsClock,
  moduleVariablesJson,
  OPENING_NOTE,
  readHistory,
  readKeeperSnapshot,
  readRecords,
  readSummary,
  renderPendingFacts,
  renderWhisper,
  retrievalWindow,
  storedClockText,
} from "./reader.ts";
import { type CommittedCall, failureNotice, FINALIZER_OPTIONS, finalizerMessages, finalizerReply, maxRoundsFallback, stripTextToolCalls } from "./reply.ts";
import type { TurnEnvironment, TurnInput, TurnPorts, TurnResult, TurnStatus } from "./types.ts";
import { accumulateUsage, closeTurnUsage, EMPTY_TURN_USAGE, replayedHistoryCosts, type TurnUsage } from "./usage.ts";

/** The lane every Keeper model call of a turn is attributed to. */
export const KEEPER_LANE = "keeper";

/** The caller's signal stopped the turn. */
class TurnAborted extends Error {
  constructor() {
    super("turn aborted");
    this.name = "TurnAborted";
  }
}

/** A Keeper model call failed in a way the turn does not recover from. */
class ProviderFailure extends Error {
  readonly failure: unknown;

  constructor(failure: unknown) {
    super("provider failure");
    this.name = "ProviderFailure";
    this.failure = failure;
  }
}

/** What the prompt read from the room's queues: cleared at the final commit, never before. */
interface Consumed {
  readonly whispers: readonly Whisper[];
  readonly facts: readonly PendingFact[];
  readonly actions: readonly PlayerAction[];
}

const NOTHING_CONSUMED: Consumed = { whispers: [], facts: [], actions: [] };

/** One call of a round as executed: its outcome, and the events its module command caused. */
interface Executed {
  readonly outcome: ToolOutcome;
  readonly effects: readonly EffectEvent[];
  readonly denied: boolean;
}

/** Run one Keeper turn. Never throws for a provider failure, a stale room or an abort. */
export function runKeeperTurn(context: RoomContext, input: TurnInput, ports: TurnPorts, env: TurnEnvironment): Promise<TurnResult> {
  return new KeeperTurn(context, input, ports, env).run();
}

class KeeperTurn {
  readonly #context: RoomContext;
  readonly #input: TurnInput;
  readonly #ports: TurnPorts;
  readonly #env: TurnEnvironment;
  readonly #gate: ReplyStreamGate;
  readonly #budget = new FoldBudget();
  readonly #ledger = new TurnLedger();
  readonly #problems: string[] = [];

  #worker: RoomWorker | null = null;
  #modules: readonly ModuleInfo[] = [];
  #catalog: TurnCatalog | null = null;
  #tools: readonly ToolDefinition[] = [];
  #moduleOwnsClock = false;
  #moduleClock: Awaited<ReturnType<typeof dispatchTurnStart>>["clock"] = null;
  #injections: readonly string[] = [];
  #consumed: Consumed = NOTHING_CONSUMED;

  #usage: TurnUsage = EMPTY_TURN_USAGE;
  #lastSent: readonly ChatMessage[] = [];
  #lastTools: readonly ToolDefinition[] = [];
  #overflowRetried = false;
  #commands = 0;

  readonly #outcomes: ToolOutcome[] = [];
  readonly #mainCalls: TurnToolCall[] = [];
  readonly #toolRoundTexts: string[] = [];
  readonly #committed: CommittedCall[] = [];
  readonly #toolsCalled: string[] = [];
  readonly #contentWrites = new Set<string>();
  readonly #rolls: RollResult[] = [];
  #keeperRecordedChronicle = false;
  #narrateNow = false;

  constructor(context: RoomContext, input: TurnInput, ports: TurnPorts, env: TurnEnvironment) {
    this.#context = context;
    this.#input = input;
    this.#ports = ports;
    this.#env = env;
    this.#gate = new ReplyStreamGate({ emit: (draft) => ports.signal("draft", draft), newId: () => context.services.clock.id() });
  }

  // ------------------------------------------------------------------ endings

  async run(): Promise<TurnResult> {
    try {
      return await this.#body();
    } catch (error) {
      if (error instanceof StaleGeneration || !this.#context.writer.current()) return this.#ended("stale");
      if (this.#isAbort(error)) {
        this.#dropDraft();
        return this.#ended("aborted");
      }
      if (error instanceof ProviderFailure) {
        const notice = failureNotice(error.failure, this.#context.locale);
        this.#problem(notice.code ?? "unavailable", error.failure instanceof Error ? error.failure.message : undefined);
        return this.#fail(notice.code ?? "unavailable", notice);
      }
      // A defect here must not cost the room more than this turn.
      this.#problem("internal", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return this.#fail("internal", failureNotice(error, this.#context.locale));
    }
  }

  #fail(code: string, notice: { level: "info" | "warn"; code?: string; text: string }): TurnResult {
    this.#dropDraft();
    try {
      this.#ports.signal("notice", notice);
    } catch {
      // The table could not be told; the operator's log already has the problem.
    }
    return this.#ended("failed", code);
  }

  #ended(status: TurnStatus, code?: string, reply: { text: string; id: string } | null = null, usage: TurnUsage = EMPTY_TURN_USAGE): TurnResult {
    return {
      status,
      ...(code === undefined ? {} : { code }),
      reply: reply?.text ?? null,
      replyId: reply?.id ?? null,
      usage,
      usageEstimated: usage.estimated,
      toolsCalled: [...this.#toolsCalled],
      contentWrites: new Set(this.#contentWrites),
      keeperRecordedChronicle: this.#keeperRecordedChronicle,
      narrateNowRequested: this.#narrateNow,
      problems: [...this.#problems],
    };
  }

  #isAbort(error: unknown): boolean {
    return error instanceof TurnAborted || this.#input.signal?.aborted === true || (error instanceof LLMError && error.code === "aborted");
  }

  /** After every suspension: stop on the caller's signal, refuse a room that moved on. */
  #checkpoint(): void {
    if (this.#input.signal?.aborted === true) throw new TurnAborted();
    this.#ensureCurrent();
  }

  #ensureCurrent(): void {
    const { writer, services, room } = this.#context;
    if (!writer.current()) throw new StaleGeneration(room, writer.epoch, services.store.room(room).epoch);
  }

  #problem(code: string, detail?: string): void {
    this.#problems.push(code);
    this.#context.services.report(this.#context.room, `turn ${this.#context.turn}: ${code}${detail === undefined ? "" : ` — ${detail}`}`);
  }

  #moduleProblems(problems: readonly string[], logs: readonly { module: string; text: string }[] = []): void {
    for (const problem of problems) this.#problem("module_problem", problem);
    for (const log of logs) this.#context.services.report(this.#context.room, `turn ${this.#context.turn}: module ${log.module} log — ${log.text}`);
  }

  #dropDraft(): void {
    try {
      this.#gate.discard();
    } catch {
      // A draft that cannot be withdrawn is the client's to clear on the next event.
    }
  }

  #seed(kind: string): string {
    return `${this.#context.room}:${this.#context.turn}:${kind}`;
  }

  #signalOptions(): { signal?: AbortSignal } {
    return this.#input.signal === undefined ? {} : { signal: this.#input.signal };
  }

  // ------------------------------------------------------------------ the turn

  async #body(): Promise<TurnResult> {
    const context = this.#context;
    const { services, room } = context;
    const locale = context.locale;

    // 0. Under the room's lock (the room holds it): busy, and this room's module worker.
    this.#checkpoint();
    this.#ports.signal("turn", { status: "busy", actor: this.#input.speaker });
    this.#worker = this.#ports.moduleWorker();

    // 1. The modules, and turn start.
    const described = await describeModules(this.#worker);
    this.#checkpoint();
    this.#moduleProblems(described.problems);
    this.#modules = described.modules;
    const started = await dispatchTurnStart(this.#worker, {
      turn: context.turn,
      seed: this.#seed("turnStart"),
      text: this.#input.text,
      who: context.who,
      variables: moduleVariablesJson(services, room),
      clock: clockReading(services, room, null),
      members: this.#ports.members(),
    });
    this.#checkpoint();

    // 2. Its effects: table facts go out now, before any reply.
    this.#moduleProblems(started.problems, started.logs);
    this.#moduleClock = started.clock;
    this.#injections = started.injections;
    this.#applyEffects(started, started.injections);

    // 3. The routine fold.
    if (this.#env.settings.foldEnabled) await this.#fold("routine");

    // 4. The catalogue, once for the whole turn.
    this.#buildCatalog();

    // 4–7. Recall, lore, the snapshot, the prompt.
    let messages = await this.#assemble(true);
    let base = messages.length;

    // 8. Tool rounds.
    const maxRounds = Math.max(1, Math.trunc(this.#env.settings.maxRounds));
    let allowed = maxRounds;
    let round = 0;
    let reply: string | null = null;
    let replyId: string | null = null;
    while (round < allowed) {
      round++;
      let result: ChatResult;
      try {
        result = await this.#keeperRound(messages, round);
      } catch (error) {
        this.#gate.finishRound({ discard: true });
        if (error instanceof StaleGeneration) throw error;
        if (this.#isAbort(error)) throw new TurnAborted();
        if (!this.#overflowRetried && isContextOverflow(error)) {
          const recovered = await this.#recover();
          if (recovered) {
            const tail = messages.slice(base);
            const rebuilt = await this.#assemble(false);
            messages = moveInTurnBreakpoint([...rebuilt, ...tail]);
            base = rebuilt.length;
            allowed = maxRounds + 1;
            continue;
          }
        }
        throw new ProviderFailure(error);
      }
      this.#checkpoint();
      if (isContextOverflow(result)) {
        // The reply stopped at the window: a truncated narration is not a reply.
        this.#gate.finishRound({ discard: true });
        if (!this.#overflowRetried && (await this.#recover())) {
          const tail = messages.slice(base);
          const rebuilt = await this.#assemble(false);
          messages = moveInTurnBreakpoint([...rebuilt, ...tail]);
          base = rebuilt.length;
          allowed = maxRounds + 1;
          continue;
        }
        throw new ProviderFailure(new LLMError({ code: "context_overflow", retryable: false }));
      }
      this.#usage = accumulateUsage(this.#usage, result.usage);
      this.#lastSent = messages;
      this.#lastTools = this.#tools;
      if (result.toolCalls.length > 0) {
        this.#gate.finishRound({ discard: true });
        this.#toolRoundTexts.push(result.content);
        const executed = await this.#executeRound(result);
        this.#mainCalls.push(...executed.calls);
        messages = moveInTurnBreakpoint([...messages, ...executed.messages]);
        continue;
      }
      this.#gate.finishRound({ discard: false });
      replyId = this.#gate.id;
      reply = result.content;
      break;
    }

    // 9. The end-of-turn checks, on a reply the loop produced.
    if (reply !== null) {
      const checked = await runTurnChecks({
        checks: turnChecksFor(context.pack),
        state: {
          reply,
          calls: this.#mainCalls,
          toolRoundTexts: this.#toolRoundTexts,
          diceTools: diceToolNames(context.pack === null ? [] : subsystemTools(context.pack).map((tool) => tool.name)),
          moduleOwnsClock: this.#moduleOwnsClock,
        },
        messages,
        locale,
        ask: this.#checkAsk(),
      });
      this.#checkpoint();
      reply = checked.reply;
    }

    // 10. Max rounds spent with no plain reply: the finalizer, else the fallback.
    if (reply === null) {
      const finalMessages = finalizerMessages(messages, this.#committed, locale);
      this.#gate.beginRound();
      let result: ChatResult | null = null;
      try {
        result = await withLane(
          KEEPER_LANE,
          () =>
            services.models.keeper.chat(finalMessages, {
              ...FINALIZER_OPTIONS,
              onTextDelta: (text) => this.#gate.feed(text),
              onRetry: () => this.#gate.discard(),
              ...this.#signalOptions(),
            }),
          { room, turn: context.turn, finalizer: 1 },
        );
      } catch (error) {
        this.#gate.finishRound({ discard: true });
        if (this.#isAbort(error)) throw new TurnAborted();
        this.#problem("finalizer_failed", error instanceof Error ? error.message : undefined);
      }
      this.#checkpoint();
      if (result !== null) {
        this.#usage = accumulateUsage(this.#usage, result.usage);
        this.#lastSent = finalMessages;
        this.#lastTools = [];
        const text = finalizerReply(result.content);
        if (text !== null) {
          this.#gate.finishRound({ discard: false });
          replyId = this.#gate.id;
          reply = text;
        } else {
          this.#gate.finishRound({ discard: true });
        }
      }
      if (reply === null) {
        reply = maxRoundsFallback(this.#committed, locale);
        replyId = services.clock.id();
      }
    }

    // 11. The final commit block: one synchronous stretch.
    return this.#commit(reply, replyId ?? services.clock.id());
  }

  // ------------------------------------------------------------------ effects

  /** Apply a validated module outcome and publish its events, in order. */
  #applyEffects(outcome: Applied, injections?: readonly string[]): void {
    const applied = applyModuleEffects(this.#context, injections === undefined ? outcome : { ...outcome, injections }, {
      review: this.#ports.reviewFact,
      action: this.#input.action,
      work: this.#input.work,
      members: this.#ports.members(),
    });
    if (applied.stale) this.#ensureCurrent();
    for (const write of applied.writes.applied) this.#contentWrites.add(write.path);
    for (const problem of applied.problems) this.#problem(`effect_${problem.code}`, [problem.module, problem.detail].filter((part) => part !== null && part !== undefined).join(" "));
    if (applied.narrateNow) this.#narrateNow = true;
    for (const event of applied.events) this.#publishEffect(event);
  }

  #publishEffect(event: EffectEvent): void {
    const id = event.id ?? this.#context.services.clock.id();
    switch (event.kind) {
      case "narrative":
        this.#ports.publish("narrative", id, event.data);
        return;
      case "dice":
        this.#ports.publish("dice", id, event.data);
        return;
      case "blocks":
        this.#ports.publish("blocks", id, event.data);
        return;
    }
  }

  #publishTableEvent(event: TableEvent): void {
    const id = this.#context.services.clock.id();
    switch (event.kind) {
      case "narrative":
        this.#ports.publish("narrative", id, event.data);
        return;
      case "dice":
        this.#ports.publish("dice", id, event.data);
        return;
      case "media":
        this.#ports.publish("media", id, event.data);
        return;
    }
  }

  // ------------------------------------------------------------------ the fold

  /** One fold pass, committed after re-reading and indexed. Returns how many records it folded. */
  async #fold(mode: "routine" | "recovery"): Promise<number> {
    const { services, room, locale } = this.#context;
    const store = services.store;
    const summary = readSummary(services, room);
    const records = readRecords(services, room);
    const history = readHistory(store, room, this.#context.turn, summaryThroughTurn(summary));
    const request: FoldRequest = {
      room,
      locale,
      previous: summary,
      records: [...records].map(([id, record]) => ({ id, record })),
      currentTurn: this.#context.turn - 1,
      replayed: replayedHistoryCosts(locale, history.history),
      settings: this.#env.settings.fold,
      budget: this.#budget,
      ...this.#signalOptions(),
    };
    const outcome = mode === "routine" ? await routineFold(services, { ...request, reading: readContextReading(store, room) }) : await recoveryFold(services, request);
    this.#checkpoint();
    if (outcome.stopped !== null) this.#problem(`fold_${outcome.stopped.code}`, outcome.stopped.llm);

    // Commit against the room as it is NOW.
    const commit = prepareFoldCommit(outcome, { summary: readSummary(services, room), records: readRecords(services, room) });
    if (!commit.ok) {
      this.#problem(`fold_${commit.code}`);
      return 0;
    }
    for (const write of commit.writes) {
      const previous = services.documents.get(room, write.type, write.id);
      services.documents.put(this.#context.writer, write.type, write.id, write.data, previous?.meta ?? {});
    }
    const folded = outcome.summary === null ? 0 : outcome.folded.length;
    if (folded > 0 && this.#env.recall !== undefined) {
      const indexed = await indexChronicleRecords(
        this.#env.recall,
        this.#context,
        outcome.index.map((item) => ({ id: item.id, text: item.text })),
      );
      this.#checkpoint();
      for (const problem of indexed.problems) this.#problem(`recall_${problem.code}`, problem.detail);
    }
    return folded;
  }

  /** After a context overflow: record it, fold once from what is left of the budget. True: re-send. */
  async #recover(): Promise<boolean> {
    this.#overflowRetried = true;
    // The meter now reads what the provider just said, so the next turn folds even if this one cannot.
    writeContextReading(this.#context, overflowReading(this.#env.settings.contextWindow));
    if (!this.#env.settings.foldEnabled) return false;
    return (await this.#fold("recovery")) > 0;
  }

  // ------------------------------------------------------------------ the catalogue

  #buildCatalog(): void {
    const context = this.#context;
    const { services, room } = context;
    const commands: ModuleCommand[] = this.#modules.flatMap((module) => module.commands.map((info) => ({ module: module.id, info })));
    this.#moduleOwnsClock = !keeperOwnsClock(services, room) || this.#modules.some((module) => module.clock);
    const enabled = readEnabledSkills(services.store, room);
    const recallDeps = this.#env.recall;
    const deps: ToolDeps = {
      voiceNpc: (request) => this.#voice(request),
      ...(this.#env.generateImage === undefined ? {} : { generateImage: this.#env.generateImage }),
      ...(recallDeps === undefined
        ? {}
        : {
            recallLore: async (target: string, query: string) => {
              const hits = await recall(recallDeps, target, query, this.#signalOptions());
              for (const problem of hits.problems) this.#problem(`recall_${problem.code}`, problem.detail);
              return hits.lore;
            },
          }),
      ...(this.#worker === null ? {} : { runCommand: (request: RunCommandRequest) => this.#runCommand(request) }),
    };
    const catalog = buildCatalog({ unlocked: unlockedTools(this.#env.skills, enabled), keeperOwnsClock: !this.#moduleOwnsClock, pack: context.pack, commands, deps });
    for (const problem of catalog.problems) this.#problem("catalog_problem", problem);
    this.#catalog = catalog;
    this.#tools = catalog.definitions();
  }

  /**
   * `run_command`: one module command and the further steps it asks for, ONE tool call. Each
   * completed step's effects are applied and its events published as it completes (the call
   * is a group of its own, so call order holds), so a later step that fails loses only itself.
   */
  async #runCommand(request: RunCommandRequest): Promise<ModuleCommandRun> {
    const context = this.#context;
    const { services, room } = context;
    const events: EffectEvent[] = [];
    const outcome = await runModuleCommand(
      this.#worker,
      { module: request.module, command: request.command, args: request.args, who: context.who, by: "keeper", seed: this.#seed(`command:${++this.#commands}`) },
      {
        now: () => services.clock.now(),
        room: () => ({ turn: context.turn, variables: moduleVariablesJson(services, room), clock: clockReading(services, room, this.#moduleClock), members: this.#ports.members() }),
        apply: (step) => {
          if (this.#input.signal?.aborted === true || !context.writer.current()) return false;
          this.#moduleProblems([], step.logs);
          const applied = applyModuleEffects(context, step, { review: this.#ports.reviewFact, action: this.#input.action, work: this.#input.work, members: this.#ports.members() });
          if (applied.stale) return false;
          for (const write of applied.writes.applied) this.#contentWrites.add(write.path);
          for (const problem of applied.problems) this.#problem(`effect_${problem.code}`, problem.detail);
          if (applied.narrateNow) this.#narrateNow = true;
          for (const event of applied.events) {
            this.#publishEffect(event);
            events.push(event);
          }
          return true;
        },
      },
    );
    this.#moduleProblems(outcome.problems);
    return { ...outcome, events };
  }

  /** The NPC actor lane, adapted to the tool's dependency. */
  async #voice(request: VoiceNpcRequest): Promise<VoiceNpcResult> {
    const voiced = await voiceNpc(this.#context.services, {
      room: request.room,
      locale: request.locale,
      document: request.document,
      type: npcDocument,
      situation: request.situation,
      tone: request.tone,
      target: request.target,
      allowedActions: request.allowedActions,
      effort: request.effort,
      ...this.#signalOptions(),
    });
    if (!voiced.ok) return { ok: false, code: voiced.code };
    if (voiced.degraded) this.#problem("npc_reply_degraded", voiced.npc);
    return { ok: true, line: voiced.line, intent: voiced.intent, mood: voiced.mood };
  }

  // ------------------------------------------------------------------ assembly

  #line(): string {
    return this.#input.work === "facts_turn" ? FACTS_TURN_LINE : this.#input.text;
  }

  #speaker(): string {
    return this.#input.work === "facts_turn" ? "" : this.#input.speaker;
  }

  /** Steps 4–7 (the catalogue is already built): recall, lore, then the snapshot read in one stretch. */
  async #assemble(advanceTimers: boolean): Promise<ChatMessage[]> {
    const context = this.#context;
    const { services, room, locale } = context;
    const store = services.store;

    // History changes only through this room's own turns or a rewind (which the checkpoints
    // refuse), so the reading taken here stays true across the exchanges below.
    const summary = readSummary(services, room);
    const history = readHistory(store, room, context.turn, summaryThroughTurn(summary));
    if (history.truncated) this.#problem("history_truncated");
    const line = this.#line();
    const transcript = retrievalWindow(history.recent, line);
    const clockText = this.#moduleClock?.time ?? storedClockText(services, room);
    const userName = context.who.character?.name ?? this.#input.speaker;

    // 5. Recall by meaning.
    let loreHits: readonly string[] = [];
    let chronicleHits: readonly string[] = [];
    if (this.#env.recall !== undefined) {
      const hits = await recall(this.#env.recall, room, transcript.join("\n"), this.#signalOptions());
      this.#checkpoint();
      for (const problem of hits.problems) this.#problem(`recall_${problem.code}`, problem.detail);
      loreHits = hits.lore;
      chronicleHits = hits.chronicle;
    }

    // 6. The lore exchange.
    const lore = await runLoreStep(
      context,
      {
        viewer: "keeper",
        transcript,
        advanceTimers,
        variables: loreVariables(services, room),
        nowMs: history.nowMs ?? services.clock.now(),
        semanticHits: loreHits,
        names: { user: userName },
        ...(clockText === null ? {} : { clock: { time: clockText } }),
      },
      { worker: () => this.#ports.loreWorker() },
    );
    this.#checkpoint();
    for (const problem of lore.problems) this.#problem(problem.code.startsWith("lore_") ? problem.code : `lore_${problem.code}`, problem.detail);
    if (lore.failures.length > 0) this.#problem("lore_template_failed", lore.failures.map((failure) => failure.code).join(", "));

    // 7. Commit lore, read everything, assemble — one synchronous stretch.
    const committed = commitLore(context, lore);
    if (committed.stale) this.#ensureCurrent();
    for (const write of committed.writes.applied) this.#contentWrites.add(write.path);
    for (const refusal of committed.writes.refused) this.#problem("lore_write_refused", `${refusal.path}: ${refusal.code}`);

    const whispers = store.stateGet(room, WHISPERS_KEY) ?? [];
    const facts = readPendingFacts(store, room);
    const actions = readPlayerActions(store, room);
    this.#consumed = { whispers, facts, actions };

    const macros: MacroContext = {
      names: { user: userName },
      variables: loreVariables(services, room),
      ...(clockText === null ? {} : { clock: { time: clockText } }),
      random: context.random,
      pickSeed: room,
      roll: diceRoller(context.random),
    };
    const injections = [...this.#injections, ...renderPendingFacts(facts)];
    const opening = this.#opening(history.keeperHasReplied || !history.reachedStart || summary !== null, macros);
    if (opening !== null) injections.push(opening);

    const skills = activeSkills(this.#env.skills, readEnabledSkills(store, room)).map((skill) => skill.body);
    // Only what the Keeper can run: an admin command, or a member's own verb (`keeper: false`),
    // would be a line in the prompt the Keeper must not act on.
    const moduleCommands = this.#modules.flatMap((module) =>
      module.commands.filter((info) => keeperMayRun(info.role, info.keeper)).map((info) => commandLine(commandId({ module: module.id, info }), info.description)),
    );
    const snapshot = readKeeperSnapshot(context, {
      pack: context.pack,
      skills,
      moduleCommands,
      lore: lore.text,
      whispers: whispers.map((whisper) => renderWhisper(locale, whisper)),
      playerActions: actions,
      injections,
      recalled: chronicleHits,
      history: history.history,
      speaker: this.#speaker(),
      line,
      moduleClock: this.#moduleClock,
      macros,
    });
    return keeperMessages(assembleKeeperPrompt(snapshot));
  }

  /**
   * The world card's authored opening, on the room's first Keeper turn only: 2.6 handed it
   * to the Keeper (the keeper-only module brief) to open play with. Macros run like the
   * card's post-history text; template code in it is not rendered.
   */
  #opening(played: boolean, macros: MacroContext): string | null {
    if (played) return null;
    const opening = readOpening(this.#context.services, this.#context.room);
    if (opening === null) return null;
    const text = opening.opening.trim() !== "" ? opening.opening : (opening.alternates.find((alternate) => alternate.trim() !== "") ?? "");
    if (text.trim() === "") return null;
    const rendered = substituteMacros(text, { ...macros, names: { ...macros.names, char: opening.name } });
    return `${OPENING_NOTE}\n\n${rendered}`;
  }

  // ------------------------------------------------------------------ model rounds

  #keeperRound(messages: readonly ChatMessage[], round: number): Promise<ChatResult> {
    const options: ChatOptions = {
      tools: this.#tools,
      toolChoice: "auto",
      onTextDelta: (text) => this.#gate.feed(text),
      onRetry: () => this.#gate.discard(),
      ...this.#signalOptions(),
    };
    this.#gate.beginRound();
    return withLane(KEEPER_LANE, () => this.#context.services.models.keeper.chat(messages, options), {
      room: this.#context.room,
      turn: this.#context.turn,
      round,
    });
  }

  /** The end-of-turn checks' model round: the turn's tools and tool choice, unstreamed, the same veto. */
  #checkAsk(): CheckAsk {
    return async (convo, meta) => {
      let result: ChatResult;
      try {
        result = await withLane(
          KEEPER_LANE,
          () => this.#context.services.models.keeper.chat(convo, { tools: this.#tools, toolChoice: "auto", ...this.#signalOptions() }),
          { room: this.#context.room, turn: this.#context.turn, check: meta.check },
        );
      } catch (error) {
        if (this.#isAbort(error)) throw new TurnAborted();
        this.#checkpoint();
        this.#problem("check_failed", error instanceof Error ? error.message : undefined);
        return { kind: "failed" };
      }
      this.#checkpoint();
      const usage = result.usage === undefined ? {} : { usage: result.usage };
      if (result.toolCalls.length === 0) return { kind: "reply", content: result.content, ...usage };
      const executed = await this.#executeRound(result);
      return { kind: "tools", content: result.content, messages: executed.messages, calls: executed.calls, ...usage };
    };
  }

  // ------------------------------------------------------------------ tool rounds

  /** One tool round: the veto, the calls in the catalogue's grouping, events in call order. */
  async #executeRound(result: ChatResult): Promise<{ readonly messages: ChatMessage[]; readonly calls: TurnToolCall[] }> {
    const context = this.#context;
    const { services, room } = context;
    const catalog = this.#catalog as TurnCatalog;
    const calls = result.toolCalls;
    const requests: CallRequest[] = calls.map((call) => ({ name: call.name, input: call.input }));

    const veto = await dispatchToolUse(this.#worker, {
      turn: context.turn,
      who: context.who,
      variables: moduleVariablesJson(services, room),
      clock: clockReading(services, room, this.#moduleClock),
      members: this.#ports.members(),
      calls: calls.map((call) => ({ id: call.id, name: call.name, args: (call.input.valid ? call.input.value : {}) as ModuleJson })),
    });
    this.#checkpoint();
    this.#moduleProblems(veto.problems, veto.logs);

    const executed: Executed[] = [];
    for (const group of concurrencyGroups(catalog, requests)) {
      const settled = await Promise.all(group.map((index) => this.#runCall(catalog, requests[index] as CallRequest, veto.verdicts[index] ?? { allowed: true })));
      this.#checkpoint();
      group.forEach((index, at) => {
        executed[index] = settled[at] as Executed;
      });
      // Published in call order, group by group. A module command's events are not among
      // them: its steps published their own as each completed (`#runCommand`).
      for (const index of group) {
        const item = executed[index] as Executed;
        for (const event of item.outcome.events) this.#publishTableEvent(event);
      }
    }

    const assistant: AssistantMessage = {
      role: "assistant",
      content: result.content,
      toolCalls: calls,
      ...(result.providerState === undefined ? {} : { providerState: result.providerState }),
    };
    const messages: ChatMessage[] = [assistant];
    const turnCalls: TurnToolCall[] = [];
    calls.forEach((call, index) => {
      const { outcome, effects, denied } = executed[index] as Executed;
      const suppressed = denied || outcome.status !== "ok";
      const tool: ToolResultMessage = { role: "tool", toolCallId: call.id, content: outcome.text, ...(suppressed ? { isError: true } : {}) };
      messages.push(tool);
      const dice: DiceData[] = [
        ...outcome.events.flatMap((event) => (event.kind === "dice" ? [event.data] : [])),
        ...effects.flatMap((event) => (event.kind === "dice" ? [event.data] : [])),
      ];
      for (const event of outcome.events) if (event.kind === "dice") this.#rolls.push(rollResult(event.data));
      turnCalls.push({ name: call.name, args: call.input.valid ? call.input.value : null, suppressed, dice });
      this.#outcomes.push(outcome);
      this.#toolsCalled.push(call.name);
      this.#committed.push({ name: call.name, result: outcome.text, keeperOnly: outcome.keeperOnly, suppressed });
      if (call.name === "record_chronicle" && outcome.status === "ok") this.#keeperRecordedChronicle = true;
    });
    return { messages, calls: turnCalls };
  }

  /** One call: a denied one is answered with the module's reason; a module command's effects are applied as it resumes. */
  async #runCall(catalog: TurnCatalog, request: CallRequest, verdict: ToolVerdict): Promise<Executed> {
    if (!verdict.allowed) {
      const text = verdict.denials.map((denial) => denial.reason).join("\n");
      const outcome: ToolOutcome = {
        name: request.name,
        status: "refused",
        code: "module_denied",
        text,
        truncated: false,
        keeperOnly: false,
        events: [],
        bookkeeping: NO_BOOKKEEPING,
      };
      return { outcome, effects: [], denied: true };
    }
    const outcome = await catalog.dispatch(this.#context, request, this.#ledger);
    // A module command's effects were applied, step by step, inside the call (`#runCommand`).
    const command = outcome.bookkeeping.moduleCommand;
    return { outcome, effects: command === null ? [] : command.outcome.events, denied: false };
  }

  // ------------------------------------------------------------------ the commit

  /** Steps 11–13. */
  async #commit(raw: string, replyId: string): Promise<TurnResult> {
    const context = this.#context;
    const { services, room, locale } = context;
    this.#checkpoint();

    // (a) `<UpdateVariable>`: applied to the tree and stripped. The tree is written only once
    // the review lets the reply through: an unpublished reply must not change the room.
    const treeDocument = services.documents.get(room, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
    const stored = treeDocument === null || treeDocument.corrupt ? null : readVariableTree(treeDocument.data);
    const update = applyReplyUpdates(stored?.tree ?? (new Map() as VarMap), raw);
    // A reply too long to scan that may hold a block cannot be cleaned: it is not published
    // (its blocks would reach the table as written), the way a blocked reply is not.
    if (update.overflow) {
      this.#problem("reply_updates_unscanned", `${raw.length} characters`);
      return this.#fail("reply_too_long", { level: "warn", code: "reply_too_long", text: turnText(locale, "loop.reply_too_long") });
    }
    // (b) Textual tool calls.
    const text = stripTextToolCalls(update.text);
    // (c) The review.
    const reviewed = this.#ports.reviewNarrative(text);
    if (!reviewed.allowed) {
      this.#problem("reply_blocked");
      return this.#fail("reply_blocked", { level: "warn", code: "reply_blocked", text: turnText(locale, "loop.reply_blocked") });
    }
    const keeperWrites: ModuleVariableWrite[] = [];
    if (stored !== null && treeDocument !== null && update.changed) {
      try {
        services.documents.put(context.writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(update.tree, stored.exposed), treeDocument.meta);
        for (const result of update.results) {
          if (result.outcome.status === "applied") keeperWrites.push({ path: result.command.path, value: result.outcome.value as ModuleVariableWrite["value"], by: "keeper" });
        }
      } catch (error) {
        if (!(error instanceof DocumentRefused)) throw error;
        this.#problem("reply_updates_refused");
      }
    }
    // (d) Publish.
    const published: NarrativeData = { speaker: "kp", text: reviewed.text, format: "markdown" };
    this.#ports.publish("narrative", replyId, published);
    // (e) What the prompt consumed.
    this.#clearConsumed();
    // (f) The meter.
    const closed = closeTurnUsage(this.#usage, this.#lastSent, this.#lastTools, this.#env.settings.contextWindow);
    writeContextReading(context, closed.reading);

    // 12. The reply phase: the modules see the published reply.
    const bookkeeping = mergeBookkeeping(this.#outcomes);
    const variables = loreVariables(services, room);
    const variableWrites: ModuleVariableWrite[] = [
      ...bookkeeping.variableWrites.map((write) => ({ path: write.path, value: jsonValue(readVariable(variables, write.path)), by: "keeper" })),
      ...keeperWrites,
    ];
    const phase = await dispatchReplyPhase(this.#worker, {
      turn: context.turn,
      seed: this.#seed("replyPhase"),
      reply: reviewed.text,
      rolls: this.#rolls,
      // The DELTA, always: a clock face the engine cannot move by itself (a module's own
      // calendar) is exactly the case where a module needs to know how far time went. The
      // first version sent the unmoved face's text instead, and the flagship pack's calendar
      // could not count the Keeper's advances.
      clockAdvances: bookkeeping.clockAdvances.map((advance) => ({ amount: `${advance.minutes} minutes` })),
      variableWrites,
      who: context.who,
      variables: moduleVariablesJson(services, room),
      clock: clockReading(services, room, this.#moduleClock),
      members: this.#ports.members(),
    });
    // Past the publication an abort has nothing left to stop; a rewind still ends the turn.
    this.#ensureCurrent();

    // 13. Its effects; a narrate-now mark is only recorded.
    this.#moduleProblems(phase.problems, phase.logs);
    this.#applyEffects(phase);
    return this.#ended("replied", undefined, { text: reviewed.text, id: replyId }, closed.usage);
  }

  /** Clear exactly what the prompt read: anything queued while the turn ran stays. */
  #clearConsumed(): void {
    const { services, room, writer } = this.#context;
    const store = services.store;
    const consumed = this.#consumed;
    if (consumed.whispers.length > 0) {
      const rest = withoutConsumed(store.stateGet(room, WHISPERS_KEY) ?? [], consumed.whispers);
      if (rest.length > 0) writer.statePut(WHISPERS_KEY, rest);
      else writer.stateDelete(WHISPERS_KEY);
    }
    if (consumed.facts.length > 0) {
      const rest = withoutConsumed(readPendingFacts(store, room), consumed.facts);
      if (rest.length > 0) writer.statePut(PENDING_FACTS, rest);
      else writer.stateDelete(PENDING_FACTS);
    }
    if (consumed.actions.length > 0) {
      const rest = withoutConsumed(readPlayerActions(store, room), consumed.actions);
      if (rest.length > 0) writer.statePut(PLAYER_ACTIONS, rest);
      else writer.stateDelete(PLAYER_ACTIONS);
    }
  }
}

/** A dice event as a module's `RollResult`. */
function rollResult(dice: DiceData): RollResult {
  const faces = dice.rolls.length > 0 ? ` [${dice.rolls.join(", ")}]` : "";
  const label = dice.subsystemLabel ?? dice.outcome?.label;
  return { notation: dice.expr, total: dice.total, text: `${dice.expr}${faces} = ${dice.total}`, ...(label === undefined ? {} : { label }) };
}

/** A variable's value as JSON for a module (absent: null). */
function jsonValue(value: unknown): ModuleVariableWrite["value"] {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as ModuleVariableWrite["value"];
  } catch {
    return null;
  }
}

