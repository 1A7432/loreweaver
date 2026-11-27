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
// checkpoint after them, whatever the handler did — after each of them, except that the
// views read for one viewer in one render share one restore (see `ViewSpec.for`).

/** Anything that survives `JSON.stringify` unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON object. */
export type JsonObject = { [key: string]: Json };

/** A member's standing in the room. */
export type Role = "player" | "admin" | "observer";

/**
 * Who a call concerns. Seating is engine data: a module asks for a seat with `fx.seat` and
 * reads the result here; it never keeps seats of its own.
 */
export interface Who {
  /** The member, or null when nobody in particular (the Keeper, the engine). */
  readonly member: { readonly id: string; readonly name: string; readonly role: Role } | null;
  /**
   * The character that member plays, or null: a member with no character is a spectator. One
   * of THIS module's characters carries the module's own id for it; any other character
   * carries the id the engine knows it by (another module's as `<module>:<id>`).
   */
  readonly character: { readonly id: string; readonly name: string } | null;
}

/** One member of the room: every key of the room, whether or not its holder is connected. */
// A type alias, not an interface, so a module can return the members inside a view's data.
export type RoomMember = {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
};

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
  /**
   * Seat a member (a member id of `room.members`) on one of this module's characters (its own
   * id, as `characters()` lists it once this call has ended), or with `null` unseat them from
   * one of this module's characters. Applied with the call's other effects, or refused and
   * reported to the operator. Not in `toolUse`.
   */
  seat(member: string, character: string | null): void;
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
  /**
   * Every member of the room (every key of the room, connected or not), in a stable order.
   * At most 256: a room past that sends the first 256 and tells the operator.
   */
  readonly members: readonly RoomMember[];
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
  /**
   * Short lines of where and how the character is ("in the village head's house", "lightly
   * wounded"): shown beside its name wherever an engine character's status effects are, and
   * told to the Keeper. Up to 12 lines of 1 to 80 characters each.
   */
  readonly status?: readonly string[];
}

/**
 * What a command's `run` answers to whoever ran it, and to nobody else: the member who used
 * it, or the Keeper (as its tool result) when the Keeper ran it.
 */
export interface CommandResult {
  readonly text?: string;
  readonly data?: Json;
  /**
   * Ask to be called again: the engine applies this call's effects, keeps its checkpoint and
   * calls `run` again with the same arguments and the next `call.step`, until a result without
   * `more` or the engine's limit on steps or on time.
   */
  readonly more?: true;
}

type Awaitable<T> = T | Promise<T>;

/**
 * Who may run a command. `player` (default): players and admins, and the Keeper. `admin`:
 * admins only — never the Keeper. `keeper`: the Keeper's; never shown to a player, and among
 * members only an admin may run it.
 */
export type CommandRole = "player" | "admin" | "keeper";

/** Who is running a command now, and the call's seed. */
export interface CommandOrigin {
  /** The Keeper (its `run_command` tool, during a turn) or a member. */
  readonly by: "keeper" | "member";
  /**
   * Derived from persisted inputs only, as an event's seed is: the same call replayed over
   * the same room state gets the same seed. `fx.roll` already derives its dice from it.
   */
  readonly seed: string;
  /**
   * 0 for a command's first call; 1, 2, … for the calls a result with `more: true` asked for.
   * Every step is a call of its own, with its own seed.
   */
  readonly step: number;
}

/** What `create` and `load` are given: the same for every load of one life of the room. */
export interface ModuleInit {
  /** The module entry's `options` in the pack's manifest; `{}` when it declares none. */
  readonly options: JsonObject;
  /**
   * Derived from the room, its generation and the module id: the same whenever this life of
   * the room loads the module, a different one after a reset or an undo starts a new one.
   */
  readonly seed: string;
}

export interface CommandSpec {
  readonly title: string;
  readonly description?: string;
  /**
   * JSON Schema (an object schema) for the arguments. The engine checks the arguments
   * against it before `run` is called, whoever runs the command (see the README for the
   * keywords it applies); without it, any JSON object is taken.
   */
  readonly params?: JsonObject;
  /**
   * Text forms a member types, such as `"attack {target}"` or `"say {text...}"`: the first word
   * is the command word, later tokens are literal words, `{name}` (one word) or, last only,
   * `{name...}` (the rest of the line). Every `name` is a property of `params`. See the README.
   */
  readonly text?: readonly string[];
  /** Who may run it; see `CommandRole`. Default `player`. */
  readonly role?: CommandRole;
  /**
   * `false`: a member's own verb that the Keeper never runs — left out of the Keeper's command
   * list and refused to its tools, like an `admin` command. Default `true`. Not allowed on a
   * `keeper` command.
   */
  readonly keeper?: boolean;
  /**
   * Destructive or hard to take back (it wipes a tracker, ends a scene). A client asks the
   * person before running it — and a pack's own page cannot answer that question for them.
   * It changes nothing about who may run the command or how the engine runs it.
   */
  readonly danger?: boolean;
  /**
   * Read-only. `true`, or a reason shown to that member. Asked at the moment of use only —
   * never when views are rendered — from the point of view of the member the action belongs
   * to (when the Keeper runs the command, `who` is the member whose turn it is).
   */
  available?(who: Who, room: RoomSnapshot): Awaitable<true | string>;
  /**
   * Mutating. `who` is the member the action belongs to — when the Keeper runs the command,
   * the member who spoke this turn (or nobody). `call.by` says who is running it.
   */
  run(args: JsonObject, who: Who, fx: PhaseEffects, room: RoomSnapshot, call: CommandOrigin): Awaitable<CommandResult | void>;
}

export interface ViewSpec {
  readonly title?: string;
  /** JSON Schema of the data `for` returns. */
  readonly schema: JsonObject;
  /**
   * Read-only: the view's data as this viewer may see it. Computed only for viewers who asked
   * for the view. The views read for one viewer in one render share one restore: the module
   * is restored from its checkpoint after that viewer's last view, not after each.
   */
  for(who: Who, room: RoomSnapshot): Awaitable<Json>;
}

/** A module's definition, as its entry file's default export. */
export interface ModuleDefinition {
  /** Stable id, `[a-z][a-z0-9_]*`; a module's commands and views are namespaced `<id>/<name>`. */
  readonly id: string;
  /** A fresh room: build the initial state. */
  create?(init: ModuleInit): void;
  /** Restore from a value `save` returned earlier. */
  load?(snapshot: Json, init: ModuleInit): void;
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
