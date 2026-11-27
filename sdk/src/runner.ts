// The module runner: performs ONE call into a room's modules and reports what came of
// it. The server's room worker and the authors' test host both run modules through this
// file, so a module behaves the same under `bun test` as in a room.
//
// What the runner guarantees, per module and per call:
// - effects are recorded as data, never applied; a call that throws loses them;
// - after a successful MUTATING call, `save()` becomes the checkpoint, through JSON text
//   and back, so what is kept is exactly what a restart would load;
// - a mutating call that throws is followed by a reload from the last checkpoint;
// - every READ-ONLY call is followed by a reload from the last checkpoint, whatever its
//   handler did, and takes no checkpoint — in a render, once per viewer, after all of that
//   viewer's views were read (a read that changes state can colour that viewer's next
//   views, never another viewer's; nothing survives the render);
// - one module's failure never touches another module's call.
// It does not guard against a module that never returns: the host ends the whole thread.
//
// Every handler gets its own structured clone of the event and of the room snapshot:
// one module writing to `event.variables` cannot change what the next module sees, and
// nothing a module does to its copy reaches the engine. Cloning rather than freezing,
// because modules are strict-mode code where a write to a frozen object THROWS: a
// harmless scribble would fail the whole call. The engine caps the snapshot's size, which
// bounds what the copies cost.
//
// Everything this file returns is plain JSON-shaped data, safe to structured-clone across
// a thread boundary. It runs no dice of its own: the host injects the engine's.
import type {
  ClockReading,
  CommandOrigin,
  CommandResult,
  CommandSpec,
  Effects,
  Json,
  JsonObject,
  ModuleDefinition,
  ModuleInit,
  ReplyPhaseEvent,
  RoomSnapshot,
  RollResult,
  ToolUseEvent,
  TurnStartEvent,
  ViewSpec,
  Who,
} from "./module.ts";

export type EffectKind = "fact" | "inject" | "setVar" | "blocks" | "roll" | "deny" | "seat" | "log";

export type Effect =
  | {
      readonly module: string;
      readonly kind: "fact";
      readonly text?: string;
      readonly data?: Json;
      readonly to: "table" | "keeper";
      readonly importance: "low" | "normal" | "high";
      readonly narrateNow: boolean;
    }
  | { readonly module: string; readonly kind: "inject"; readonly text: string }
  | { readonly module: string; readonly kind: "setVar"; readonly path: string; readonly value: Json }
  | { readonly module: string; readonly kind: "blocks"; readonly blocks: Json[]; readonly id?: string }
  | {
      readonly module: string;
      readonly kind: "roll";
      readonly notation: string;
      readonly label?: string;
      readonly total: number;
      readonly text: string;
    }
  | { readonly module: string; readonly kind: "deny"; readonly callId: string; readonly reason: string }
  /**
   * `character` is the module's own id for one of its characters, or null to unseat. `name` is
   * that character's name in the module's `characters()` read right after the call succeeded,
   * or null when that list does not offer it (or `character` is null).
   */
  | { readonly module: string; readonly kind: "seat"; readonly member: string; readonly character: string | null; readonly name: string | null }
  | { readonly module: string; readonly kind: "log"; readonly text: string };

/**
 * Why an effect was dropped inside the worker: `wrong_place` — not allowed in this kind
 * of call; `not_json` — its value cannot be held as JSON; `bad_argument` — an argument of
 * the wrong type; `after_call` — used after the call had already ended.
 */
export type RefusalReason = "wrong_place" | "not_json" | "bad_argument" | "after_call";

export interface Refusal {
  readonly module: string;
  readonly kind: EffectKind;
  readonly reason: RefusalReason;
}

export interface Failure {
  readonly module: string;
  readonly error: string;
}

/** What the injected dice return for one notation. */
export interface DiceOutcome {
  readonly total: number;
  readonly text: string;
}

/**
 * Rolls `notation` with randomness derived from `seed` alone, so the same seed replays the
 * same roll. Throws on notation it cannot roll.
 */
export type DiceRoller = (notation: string, seed: string) => DiceOutcome;

export interface CommandDescription {
  readonly name: string;
  readonly title: Json;
  readonly description: Json;
  readonly params: Json;
  readonly text: Json;
  readonly role: Json;
  /** Whether it declared `danger: true`. */
  readonly danger: boolean;
  /** False when it declared `keeper: false`: a member's verb the Keeper never runs. */
  readonly keeper: Json;
  /** Whether it defines `available`. */
  readonly available: boolean;
}

export interface ViewDescription {
  readonly name: string;
  readonly title: Json;
  readonly schema: Json;
}

/**
 * A module's static description, read once at load. Values are as the module wrote them
 * (made JSON); the engine validates names, sizes and shapes before using any of it.
 */
export interface ModuleDescription {
  readonly id: string;
  readonly path: string;
  readonly events: { readonly turnStart: boolean; readonly toolUse: boolean; readonly replyPhase: boolean };
  readonly commands: readonly CommandDescription[];
  readonly views: readonly ViewDescription[];
  /** Whether it defines `clock`, claiming the room's clock. */
  readonly clock: boolean;
  /** Whether it defines `characters`. */
  readonly characters: boolean;
}

export interface LoadValue {
  /** In dispatch order. */
  readonly modules: readonly ModuleDescription[];
  /** Checkpoints of the modules that were just created fresh (and define `save`). */
  readonly checkpoints: Readonly<Record<string, Json>>;
}

export interface CallValue {
  /** Effects of the calls that succeeded, in module order, each module's in call order. */
  readonly effects: readonly Effect[];
  /** New checkpoints, by module id, of the modules whose mutating call succeeded. */
  readonly checkpoints: Readonly<Record<string, Json>>;
  /** Calls that threw (effects dropped, state rolled back) and restores that failed. */
  readonly failures: readonly Failure[];
  /** Effects dropped inside the worker. */
  readonly refused: readonly Refusal[];
  /**
   * Modules whose restore itself failed: their memory is in an unknown state, so they are
   * skipped until the modules are loaded again. A host should restart the worker.
   */
  readonly broken: readonly string[];
}

export interface TurnStartValue extends CallValue {
  /** The clock reading the turn-start handlers were given, when a module claims the clock. */
  readonly clock: { readonly module: string; readonly reading: Json } | null;
}

export interface CommandRequest {
  readonly module: string;
  readonly command: string;
  readonly args: JsonObject;
  /** The member the action belongs to: when the Keeper runs it, the member who spoke this turn. */
  readonly who: Who;
  /** Who is running it: the Keeper, or the member in `who`. The role is checked against this. */
  readonly by: CommandOrigin["by"];
  /** Derived from persisted inputs only; handed to `run` as `call.seed`, and the dice derive from it. */
  readonly seed: string;
  /**
   * 0 for the command's first call, then 1, 2, … for the calls a `more: true` asked for
   * (`call.step`). `available` is asked at step 0 only: a later step goes on with an action
   * that was already allowed.
   */
  readonly step: number;
  /** The room when the command is used: the same copy for `available` and `run`. */
  readonly room: RoomSnapshot;
}

export type CommandOutcome =
  | { readonly status: "ok"; readonly result: Json }
  | { readonly status: "refused"; readonly reason: "unknown" | "role" }
  | { readonly status: "refused"; readonly reason: "unavailable"; readonly text: Json }
  | { readonly status: "failed"; readonly error: string };

export interface CommandValue extends CallValue {
  readonly outcome: CommandOutcome;
}

/** One module view, by module id and view name. */
export interface ViewRef {
  readonly module: string;
  readonly view: string;
}

/** One viewer of a render and the module views that viewer asked for. */
export interface ViewerRequest {
  readonly who: Who;
  /** Only these are computed for this viewer; a view named twice is computed once. */
  readonly views: readonly ViewRef[];
}

export interface RenderRequest {
  readonly viewers: readonly ViewerRequest[];
  /** The room, once for every viewer. */
  readonly room: RoomSnapshot;
}

export type ViewRender =
  | { readonly module: string; readonly view: string; readonly data: Json }
  | { readonly module: string; readonly view: string; readonly error: string };

export interface ViewerRender {
  /** The views asked for this viewer, in module order, then in the order the module declares them. */
  readonly views: readonly ViewRender[];
}

/**
 * Something the operator should know of a module that is no failure of the call.
 * `read_changed_state`: reading views changed the module's state (its `save()` differed from
 * its checkpoint after a viewer's views); the render's results were used. Said once per
 * module for the life of the runner.
 */
export interface Notice {
  readonly module: string;
  readonly code: "read_changed_state";
}

export interface RenderValue {
  /** One entry per requested viewer, in request order. */
  readonly viewers: readonly ViewerRender[];
  readonly characters: readonly (
    | { readonly module: string; readonly characters: Json }
    | { readonly module: string; readonly error: string }
  )[];
  readonly clock: { readonly module: string; readonly reading: Json } | { readonly module: string; readonly error: string } | null;
  /** Restores that failed. */
  readonly failures: readonly Failure[];
  readonly broken: readonly string[];
  readonly notices: readonly Notice[];
}

/** What a module entry brings to a load besides its definition. */
export interface LoadEntry {
  readonly path: string;
  readonly definition: unknown;
  /** The manifest's `options` for this module; `{}` when absent. */
  readonly options?: JsonObject;
}

/** A one-off `available` read, as the test host asks it. */
export interface AvailableRequest {
  readonly module: string;
  readonly command: string;
  readonly who: Who;
  readonly room: RoomSnapshot;
}

/** Module ids, command names and view names. */
export const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A usable name: matches `NAME_PATTERN` and is not something every object already has
 * (`constructor`), so a lookup by that name can only find what the module declared.
 */
export function isValidName(name: unknown): name is string {
  return typeof name === "string" && NAME_PATTERN.test(name) && !(name in Object.prototype);
}

/**
 * Whether the member `who` may use a command declared with `role`. An admin may use every
 * command — a `keeper` one too: it is how a person repairs what the Keeper got wrong (the
 * owner's ruling). No other member may use a `keeper` command.
 */
export function mayUse(role: unknown, who: Who): boolean {
  const member = who.member;
  if (member === null) return false;
  if (member.role === "admin") return true;
  return member.role === "player" && (role === undefined || role === "player");
}

/**
 * Whether the Keeper may run a command declared with `role` and `keeper`: `player` and
 * `keeper` commands, whoever spoke; never an `admin` one, nor one that declared `keeper: false`.
 */
export function keeperMayRun(role: unknown, keeper: unknown): boolean {
  return keeper !== false && (role === undefined || role === "player" || role === "keeper");
}

/**
 * Whether a command declared with `role` (and `keeper`) may be run by `by`. The Keeper:
 * `keeperMayRun`. A member is `mayUse` (so an admin runs anything, and then `by` is `"member"`).
 */
export function mayRun(role: unknown, by: CommandOrigin["by"], who: Who, keeper?: unknown): boolean {
  if (by === "keeper") return keeperMayRun(role, keeper);
  return by === "member" && mayUse(role, who);
}

type Context = "turnStart" | "toolUse" | "replyPhase" | "command" | "readOnly";

const ALLOWED: Readonly<Record<Context, ReadonlySet<EffectKind>>> = {
  turnStart: new Set(["fact", "inject", "setVar", "blocks", "roll", "seat", "log"]),
  toolUse: new Set(["deny", "log"]),
  replyPhase: new Set(["fact", "setVar", "blocks", "roll", "seat", "log"]),
  command: new Set(["fact", "setVar", "blocks", "roll", "seat", "log"]),
  readOnly: new Set(),
};

/** The most steps one command runs: its first call and the calls `more: true` asked for. */
export const MAX_COMMAND_STEPS = 8;
/** Wall time from a command's first call past which no further step is started, in ms. */
export const MAX_COMMAND_TOTAL_MS = 20_000;

/** Why a stepped command ended before a result without `more`: the step limit, the time limit, or a step that failed. */
export type StepStop = "steps" | "time" | "failed";

/** The seed of one step: the first call's own, then one derived from it and the step, so a replay is the same. */
export function stepSeed(seed: string, step: number): string {
  return step === 0 ? seed : `${seed}:step:${step}`;
}

/** One step as the loop sees it: completed (asking for `more` or not), or not completed. */
export type StepResult<T, F> = { readonly ok: true; readonly value: T; readonly more: boolean } | { readonly ok: false; readonly value: F };

export type SteppedRun<T, F> =
  /** The first call did not complete: what it gave instead (a refusal, a failure). */
  | { readonly kind: "first"; readonly value: F }
  /** At least one step completed: the last one's value, how many completed, and why the loop was cut (null: it ended by itself). */
  | { readonly kind: "ended"; readonly last: T; readonly steps: number; readonly stopped: StepStop | null };

/**
 * The step loop of one command, as the engine and the test host both run it: `run` is called
 * with step 0, 1, 2, … and each step's seed until a step completes without `more`, a step does
 * not complete, `MAX_COMMAND_STEPS` steps have completed, or `MAX_COMMAND_TOTAL_MS` has passed
 * since the first step began (checked before each further step: a step that has started is
 * not cut, the call limit bounds it). A step that does not complete loses only itself.
 */
export async function runSteps<T, F>(seed: string, now: () => number, run: (step: number, seed: string) => Promise<StepResult<T, F>>): Promise<SteppedRun<T, F>> {
  const started = now();
  let last: T | undefined;
  let steps = 0;
  for (;;) {
    const result = await run(steps, stepSeed(seed, steps));
    if (!result.ok) return last === undefined ? { kind: "first", value: result.value } : { kind: "ended", last, steps, stopped: "failed" };
    last = result.value;
    steps += 1;
    if (!result.more) return { kind: "ended", last, steps, stopped: null };
    if (steps >= MAX_COMMAND_STEPS) return { kind: "ended", last, steps, stopped: "steps" };
    if (now() - started >= MAX_COMMAND_TOTAL_MS) return { kind: "ended", last, steps, stopped: "time" };
  }
}

/** The `data` a stepped command answers with: how many steps ran, the last step's data, and why it was cut. */
// A type alias, not an interface, so it is a `Json` value as it is.
export type SteppedData = {
  readonly steps: number;
  /** The last completed step's `data`; null when it gave none. */
  readonly data: Json | null;
  /** Absent when the command ended by itself. */
  readonly stopped?: StepStop;
};

/**
 * What the caller of a command is answered: the last completed step's `text` and `data`.
 * A command that never asked for `more` answers exactly that; one that did has its `data`
 * wrapped (`SteppedData`) to say how many steps ran and why it stopped when it was cut.
 */
export function commandAnswer(last: { readonly text: string | null; readonly data: Json | null }, steps: number, stopped: StepStop | null): { readonly text: string | null; readonly data: Json | null } {
  if (steps === 1 && stopped === null) return last;
  const data: SteppedData = { steps, data: last.data, ...(stopped === null ? {} : { stopped }) };
  return { text: last.text, data };
}

/**
 * `who` as module `module` sees it: one of its own characters by the module's own id; every
 * other character by the id the engine knows it by (another module's is `<module>:<id>`).
 */
export function localWho(who: Who, module: string): Who {
  const character = who.character;
  const prefix = `${module}:`;
  if (character === null || typeof character.id !== "string" || !character.id.startsWith(prefix)) return who;
  return { member: who.member, character: { id: character.id.slice(prefix.length), name: character.name } };
}

interface Instance {
  readonly id: string;
  readonly path: string;
  readonly definition: ModuleDefinition;
  /** What every `create` and `load` of this module is given. */
  readonly init: ModuleInit;
  /** The last checkpoint as JSON text; null when there is none (fresh, or no `save`). */
  checkpoint: string | null;
  broken: boolean;
}

interface Accumulator {
  effects: Effect[];
  checkpoints: Record<string, Json>;
  failures: Failure[];
  refused: Refusal[];
  broken: string[];
}

function accumulator(): Accumulator {
  return { effects: [], checkpoints: {}, failures: [], refused: [], broken: [] };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The value through JSON text and back, or undefined when JSON cannot hold it. */
function toJson(value: unknown): Json | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : (JSON.parse(text) as Json);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

class Recorder {
  readonly effects: Effect[] = [];
  readonly refused: Refusal[] = [];
  readonly fx: Effects;
  #open = true;
  #ordinal = 0;

  constructor(module: string, context: Context, seed: string, dice: DiceRoller) {
    const allowed = ALLOWED[context];
    const record = (kind: EffectKind, build: () => Effect | RefusalReason): void => {
      if (!this.#open) this.refused.push({ module, kind, reason: "after_call" });
      else if (!allowed.has(kind)) this.refused.push({ module, kind, reason: "wrong_place" });
      else {
        const built = build();
        if (typeof built === "string") this.refused.push({ module, kind, reason: built });
        else this.effects.push(built);
      }
    };
    this.fx = {
      fact: (fact, options) => {
        record("fact", () => {
          if (!isObject(fact)) return "bad_argument";
          const text = own(fact, "text");
          if (text !== undefined && typeof text !== "string") return "bad_argument";
          const rawData = own(fact, "data");
          const data = rawData === undefined ? undefined : toJson(rawData);
          if (rawData !== undefined && data === undefined) return "not_json";
          const opts = isObject(options) ? options : {};
          const to = own(opts, "to") ?? "table";
          const importance = own(opts, "importance") ?? "normal";
          const narrateNow = own(opts, "narrateNow") ?? false;
          if ((to !== "table" && to !== "keeper") || (importance !== "low" && importance !== "normal" && importance !== "high")) {
            return "bad_argument";
          }
          if (typeof narrateNow !== "boolean") return "bad_argument";
          return {
            module,
            kind: "fact",
            ...(text === undefined ? {} : { text }),
            ...(data === undefined ? {} : { data }),
            to,
            importance,
            narrateNow,
          };
        });
      },
      inject: (text) => {
        record("inject", () => (typeof text === "string" ? { module, kind: "inject", text } : "bad_argument"));
      },
      setVar: (path, value) => {
        record("setVar", () => {
          if (typeof path !== "string") return "bad_argument";
          const json = toJson(value);
          return json === undefined ? "not_json" : { module, kind: "setVar", path, value: json };
        });
      },
      blocks: (blocks, options) => {
        record("blocks", () => {
          if (!Array.isArray(blocks)) return "bad_argument";
          const id = isObject(options) ? own(options, "id") : undefined;
          if (id !== undefined && typeof id !== "string") return "bad_argument";
          const json = toJson(blocks);
          if (!Array.isArray(json)) return "not_json";
          return { module, kind: "blocks", blocks: json, ...(id === undefined ? {} : { id }) };
        });
      },
      roll: (notation, label) => {
        if (typeof notation !== "string") throw new TypeError("fx.roll: notation must be a string");
        // Per module and per call: a sibling's rolls never shift this module's dice.
        const outcome = dice(notation, `${seed}:${module}:${this.#ordinal++}`);
        const result: RollResult = {
          notation,
          ...(typeof label === "string" ? { label } : {}),
          total: outcome.total,
          text: outcome.text,
        };
        record("roll", () => ({ module, kind: "roll", ...result }));
        return result;
      },
      deny: (callId, reason) => {
        record("deny", () =>
          typeof callId === "string" && typeof reason === "string" ? { module, kind: "deny", callId, reason } : "bad_argument",
        );
      },
      // The name is filled in once the call has succeeded, from `characters()` as it then reads.
      seat: (member, character) => {
        record("seat", () =>
          typeof member === "string" && (character === null || typeof character === "string")
            ? { module, kind: "seat", member, character, name: null }
            : "bad_argument",
        );
      },
      log: (text) => {
        record("log", () => (typeof text === "string" ? { module, kind: "log", text } : "bad_argument"));
      },
    };
  }

  /** The call has ended: anything recorded from now on was stashed and used late. */
  close(): void {
    this.#open = false;
  }
}

function describe(instance: Instance): ModuleDescription {
  const definition = instance.definition;
  const on = isObject(definition.on) ? definition.on : {};
  const commands = table(instance.id, "commands", definition.commands, (name, spec) => {
    if (typeof own(spec, "run") !== "function") throw new Error(`module "${instance.id}": command "${name}" has no run()`);
    const available = own(spec, "available");
    if (available !== undefined && typeof available !== "function") {
      throw new Error(`module "${instance.id}": command "${name}": available is not a function`);
    }
    return {
      name,
      title: toJson(own(spec, "title")) ?? null,
      description: toJson(own(spec, "description")) ?? null,
      params: toJson(own(spec, "params") ?? { type: "object" }) ?? null,
      text: toJson(own(spec, "text") ?? []) ?? null,
      role: toJson(own(spec, "role") ?? "player") ?? null,
      danger: own(spec, "danger") === true,
      keeper: toJson(own(spec, "keeper") ?? true) ?? null,
      available: typeof available === "function",
    } satisfies CommandDescription;
  });
  const views = table(instance.id, "views", definition.views, (name, spec) => {
    if (typeof own(spec, "for") !== "function") throw new Error(`module "${instance.id}": view "${name}" has no for()`);
    return { name, title: toJson(own(spec, "title")) ?? null, schema: toJson(own(spec, "schema")) ?? null } satisfies ViewDescription;
  });
  return {
    id: instance.id,
    path: instance.path,
    events: {
      turnStart: typeof own(on, "turnStart") === "function",
      toolUse: typeof own(on, "toolUse") === "function",
      replyPhase: typeof own(on, "replyPhase") === "function",
    },
    commands,
    views,
    clock: typeof definition.clock === "function",
    characters: typeof definition.characters === "function",
  };
}

/** A module's command or view table, entry by entry; a malformed table fails the load. */
function table<T>(module: string, what: string, value: unknown, entry: (name: string, spec: Record<string, unknown>) => T): T[] {
  if (value === undefined) return [];
  if (!isObject(value)) throw new Error(`module "${module}": ${what} is not an object`);
  return Object.keys(value).map((name) => {
    const spec = value[name];
    if (!isObject(spec)) throw new Error(`module "${module}": ${what} entry "${name}" is not an object`);
    return entry(name, spec);
  });
}

/** The declared command or view by name; never something found on the prototype chain. */
function lookup<T>(value: unknown, name: string): T | undefined {
  if (!isValidName(name) || !isObject(value) || !Object.hasOwn(value, name)) return undefined;
  const spec = value[name];
  return isObject(spec) ? (spec as T) : undefined;
}

function isClockReading(value: Json): value is { time: string; round?: number } {
  if (!isObject(value) || typeof own(value, "time") !== "string") return false;
  const round = own(value, "round");
  return round === undefined || typeof round === "number";
}

export class ModuleRunner {
  readonly #dice: DiceRoller;
  #modules: Instance[] = [];
  /** Modules already reported as `read_changed_state`: once for the life of this runner. */
  readonly #noticed = new Set<string>();

  constructor(options: { readonly dice: DiceRoller }) {
    this.#dice = options.dice;
  }

  /**
   * Take the room's modules, in dispatch order, and bring each to its last checkpoint
   * (`load`) or to a fresh start (`create`). Throws — the whole load fails — on a value
   * that is not a definition, an unusable or repeated id, two modules claiming the clock,
   * a malformed command or view table, or a `create`/`load` that throws. `seed` is the
   * room's (its id and generation); each module's `init.seed` is derived from it and the
   * module id.
   */
  load(entries: readonly LoadEntry[], snapshots: Readonly<Record<string, Json>>, seed = ""): LoadValue {
    const next: Instance[] = [];
    for (const { path, definition, options } of entries) {
      if (!isObject(definition) || typeof definition.id !== "string") {
        throw new Error(`${path}: the default export is not a module definition (use defineModule)`);
      }
      const id = definition.id;
      if (!isValidName(id)) throw new Error(`${path}: module id "${id}" is not a usable name`);
      if (next.some((other) => other.id === id)) throw new Error(`two modules share the id "${id}"`);
      // Through JSON text and back: the module holds its own copy of its options.
      const init: ModuleInit = { options: isObject(options) ? (JSON.parse(JSON.stringify(options)) as JsonObject) : {}, seed: `${seed}:${id}` };
      next.push({ id, path, definition: definition as unknown as ModuleDefinition, init, checkpoint: null, broken: false });
    }
    const claimers = next.filter((instance) => typeof instance.definition.clock === "function");
    if (claimers.length > 1) {
      throw new Error(`modules ${claimers.map((instance) => `"${instance.id}"`).join(" and ")} both claim the room's clock`);
    }
    const modules = next.map(describe);
    const checkpoints: Record<string, Json> = {};
    for (const instance of next) {
      const snapshot = Object.hasOwn(snapshots, instance.id) ? snapshots[instance.id] : undefined;
      try {
        if (snapshot !== undefined) {
          instance.checkpoint = JSON.stringify(snapshot);
          instance.definition.load?.(JSON.parse(instance.checkpoint) as Json, structuredClone(instance.init));
        } else {
          instance.definition.create?.(structuredClone(instance.init));
          // Keep the fresh state at once: a `create` that draws on anything outside the
          // module would otherwise give a different room after every restart.
          this.#checkpoint(instance, checkpoints);
        }
      } catch (error) {
        throw new Error(`module "${instance.id}": ${snapshot === undefined ? "create" : "load"} failed — ${errorText(error)}`);
      }
    }
    this.#modules = next;
    return { modules, checkpoints };
  }

  async turnStart(event: TurnStartEvent): Promise<TurnStartValue> {
    const out = accumulator();
    const handlers = this.#modules.filter((instance) => typeof instance.definition.on?.turnStart === "function");
    let clock: TurnStartValue["clock"] = null;
    let given: ClockReading | null = event.clock;
    const claimer = this.#modules.find((instance) => typeof instance.definition.clock === "function");
    // The clock is read inside the same exchange, so turn start stays one round trip.
    if (claimer && !claimer.broken && handlers.length > 0) {
      const room: RoomSnapshot = { turn: event.turn, variables: event.variables, clock: event.clock, members: event.members };
      const read = await this.#read(claimer, out, () => claimer.definition.clock?.(structuredClone(room)));
      if ("value" in read) {
        clock = { module: claimer.id, reading: read.value };
        if (isClockReading(read.value)) given = read.value;
      } else {
        out.failures.push({ module: claimer.id, error: `clock() failed — ${read.error}` });
      }
    }
    const withClock: TurnStartEvent = { ...event, clock: given };
    const room: RoomSnapshot = { turn: event.turn, variables: event.variables, clock: given, members: event.members };
    for (const instance of handlers) {
      await this.#mutate(instance, "turnStart", event.seed, room, out, (fx) =>
        instance.definition.on?.turnStart?.(structuredClone({ ...withClock, who: localWho(event.who, instance.id) }), fx),
      );
    }
    return { ...out, clock };
  }

  /** Read-only: the module is restored after its handler; its verdicts are its answer. */
  async toolUse(event: ToolUseEvent): Promise<CallValue> {
    const out = accumulator();
    for (const instance of this.#modules) {
      const handler = instance.definition.on?.toolUse;
      if (typeof handler !== "function") continue;
      if (this.#skipBroken(instance, out)) continue;
      const recorder = new Recorder(instance.id, "toolUse", "", this.#dice);
      try {
        await instance.definition.on?.toolUse?.(structuredClone({ ...event, who: localWho(event.who, instance.id) }), recorder.fx);
        recorder.close();
        out.effects.push(...recorder.effects);
      } catch (error) {
        recorder.close();
        out.failures.push({ module: instance.id, error: errorText(error) });
      }
      out.refused.push(...recorder.refused);
      this.#restore(instance, out);
    }
    return out;
  }

  async replyPhase(event: ReplyPhaseEvent): Promise<CallValue> {
    const out = accumulator();
    const room: RoomSnapshot = { turn: event.turn, variables: event.variables, clock: event.clock, members: event.members };
    for (const instance of this.#modules) {
      if (typeof instance.definition.on?.replyPhase !== "function") continue;
      await this.#mutate(instance, "replyPhase", event.seed, room, out, (fx) =>
        instance.definition.on?.replyPhase?.(structuredClone({ ...event, who: localWho(event.who, instance.id) }), fx),
      );
    }
    return out;
  }

  /**
   * One command, run by `by` on behalf of `who`. The role and `available` are checked here, at the moment of
   * use, inside the same exchange; a refused command changes nothing.
   */
  async command(request: CommandRequest): Promise<CommandValue> {
    const out = accumulator();
    const instance = this.#modules.find((candidate) => candidate.id === request.module);
    const spec = instance ? lookup<CommandSpec>(instance.definition.commands, request.command) : undefined;
    if (!instance || !spec || typeof spec.run !== "function") return { ...out, outcome: { status: "refused", reason: "unknown" } };
    if (!mayRun(spec.role, request.by, request.who, spec.keeper)) return { ...out, outcome: { status: "refused", reason: "role" } };
    if (this.#skipBroken(instance, out)) return { ...out, outcome: { status: "failed", error: "module is broken" } };
    const who = localWho(request.who, instance.id);
    if (typeof spec.available === "function" && request.step === 0) {
      const verdict = await this.#read(instance, out, () => spec.available?.(structuredClone(who), structuredClone(request.room)));
      if (!("value" in verdict)) return { ...out, outcome: { status: "failed", error: verdict.error } };
      if (verdict.value !== true) return { ...out, outcome: { status: "refused", reason: "unavailable", text: verdict.value } };
    }
    let result: Json = {};
    const done = await this.#mutate(instance, "command", request.seed, request.room, out, async (fx) => {
      const call: CommandOrigin = { by: request.by, seed: request.seed, step: request.step };
      const value: CommandResult | void = await spec.run(structuredClone(request.args), structuredClone(who), fx, structuredClone(request.room), call);
      if (value === undefined) return;
      const json = toJson(value);
      // Inside the call: an answer JSON cannot carry fails the call like a throw would.
      if (json === undefined) throw new TypeError("run() returned a value that is not JSON");
      result = json;
    });
    return { ...out, outcome: done.ok ? { status: "ok", result } : { status: "failed", error: done.error } };
  }

  /**
   * The read-only outputs: for each viewer, the module views that viewer asked for (and only
   * those: a module none of whose views was asked for is not read for views at all); then
   * every module's characters and the clock. The views of one viewer share one restore,
   * made after that viewer's last view; `characters` and `clock` are restored after each.
   * A command's `available` is not asked here: it is asked at the moment of use.
   */
  async render(request: RenderRequest): Promise<RenderValue> {
    const out = accumulator();
    const notices: Notice[] = [];
    const viewers: ViewerRender[] = request.viewers.map(() => ({ views: [] }));
    const characters: RenderValue["characters"][number][] = [];
    let clock: RenderValue["clock"] = null;
    for (const instance of this.#modules) {
      if (instance.broken) {
        out.failures.push({ module: instance.id, error: "module is broken" });
        continue;
      }
      const definition = instance.definition;
      const viewNames = isObject(definition.views) ? Object.keys(definition.views) : [];
      let compared = false;
      for (const [index, viewer] of request.viewers.entries()) {
        const target = viewers[index];
        if (!target || instance.broken) continue;
        const asked = new Set(viewer.views.filter((ref) => ref.module === instance.id).map((ref) => ref.view));
        const names = viewNames.filter((name) => asked.has(name));
        if (names.length === 0) continue;
        const views = target.views as ViewRender[];
        for (const name of names) {
          const spec = lookup<ViewSpec>(definition.views, name);
          if (!spec || typeof spec.for !== "function") continue;
          const read = await this.#value(() => spec.for(structuredClone(localWho(viewer.who, instance.id)), structuredClone(request.room)));
          views.push("value" in read ? { module: instance.id, view: name, data: read.value } : { module: instance.id, view: name, error: read.error });
        }
        // Once per render, on its first viewer: one `save()` to see whether reading changed
        // the state. Not per read: that would cost what sharing the restore saves.
        if (!compared) {
          compared = true;
          if (!this.#noticed.has(instance.id) && this.#changedSinceCheckpoint(instance)) {
            this.#noticed.add(instance.id);
            notices.push({ module: instance.id, code: "read_changed_state" });
          }
        }
        this.#restore(instance, out);
      }
      if (typeof definition.characters === "function") {
        const read = await this.#read(instance, out, () => definition.characters?.(structuredClone(request.room)));
        characters.push("value" in read ? { module: instance.id, characters: read.value } : { module: instance.id, error: read.error });
      }
      if (typeof definition.clock === "function") {
        const read = await this.#read(instance, out, () => definition.clock?.(structuredClone(request.room)));
        clock = "value" in read ? { module: instance.id, reading: read.value } : { module: instance.id, error: read.error };
      }
    }
    return { viewers, characters, clock, failures: out.failures, broken: out.broken, notices };
  }

  /**
   * One command's `available`, read-only, for the member `who`: what it answers (`true` when
   * the command defines none), or the error it threw. The test host's question; the engine
   * asks `available` only inside `command`, at the moment of use.
   */
  async available(request: AvailableRequest): Promise<{ readonly value: Json } | { readonly error: string }> {
    const out = accumulator();
    const instance = this.#modules.find((candidate) => candidate.id === request.module);
    const spec = instance ? lookup<CommandSpec>(instance.definition.commands, request.command) : undefined;
    if (!instance || !spec) return { error: "unknown command" };
    if (instance.broken) return { error: "module is broken" };
    if (typeof spec.available !== "function") return { value: true };
    return this.#read(instance, out, () => spec.available?.(structuredClone(localWho(request.who, instance.id)), structuredClone(request.room)));
  }

  /** Whether the module's `save()` now differs, as JSON text, from its checkpoint. A `save` that throws counts as no difference. */
  #changedSinceCheckpoint(instance: Instance): boolean {
    if (typeof instance.definition.save !== "function") return false;
    try {
      const saved: unknown = instance.definition.save();
      const text = saved === undefined ? undefined : JSON.stringify(saved);
      return text !== undefined && text !== instance.checkpoint;
    } catch {
      return false;
    }
  }

  /** The current checkpoint of a module as JSON text; null when it has none. */
  checkpointText(module: string): string | null {
    return this.#modules.find((candidate) => candidate.id === module)?.checkpoint ?? null;
  }

  /** The current checkpoint of a module, as JSON; null when it has none. */
  checkpointOf(module: string): Json | null {
    const instance = this.#modules.find((candidate) => candidate.id === module);
    return instance?.checkpoint == null ? null : (JSON.parse(instance.checkpoint) as Json);
  }

  async #mutate(
    instance: Instance,
    context: Context,
    seed: string,
    room: RoomSnapshot,
    out: Accumulator,
    body: (fx: Effects) => unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.#skipBroken(instance, out)) return { ok: false, error: "module is broken" };
    const recorder = new Recorder(instance.id, context, seed, this.#dice);
    const checkpoints: Record<string, Json> = {};
    try {
      await body(recorder.fx);
      recorder.close();
      this.#checkpoint(instance, checkpoints);
    } catch (error) {
      // The call is the unit of atomicity: its effects are dropped AND the module goes
      // back to its last checkpoint, so memory and committed effects cannot disagree.
      recorder.close();
      const text = errorText(error);
      out.failures.push({ module: instance.id, error: text });
      out.refused.push(...recorder.refused);
      this.#restore(instance, out);
      return { ok: false, error: text };
    }
    out.effects.push(...(await this.#resolveSeats(instance, recorder.effects, room, out)));
    out.refused.push(...recorder.refused);
    Object.assign(out.checkpoints, checkpoints);
    return { ok: true };
  }

  /**
   * The names of the characters a successful call asked to seat members on, from the module's
   * `characters()` read on the state the call left (read-only, like any read: the module is
   * restored from the checkpoint the call just made). A character it does not offer then keeps
   * `name: null`, and the engine refuses that seat.
   */
  async #resolveSeats(instance: Instance, effects: readonly Effect[], room: RoomSnapshot, out: Accumulator): Promise<readonly Effect[]> {
    if (!effects.some((effect) => effect.kind === "seat" && effect.character !== null)) return effects;
    const names = new Map<string, string>();
    if (typeof instance.definition.characters === "function") {
      const read = await this.#read(instance, out, () => instance.definition.characters?.(structuredClone(room)));
      if ("value" in read && Array.isArray(read.value)) {
        for (const entry of read.value) {
          if (!isObject(entry)) continue;
          const id = own(entry, "id");
          const name = own(entry, "name");
          if (typeof id === "string" && typeof name === "string" && !names.has(id)) names.set(id, name);
        }
      } else if (!("value" in read)) {
        out.failures.push({ module: instance.id, error: `characters() failed while seating — ${read.error}` });
      }
    }
    return effects.map((effect) =>
      effect.kind === "seat" && effect.character !== null ? { ...effect, name: names.get(effect.character) ?? null } : effect,
    );
  }

  /** A read-only call: its value made JSON, then the module restored, whatever happened. */
  async #read(instance: Instance, out: Accumulator, body: () => unknown): Promise<{ value: Json } | { error: string }> {
    const result = await this.#value(body);
    this.#restore(instance, out);
    return result;
  }

  /** A read's value made JSON, or its error; the caller restores. */
  async #value(body: () => unknown): Promise<{ value: Json } | { error: string }> {
    try {
      const value = toJson(await body());
      return value === undefined ? { error: "returned a value that is not JSON" } : { value };
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  /** Throws when `save` throws or returns nothing JSON can hold: the call then fails. */
  #checkpoint(instance: Instance, checkpoints: Record<string, Json>): void {
    if (typeof instance.definition.save !== "function") return;
    const saved: unknown = instance.definition.save();
    // Through text and back: what is kept is exactly what a restart would load.
    const text = saved === undefined ? undefined : JSON.stringify(saved);
    if (text === undefined) throw new TypeError("save() returned a value that is not JSON");
    instance.checkpoint = text;
    checkpoints[instance.id] = JSON.parse(text) as Json;
  }

  #restore(instance: Instance, out: Accumulator): void {
    try {
      if (instance.checkpoint === null) instance.definition.create?.(structuredClone(instance.init));
      else instance.definition.load?.(JSON.parse(instance.checkpoint) as Json, structuredClone(instance.init));
    } catch (error) {
      instance.broken = true;
      out.failures.push({ module: instance.id, error: `restore failed — ${errorText(error)}` });
      out.broken.push(instance.id);
    }
  }

  #skipBroken(instance: Instance, out: Accumulator): boolean {
    if (!instance.broken) return false;
    out.failures.push({ module: instance.id, error: "module is broken" });
    return true;
  }
}

/** Who nobody in particular is: the Keeper or the engine itself. */
export const NOBODY: Who = { member: null, character: null };

