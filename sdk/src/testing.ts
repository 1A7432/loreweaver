// The test host: runs one module in-process, through the same runner a room's worker
// uses, so an author can write `bun test` files against it. Fire events, run commands as
// anyone, read views, inspect effects and the checkpoint, and restart the module from
// its checkpoint. Dice are scripted.
//
// What the test host does NOT do is the engine's half: it applies nothing, and it does
// not enforce the engine's size limits (see the README for them). Effects come back
// exactly as the module requested them.
import type { ClockAdvance, ClockReading, Json, JsonObject, ModuleDefinition, Role, RollResult, VariableWrite, Who } from "./module.ts";
import {
  type CallValue,
  type CommandOutcome,
  type DiceRoller,
  type Effect,
  type ModuleDescription,
  ModuleRunner,
  mayUse,
  type Refusal,
} from "./runner.ts";

export type { CommandOutcome, DiceRoller, Effect, ModuleDescription, Refusal };

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
  /** The prefix of the seeds the host derives for each call. Default `test`. */
  readonly seed?: string;
  /**
   * A NEW instance of the module, for `restart()`: e.g.
   * `async () => (await import(\`./my_module.ts?${n++}\`)).default`. Without it, `restart()`
   * reuses the same definition object, so state the module keeps outside what `load`
   * assigns would wrongly survive.
   */
  readonly fresh?: () => ModuleDefinition | Promise<ModuleDefinition>;
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
  readonly logs: readonly string[];
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
}

export interface TestHost {
  readonly id: string;
  /** The static description the engine would read at load. */
  readonly description: ModuleDescription;
  /** The current checkpoint: what a restart would load. */
  readonly checkpoint: Json | null;
  turnStart(input: TurnStartInput): Promise<TestCall & { readonly clock: Json | null }>;
  /** The verdicts, in call order: `true`, or the first denial's reason. */
  toolUse(calls: readonly ToolCallInput[], who?: Who): Promise<TestCall & { readonly verdicts: readonly (true | string)[] }>;
  replyPhase(input: ReplyPhaseInput): Promise<TestCall>;
  /** Runs a command as `who`, with the role and `available` checks the engine makes. */
  command(name: string, args?: JsonObject, who?: Who): Promise<TestCall & { readonly outcome: CommandOutcome }>;
  /** A view's data for `who`; throws when there is no such view or it failed. */
  view(name: string, who?: Who): Promise<Json>;
  /**
   * Whether `who` may use a command: `"role"` when the role forbids it, otherwise what the
   * command's `available` answers (`true` when it has none).
   */
  available(name: string, who?: Who): Promise<Json>;
  characters(): Promise<Json>;
  /** The clock reading, or null when the module does not claim the clock. */
  clock(): Promise<Json | null>;
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

export function createTestHost(definition: ModuleDefinition, options: TestHostOptions = {}): TestHost {
  const dice = scriptedDice(options.dice);
  const defaultWho = options.who ?? who("Player");
  const seedPrefix = options.seed ?? "test";
  let runner = new ModuleRunner({ dice });
  let description: ModuleDescription;
  let lastTurn = 0;

  function start(module: ModuleDefinition, snapshot: Json | undefined): void {
    runner = new ModuleRunner({ dice });
    const loaded = runner.load([{ path: PATH, definition: module }], snapshot === undefined ? {} : { [module.id]: snapshot });
    const first = loaded.modules[0];
    if (!first) throw new Error("test host: the module did not load");
    description = first;
  }
  start(definition, options.snapshot);

  function report(value: CallValue): TestCall {
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
      logs: effects.flatMap((effect) => (effect.kind === "log" ? [effect.text] : [])),
    };
  }

  async function renderFor(viewer: Who) {
    const rendered = await runner.render({ viewers: [viewer] });
    const failure = rendered.failures[0];
    if (failure) throw new Error(`test host: ${failure.error}`);
    return rendered;
  }

  return {
    get id() {
      return description.id;
    },
    get description() {
      return description;
    },
    get checkpoint() {
      return runner.checkpointOf(description.id);
    },
    async turnStart(input) {
      const turn = input.turn ?? lastTurn + 1;
      lastTurn = turn;
      const value = await runner.turnStart({
        turn,
        seed: input.seed ?? `${seedPrefix}:${turn}:turnStart`,
        text: input.text,
        who: input.who ?? defaultWho,
        variables: input.variables ?? {},
        clock: input.clock ?? null,
      });
      return { ...report(value), clock: value.clock?.reading ?? null };
    },
    async toolUse(calls, caller) {
      const event = {
        turn: lastTurn,
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
      const turn = input.turn ?? lastTurn;
      const value = await runner.replyPhase({
        turn,
        seed: input.seed ?? `${seedPrefix}:${turn}:replyPhase`,
        reply: input.reply,
        rolls: input.rolls ?? [],
        clockAdvances: input.clockAdvances ?? [],
        variableWrites: input.variableWrites ?? [],
        who: input.who ?? defaultWho,
      });
      return report(value);
    },
    async command(name, args = {}, caller) {
      const value = await runner.command({
        module: description.id,
        command: name,
        args,
        who: caller ?? defaultWho,
        turn: lastTurn,
        seed: `${seedPrefix}:${lastTurn}:command:${name}`,
      });
      return { ...report(value), outcome: value.outcome };
    },
    async view(name, caller) {
      const rendered = await renderFor(caller ?? defaultWho);
      const found = rendered.viewers[0]?.views.find((entry) => entry.view === name);
      if (!found) throw new Error(`test host: no view "${name}"`);
      if ("error" in found) throw new Error(`test host: view "${name}" failed — ${found.error}`);
      return found.data;
    },
    async available(name, caller) {
      const viewer = caller ?? defaultWho;
      const command = description.commands.find((entry) => entry.name === name);
      if (!command) throw new Error(`test host: no command "${name}"`);
      if (!mayUse(command.role, viewer)) return "role";
      if (!command.available) return true;
      const rendered = await renderFor(viewer);
      const found = rendered.viewers[0]?.available.find((entry) => entry.command === name);
      if (!found) throw new Error(`test host: no verdict for "${name}"`);
      if ("error" in found) throw new Error(`test host: available() of "${name}" failed — ${found.error}`);
      return found.verdict;
    },
    async characters() {
      const rendered = await renderFor(defaultWho);
      const found = rendered.characters[0];
      if (!found) return [];
      if ("error" in found) throw new Error(`test host: characters() failed — ${found.error}`);
      return found.characters;
    },
    async clock() {
      const rendered = await renderFor(defaultWho);
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
