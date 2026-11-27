// The test host: runs one module in-process, through the same runner a room's worker
// uses, so an author can write `bun test` files against it. Fire events, run commands as
// anyone, read views, inspect effects and the checkpoint, and restart the module from
// its checkpoint. Dice are scripted.
//
// Before a command runs the host does what the engine does first: it reads the command's
// text forms against its `params` (`host.text` matches a typed line against them), and it
// checks the arguments against `params`. Both are the engine's own code (`forms.ts`,
// `args.ts`).
//
// What the test host does NOT do is the rest of the engine's half: it applies nothing, it
// does not enforce the engine's size limits (see the README for them), and it knows only
// this module — a form the engine would drop for a word it or another module owns is kept
// here. Effects come back exactly as the module requested them.
import { type ArgsProblem, checkModuleArgs } from "./args.ts";
import { type FormProblem, formArgs, parseForm, pickForm, type TextForm } from "./forms.ts";
import type { ClockAdvance, ClockReading, CommandOrigin, Json, JsonObject, ModuleDefinition, Role, RollResult, RoomMember, RoomSnapshot, VariableWrite, Who } from "./module.ts";
import {
  type CallValue,
  type CommandOutcome,
  type CommandValue,
  commandAnswer,
  type DiceRoller,
  type Effect,
  type ModuleDescription,
  ModuleRunner,
  mayRun,
  mayUse,
  type Refusal,
  runSteps,
  type StepStop,
} from "./runner.ts";
import { foldCase } from "./text.ts";

export type { ArgsProblem, CommandOutcome, DiceRoller, Effect, FormProblem, ModuleDescription, Refusal, StepStop };

export interface TestHostOptions {
  /**
   * The dice: a list of totals handed out in order (`[17, 4]`), or a function given the
   * notation and the derived seed. Without it, a module that rolls fails its call.
   */
  readonly dice?: DiceRoller | readonly number[];
  /** Start from this checkpoint (as `load` would) instead of a fresh `create`. */
  readonly snapshot?: Json;
  /** Who calls are made as when a call names nobody. Default: a player with no character. */
  readonly who?: Who;
  /** The room's variables for every call that sets none. Default `{}`. */
  readonly variables?: JsonObject;
  /** The room's clock for every call that sets none. Default null. */
  readonly clock?: ClockReading | null;
  /** The room's members for every call that sets none. Default: none. */
  readonly members?: readonly RoomMember[];
  /** The module's `options`, as a pack's manifest would give them (`init.options`). Default `{}`. */
  readonly options?: JsonObject;
  /**
   * The prefix of the seeds the host derives for each call. Default `test`. `create` and
   * `load` get `init.seed` = `<seed>:<module id>`.
   */
  readonly seed?: string;
  /**
   * A NEW instance of the module, for `restart()`: e.g.
   * `async () => (await import(\`./my_module.ts?${n++}\`)).default`. Without it, `restart()`
   * reuses the same definition object, so state the module keeps outside what `load`
   * assigns would wrongly survive.
   */
  readonly fresh?: () => ModuleDefinition | Promise<ModuleDefinition>;
  /**
   * Milliseconds, for the time limit of a command that runs in steps (`more: true`). Default
   * `Date.now`; a test of that limit passes a clock it moves itself.
   */
  readonly now?: () => number;
}

/** What one call did. */
export interface TestCall {
  /** The effects the module requested, in order; empty when the call failed. */
  readonly effects: readonly Effect[];
  /** Effects dropped because they do not belong in this call or were malformed. */
  readonly refused: readonly Refusal[];
  /** The error, when the call threw (its effects were dropped and its state rolled back). */
  readonly error: string | null;
  /** The module's checkpoint after the call. */
  readonly checkpoint: Json | null;
  /** Shortcuts into `effects`. */
  readonly injected: readonly string[];
  readonly facts: readonly Extract<Effect, { kind: "fact" }>[];
  readonly writes: readonly Extract<Effect, { kind: "setVar" }>[];
  readonly blocks: readonly Extract<Effect, { kind: "blocks" }>[];
  readonly rolls: readonly Extract<Effect, { kind: "roll" }>[];
  readonly seats: readonly Extract<Effect, { kind: "seat" }>[];
  readonly logs: readonly string[];
}

/**
 * What one command did, over all its steps: `effects` and the shortcuts are every completed
 * step's, in order; `outcome` is what its caller is answered (see the README's stepped
 * commands); `steps` how many steps completed; `stopped` why the loop was cut, or null.
 */
export interface TestCommand extends TestCall {
  readonly outcome: CommandOutcome | ArgsRefusal;
  readonly steps: number;
  readonly stopped: StepStop | null;
}

/**
 * The arguments do not fit the command's `params`: nothing ran. `code` is the engine's own
 * refusal code and `path` the argument's, dotted (`target`, `a.skill`, `writes.0.value`;
 * empty for the arguments as a whole) — what a member is refused with, as for an engine command.
 */
export interface ArgsRefusal {
  readonly status: "refused";
  readonly reason: "args";
  readonly code: ArgsProblem["code"];
  readonly path: string;
}

/**
 * A typed line that ran nothing. `usage`: its first word is one of the module's command
 * words, but no form of that word fits the rest (`forms` are that word's forms as declared).
 * `no_form`: its first word is none of the module's words. The engine would hand such a line
 * to another command, or call it unknown; the host knows only this module.
 */
export type TextRefusal =
  | { readonly status: "refused"; readonly reason: "text"; readonly code: "usage"; readonly forms: readonly string[] }
  | { readonly status: "refused"; readonly reason: "text"; readonly code: "no_form" };

/** What `host.text` did: what `host.command` answers for the command the line matched, and which that was. */
export interface TestText extends Omit<TestCommand, "outcome"> {
  readonly outcome: TestCommand["outcome"] | TextRefusal;
  /**
   * The command, the form (as declared) and the arguments the line was read as; null when no
   * form fit (`outcome` is then a `TextRefusal`). Set too when the arguments then failed the
   * check against `params`: `outcome` says so.
   */
  readonly matched: { readonly command: string; readonly form: string; readonly args: JsonObject } | null;
}

/**
 * The module's text forms as the engine reads them at load: the forms that read, and the ones
 * it drops for their grammar (`problem` says why), both in declaration order.
 */
export interface TestForms {
  readonly kept: readonly { readonly command: string; readonly form: string }[];
  readonly dropped: readonly { readonly command: string; readonly form: string; readonly problem: FormProblem }[];
}

export interface TurnStartInput {
  readonly text: string;
  readonly who?: Who;
  /** Default: one past the last turn this host started. */
  readonly turn?: number;
  readonly seed?: string;
  readonly variables?: JsonObject;
  readonly clock?: ClockReading | null;
}

/**
 * The room a call sees; every field is optional. Defaults: the host's `variables` and
 * `clock` options (empty variables, null clock), and the last turn started (1 before any).
 */
export interface RoomInput {
  readonly turn?: number;
  readonly variables?: JsonObject;
  readonly clock?: ClockReading | null;
  readonly members?: readonly RoomMember[];
}

export interface ToolCallInput {
  /** Default: `call-<index>`. */
  readonly id?: string;
  readonly name: string;
  readonly args?: JsonObject;
}

export interface ReplyPhaseInput {
  readonly reply: string;
  readonly who?: Who;
  /** Default: the last turn this host started. */
  readonly turn?: number;
  readonly seed?: string;
  readonly rolls?: readonly RollResult[];
  readonly clockAdvances?: readonly ClockAdvance[];
  readonly variableWrites?: readonly VariableWrite[];
  readonly variables?: JsonObject;
  readonly clock?: ClockReading | null;
}

export interface TestHost {
  readonly id: string;
  /** The static description the engine would read at load. */
  readonly description: ModuleDescription;
  /** The module's text forms as the engine reads them at load: the ones that read, and the ones it drops. */
  readonly forms: TestForms;
  /** The current checkpoint: what a restart would load. */
  readonly checkpoint: Json | null;
  turnStart(input: TurnStartInput): Promise<TestCall & { readonly clock: Json | null }>;
  /** The verdicts, in call order: `true`, or the first denial's reason. */
  toolUse(calls: readonly ToolCallInput[], who?: Who, room?: RoomInput): Promise<TestCall & { readonly verdicts: readonly (true | string)[] }>;
  replyPhase(input: ReplyPhaseInput): Promise<TestCall>;
  /**
   * Runs a command as the member `who` (`call.by` is `member`), with the role, argument and
   * `available` checks the engine makes, in that order — arguments that do not fit `params`
   * are refused as an `ArgsRefusal` before the module is called — and its further steps while
   * it answers `more: true`, as the engine does.
   */
  command(name: string, args?: JsonObject, who?: Who, room?: RoomInput): Promise<TestCommand>;
  /**
   * What a member types after the `.` prefix (`"attack Bo"`): matched against the forms of the
   * module's commands — the form with the most literal words wins, then declaration order —
   * and, when one fits, run as `command` runs it (the same role, argument and `available`
   * checks, the same steps). A line that fits no form is refused as `usage` (its first word is
   * one of the module's command words) or `no_form` (it is not); see `TextRefusal`. The host
   * knows only this module: a word the engine or another module owns is not refused here.
   */
  text(line: string, who?: Who, room?: RoomInput): Promise<TestText>;
  /**
   * Runs a command as the Keeper does with its `run_command` tool (`call.by` is `keeper`),
   * with the same checks: `player` and `keeper` commands run, `admin` ones are refused, and
   * arguments that do not fit `params` are refused as for `command`.
   * `who` is the member whose turn it is (default: the host's `who`).
   */
  keeperCommand(name: string, args?: JsonObject, who?: Who, room?: RoomInput): Promise<TestCommand>;
  /** A view's data for `who`; throws when there is no such view or it failed. */
  view(name: string, who?: Who, room?: RoomInput): Promise<Json>;
  /**
   * Whether the member `who` may use a command: `"role"` when the role forbids it (a `keeper`
   * command: for everyone but an admin), otherwise what the command's `available` answers
   * (`true` when it has none) — the question the engine asks at the moment of use.
   */
  available(name: string, who?: Who, room?: RoomInput): Promise<Json>;
  characters(room?: RoomInput): Promise<Json>;
  /** The clock reading, or null when the module does not claim the clock. */
  clock(room?: RoomInput): Promise<Json | null>;
  /** Simulate a restart: a new instance of the module, `load`-ed from the checkpoint. */
  restart(): Promise<void>;
}

/** A `who` for tests: `who("Ada")`, `who("Mo", { role: "admin" })`, `who("Ada", { character: { id: "ada", name: "Ada" } })`. */
export function who(
  name: string,
  options: { readonly id?: string; readonly role?: Role; readonly character?: { readonly id: string; readonly name: string } | null } = {},
): Who {
  return { member: { id: options.id ?? name.toLowerCase(), name, role: options.role ?? "player" }, character: options.character ?? null };
}

function scriptedDice(dice: TestHostOptions["dice"]): DiceRoller {
  if (typeof dice === "function") return dice;
  const queue = [...(dice ?? [])];
  return (notation) => {
    const total = queue.shift();
    if (total === undefined) throw new Error(`test host: no scripted dice left to roll ${notation}`);
    return { total, text: `${notation} = ${total}` };
  };
}

const PATH = "test-host";

/** A form that read, with the command it belongs to and the `params` it was read against. */
interface Candidate {
  readonly command: string;
  readonly params: Json;
  readonly form: TextForm;
}

/** The forms of every command, read against its `params` as the engine reads them at load. */
function readForms(description: ModuleDescription): { readonly forms: TestForms; readonly candidates: ReadonlyMap<string, readonly Candidate[]> } {
  const kept: { command: string; form: string }[] = [];
  const dropped: { command: string; form: string; problem: FormProblem }[] = [];
  const byWord = new Map<string, Candidate[]>();
  for (const command of description.commands) {
    for (const source of Array.isArray(command.text) ? command.text : []) {
      if (typeof source !== "string") continue;
      const read = parseForm(source, command.params);
      if (!read.ok) {
        dropped.push({ command: command.name, form: source, problem: read.problem });
        continue;
      }
      kept.push({ command: command.name, form: source });
      const forWord = byWord.get(read.form.word) ?? [];
      forWord.push({ command: command.name, params: command.params, form: read.form });
      byWord.set(read.form.word, forWord);
    }
  }
  return { forms: { kept, dropped }, candidates: byWord };
}

const TOKEN = /^(\S+)(?:\s+([\s\S]*))?$/u;

/** The command word, case-folded, and the rest, trimmed, of what a member typed after the prefix; the engine splits a line the same way. */
function splitLine(line: string): { readonly word: string; readonly rest: string } | null {
  const match = TOKEN.exec(line.trim());
  return match === null ? null : { word: foldCase(match[1] as string), rest: (match[2] ?? "").trim() };
}

export function createTestHost(definition: ModuleDefinition, options: TestHostOptions = {}): TestHost {
  const dice = scriptedDice(options.dice);
  const defaultWho = options.who ?? who("Player");
  const seedPrefix = options.seed ?? "test";
  const now = options.now ?? Date.now;
  let runner = new ModuleRunner({ dice });
  let description: ModuleDescription;
  let forms: TestForms;
  /** The forms that read, by command word (case-folded), in declaration order: what a typed line is matched against. */
  let candidates: ReadonlyMap<string, readonly Candidate[]>;
  let lastTurn = 0;

  function start(module: ModuleDefinition, snapshot: Json | undefined): void {
    runner = new ModuleRunner({ dice });
    const loaded = runner.load([{ path: PATH, definition: module, options: options.options ?? {} }], snapshot === undefined ? {} : { [module.id]: snapshot }, seedPrefix);
    const first = loaded.modules[0];
    if (!first) throw new Error("test host: the module did not load");
    description = first;
    ({ forms, candidates } = readForms(first));
  }
  start(definition, options.snapshot);

  function report(value: Pick<CallValue, "effects" | "failures" | "refused">): TestCall {
    const failure = value.failures.find((entry) => entry.module === description.id);
    const effects = value.effects;
    return {
      effects,
      refused: value.refused,
      error: failure?.error ?? null,
      checkpoint: runner.checkpointOf(description.id),
      injected: effects.flatMap((effect) => (effect.kind === "inject" ? [effect.text] : [])),
      facts: effects.filter((effect) => effect.kind === "fact"),
      writes: effects.filter((effect) => effect.kind === "setVar"),
      blocks: effects.filter((effect) => effect.kind === "blocks"),
      rolls: effects.filter((effect) => effect.kind === "roll"),
      seats: effects.filter((effect) => effect.kind === "seat"),
      logs: effects.flatMap((effect) => (effect.kind === "log" ? [effect.text] : [])),
    };
  }

  function snapshot(room: RoomInput = {}): RoomSnapshot {
    return {
      turn: room.turn ?? Math.max(lastTurn, 1),
      variables: room.variables ?? options.variables ?? {},
      clock: room.clock === undefined ? (options.clock ?? null) : room.clock,
      members: room.members ?? options.members ?? [],
    };
  }

  async function renderFor(viewer: Who, room?: RoomInput, view?: string) {
    const rendered = await runner.render({ viewers: [{ who: viewer, views: view === undefined ? [] : [{ module: description.id, view }] }], room: snapshot(room) });
    const failure = rendered.failures[0];
    if (failure) throw new Error(`test host: ${failure.error}`);
    return rendered;
  }

  /** What a call that never reached the module answers: no effects, no steps. */
  function notRun<O extends TestCommand["outcome"] | TextRefusal>(outcome: O): Omit<TestCommand, "outcome"> & { readonly outcome: O } {
    return { ...report({ effects: [], refused: [], failures: [] }), outcome, steps: 0, stopped: null };
  }

  /** A command and its further steps, as the engine runs them (`runSteps`); every step's effects together. */
  async function runCommand(by: CommandOrigin["by"], name: string, args: JsonObject, caller: Who | undefined, room: RoomInput | undefined): Promise<TestCommand> {
    const spec = description.commands.find((entry) => entry.name === name);
    // In the engine's order: an unknown command and a role that forbids it are the runner's to
    // refuse; the arguments are checked after them, before `available` or `run` is asked.
    if (spec !== undefined && mayRun(spec.role, by, caller ?? defaultWho, spec.keeper)) {
      const problem = checkModuleArgs(spec.params, args);
      if (problem !== null) return notRun<ArgsRefusal>({ status: "refused", reason: "args", code: problem.code, path: problem.path });
    }
    const seen = snapshot(room);
    const effects: Effect[] = [];
    const refused: Refusal[] = [];
    const failures: CallValue["failures"][number][] = [];
    const run = await runSteps<Extract<CommandOutcome, { status: "ok" }>, CommandValue>(`${seedPrefix}:${seen.turn}:command:${name}`, now, async (step, seed) => {
      const value = await runner.command({ module: description.id, command: name, args, who: caller ?? defaultWho, by, seed, step, room: seen });
      effects.push(...value.effects);
      refused.push(...value.refused);
      failures.push(...value.failures);
      if (value.outcome.status !== "ok") return { ok: false, value };
      const result = value.outcome.result;
      const more = typeof result === "object" && result !== null && !Array.isArray(result) && result.more === true;
      return { ok: true, value: value.outcome, more };
    });
    const called = report({ effects, refused, failures });
    if (run.kind === "first") return { ...called, outcome: run.value.outcome, steps: 0, stopped: null };
    if (run.steps === 1 && run.stopped === null) return { ...called, outcome: run.last, steps: 1, stopped: null };
    // A command that asked for more is answered as the engine answers it: its last step's text, and its data wrapped.
    const last = run.last.result;
    const record = typeof last === "object" && last !== null && !Array.isArray(last) ? last : {};
    const answer = commandAnswer(
      { text: typeof record.text === "string" ? record.text : null, data: record.data === undefined ? null : (record.data as Json) },
      run.steps,
      run.stopped,
    );
    const result = { ...(answer.text === null ? {} : { text: answer.text }), data: answer.data };
    return { ...called, outcome: { status: "ok", result }, steps: run.steps, stopped: run.stopped };
  }

  return {
    get id() {
      return description.id;
    },
    get description() {
      return description;
    },
    get forms() {
      return forms;
    },
    get checkpoint() {
      return runner.checkpointOf(description.id);
    },
    async turnStart(input) {
      const turn = input.turn ?? lastTurn + 1;
      lastTurn = turn;
      const value = await runner.turnStart({
        seed: input.seed ?? `${seedPrefix}:${turn}:turnStart`,
        text: input.text,
        who: input.who ?? defaultWho,
        ...snapshot({ turn, ...(input.variables ? { variables: input.variables } : {}), ...(input.clock !== undefined ? { clock: input.clock } : {}) }),
      });
      return { ...report(value), clock: value.clock?.reading ?? null };
    },
    async toolUse(calls, caller, room) {
      const event = {
        ...snapshot(room),
        who: caller ?? defaultWho,
        calls: calls.map((call, index) => ({ id: call.id ?? `call-${index}`, name: call.name, args: call.args ?? {} })),
      };
      const value = await runner.toolUse(event);
      const verdicts = event.calls.map((call) => {
        const denial = value.effects.find((effect) => effect.kind === "deny" && effect.callId === call.id);
        return denial?.kind === "deny" ? denial.reason : (true as const);
      });
      return { ...report(value), verdicts };
    },
    async replyPhase(input) {
      const turn = input.turn ?? Math.max(lastTurn, 1);
      const value = await runner.replyPhase({
        ...snapshot({ turn, ...(input.variables ? { variables: input.variables } : {}), ...(input.clock !== undefined ? { clock: input.clock } : {}) }),
        seed: input.seed ?? `${seedPrefix}:${turn}:replyPhase`,
        reply: input.reply,
        rolls: input.rolls ?? [],
        clockAdvances: input.clockAdvances ?? [],
        variableWrites: input.variableWrites ?? [],
        who: input.who ?? defaultWho,
      });
      return report(value);
    },
    command(name, args = {}, caller, room) {
      return runCommand("member", name, args, caller, room);
    },
    async text(line, caller, room) {
      const split = splitLine(line);
      const forWord = split === null ? undefined : candidates.get(split.word);
      if (split === null || forWord === undefined) return { ...notRun<TextRefusal>({ status: "refused", reason: "text", code: "no_form" }), matched: null };
      const best = pickForm(forWord, split.rest);
      if (best === null) {
        return { ...notRun<TextRefusal>({ status: "refused", reason: "text", code: "usage", forms: forWord.map((candidate) => candidate.form.source) }), matched: null };
      }
      const { command, params, form } = best.candidate;
      const args = formArgs(best.captured, params) as JsonObject;
      return { ...(await runCommand("member", command, args, caller, room)), matched: { command, form: form.source, args } };
    },
    keeperCommand(name, args = {}, caller, room) {
      return runCommand("keeper", name, args, caller, room);
    },
    async view(name, caller, room) {
      const rendered = await renderFor(caller ?? defaultWho, room, name);
      const found = rendered.viewers[0]?.views.find((entry) => entry.view === name);
      if (!found) throw new Error(`test host: no view "${name}"`);
      if ("error" in found) throw new Error(`test host: view "${name}" failed — ${found.error}`);
      return found.data;
    },
    async available(name, caller, room) {
      const viewer = caller ?? defaultWho;
      const command = description.commands.find((entry) => entry.name === name);
      if (!command) throw new Error(`test host: no command "${name}"`);
      if (!mayUse(command.role, viewer)) return "role";
      const answer = await runner.available({ module: description.id, command: name, who: viewer, room: snapshot(room) });
      if ("error" in answer) throw new Error(`test host: available() of "${name}" failed — ${answer.error}`);
      return answer.value;
    },
    async characters(room) {
      const rendered = await renderFor(defaultWho, room);
      const found = rendered.characters[0];
      if (!found) return [];
      if ("error" in found) throw new Error(`test host: characters() failed — ${found.error}`);
      return found.characters;
    },
    async clock(room) {
      const rendered = await renderFor(defaultWho, room);
      const found = rendered.clock;
      if (found === null) return null;
      if ("error" in found) throw new Error(`test host: clock() failed — ${found.error}`);
      return found.reading;
    },
    async restart() {
      const text = runner.checkpointText(description.id);
      const module = options.fresh ? await options.fresh() : definition;
      start(module, text === null ? undefined : (JSON.parse(text) as Json));
    },
  };
}
