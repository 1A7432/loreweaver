// The module contract: what a pack's module entry file exports, and what the engine
// hands it. A module never calls the engine. The engine notifies it; it answers through
// the effects object it was given, and those effects are REQUESTS: collected during the
// call, returned when it ends, then validated, capped and applied by the engine. Nothing
// else a module does reaches the room.
//
// Every handler runs in the room's worker thread, one call at a time. The call is the
// unit of atomicity: a call that throws loses its effects and the module is reloaded
// from its last checkpoint (see `save`). Read-only handlers (`toolUse`, `available`,
// views, `characters`, `clock`) leave no trace: the module is restored from its last
// checkpoint after each of them, whatever the handler did.

/** Anything that survives `JSON.stringify` unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON object. */
export type JsonObject = { [key: string]: Json };

/** A member's standing in the room. */
export type Role = "player" | "admin" | "observer";

/** Who a call concerns. Seating is engine data: a module never keeps its own. */
export interface Who {
  /** The member, or null when nobody in particular (the Keeper, the engine). */
  readonly member: { readonly id: string; readonly name: string; readonly role: Role } | null;
  /** The character that member plays, or null: a member with no character is a spectator. */
  readonly character: { readonly id: string; readonly name: string } | null;
}

/** The time a room's clock shows. */
// A type alias, not an interface: an alias of an object type is assignable to `Json`,
// so a module can return a clock reading inside a view's data as it is.
export type ClockReading = {
  /** As the table should read it, e.g. "Day 3, dusk". */
  readonly time: string;
  /** A round counter, for rooms that keep one. */
  readonly round?: number;
};

/** One die roll as the table sees it. */
export interface RollResult {
  /** The notation that was rolled, as written. */
  readonly notation: string;
  readonly label?: string;
  readonly total: number;
  /** The roll in one line of notation and faces, ending in `= total`. */
  readonly text: string;
}

export interface FactOptions {
  /** `table` (default): shown to everyone when it has text. `keeper`: only the Keeper's prompt. */
  readonly to?: "table" | "keeper";
  /** Default `normal`. */
  readonly importance?: "low" | "normal" | "high";
  /** Ask the engine to open a Keeper turn over the pending facts. */
  readonly narrateNow?: boolean;
}

export interface Fact {
  readonly text?: string;
  readonly data?: Json;
}

export interface BlockOptions {
  /** A stable id: a later emission with the same id replaces this one. */
  readonly id?: string;
}

/**
 * The way out of a handler. Every method records a request; nothing is applied until the
 * call has succeeded, and the engine may still drop what is over its limits. An effect
 * used where it does not belong is dropped and reported to the operator; it never throws.
 */
export interface Effects {
  /** Add to the narration feed. */
  fact(fact: Fact, options?: FactOptions): void;
  /** Add a section to THIS turn's Keeper prompt. `turnStart` only. */
  inject(text: string): void;
  /** Request a write to a room variable. */
  setVar(path: string, value: Json): void;
  /** Set declarative blocks into the story. */
  blocks(blocks: readonly Json[], options?: BlockOptions): void;
  /**
   * Roll the engine's dice now. The result comes back at once and is also recorded, so the
   * table sees real dice. The same call replays the same rolls. Throws on bad notation.
   */
  roll(notation: string, label?: string): RollResult;
  /** Refuse one of this round's tool calls. `toolUse` only. */
  deny(callId: string, reason: string): void;
  /** A line for the operator's log; never shown at the table. */
  log(text: string): void;
}

/** What `turnStart` may use. */
export type TurnStartEffects = Omit<Effects, "deny">;
/** What `toolUse` may use: it is read-only, so only its verdicts and the log. */
export type ToolUseEffects = Pick<Effects, "deny" | "log">;
/** What `replyPhase` and a command's `run` may use. */
export type PhaseEffects = Omit<Effects, "inject" | "deny">;

/**
 * The room as it is when this call starts. A copy, made for each module and each call:
 * writing to it changes nothing — not the room, not what another module sees. A module
 * cannot ask the engine for anything, so every call brings it.
 */
export interface RoomSnapshot {
  /** The current turn, counted from 1. */
  readonly turn: number;
  /** The room's variables. */
  readonly variables: JsonObject;
  /** The room's clock, or null when the room keeps none. */
  readonly clock: ClockReading | null;
}

/** Every event is also a room snapshot: `turn`, `variables` and `clock` mean the same in all three. */
export interface TurnStartEvent extends RoomSnapshot {
  /** The turn now starting, counted from 1. */
  readonly turn: number;
  /** Derived from persisted inputs only: the same room state replays the same seed. */
  readonly seed: string;
  /** What was said. */
  readonly text: string;
  readonly who: Who;
  /**
   * The room's clock. When a module claims the clock, this is its `clock()`, read at the
   * start of this same call.
   */
  readonly clock: ClockReading | null;
}

export interface ToolCall {
  /** Unique within the round; what `fx.deny` names. */
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
}

export interface ToolUseEvent extends RoomSnapshot {
  readonly turn: number;
  readonly who: Who;
  /** Every tool call of this round, in call order. */
  readonly calls: readonly ToolCall[];
}

export interface ClockAdvance {
  /** The amount as the Keeper asked for it, e.g. "2 hours". */
  readonly amount: string;
  readonly reason?: string;
}

export interface VariableWrite {
  readonly path: string;
  readonly value: Json;
  /** `keeper`, or the id of the module that wrote it. */
  readonly by: string;
}

export interface ReplyPhaseEvent extends RoomSnapshot {
  readonly turn: number;
  readonly seed: string;
  /** The Keeper's reply, as published. */
  readonly reply: string;
  /** Dice rolled during the turn. */
  readonly rolls: readonly RollResult[];
  readonly clockAdvances: readonly ClockAdvance[];
  readonly variableWrites: readonly VariableWrite[];
  readonly who: Who;
}

export interface Resource {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly max?: number;
}

/** A character a member can be seated as. */
export interface PlayableCharacter {
  readonly id: string;
  readonly name: string;
  readonly blurb?: string;
  readonly resources?: readonly Resource[];
}

/** What a command's `run` answers to the member who used it, and to nobody else. */
export interface CommandResult {
  readonly text?: string;
  readonly data?: Json;
}

type Awaitable<T> = T | Promise<T>;

export interface CommandSpec {
  readonly title: string;
  readonly description?: string;
  /** JSON Schema (an object schema) for the arguments. */
  readonly params?: JsonObject;
  /** Text forms such as `"attack {target}"`; data for the engine's parser. */
  readonly text?: readonly string[];
  /** Who may use it. `player` (default): players and admins. `admin`: admins only. */
  readonly role?: "player" | "admin";
  /** Read-only. `true`, or a reason shown to that viewer. */
  available?(who: Who, room: RoomSnapshot): Awaitable<true | string>;
  /** Mutating. */
  run(args: JsonObject, who: Who, fx: PhaseEffects, room: RoomSnapshot): Awaitable<CommandResult | void>;
}

export interface ViewSpec {
  readonly title?: string;
  /** JSON Schema of the data `for` returns. */
  readonly schema: JsonObject;
  /** Read-only: the view's data as this viewer may see it. */
  for(who: Who, room: RoomSnapshot): Awaitable<Json>;
}

/** A module's definition, as its entry file's default export. */
export interface ModuleDefinition {
  /** Stable id, `[a-z][a-z0-9_]*`; a module's commands and views are namespaced `<id>/<name>`. */
  readonly id: string;
  /** A fresh room: build the initial state. */
  create?(): void;
  /** Restore from a value `save` returned earlier. */
  load?(snapshot: Json): void;
  /**
   * Hand over the module's whole state. Called after every successful mutating call;
   * the value (through JSON text and back) is the checkpoint every rollback, restore and
   * restart loads. A module without `save` keeps no state between calls.
   */
  save?(): Json;
  /** Read-only: the characters members can be seated as. */
  characters?(room: RoomSnapshot): Awaitable<readonly PlayableCharacter[]>;
  /** Read-only. Defining it claims the room's clock; only one module of a room may. */
  clock?(room: RoomSnapshot): Awaitable<ClockReading>;
  readonly on?: {
    turnStart?(event: TurnStartEvent, fx: TurnStartEffects): Awaitable<void>;
    /** Read-only. */
    toolUse?(event: ToolUseEvent, fx: ToolUseEffects): Awaitable<void>;
    replyPhase?(event: ReplyPhaseEvent, fx: PhaseEffects): Awaitable<void>;
  };
  readonly commands?: { readonly [name: string]: CommandSpec };
  readonly views?: { readonly [name: string]: ViewSpec };
}

/**
 * Declare a module. Returns its argument unchanged: the call exists so an entry file is
 * checked against the contract where it is written.
 */
export function defineModule<const T extends ModuleDefinition>(definition: T): T {
  return definition;
}
