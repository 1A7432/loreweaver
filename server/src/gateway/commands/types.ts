// The shapes of the command layer: a command's spec, the call a handler receives, and what
// a command returns.
//
// One rule decides where an outcome goes (protocol 3.0, decision 28): what happened at the
// table is EVENTS, published to every member; what concerns only the caller — done or not,
// the reason, a query's answer, anything secret — is the RESULT, returned to the caller
// alone. A refusal carries no events at all, by type: a failure is never an event.
import type { EventKind, EventPayloads, SignalKind, SignalPayloads } from "loreweaver-protocol/v3";

import type { RoomContext } from "../../agent/context.ts";
import type { ResetScope } from "../../infra/lifecycle/declarations.ts";
import type { ObjectSchema } from "./schema.ts";

/** Who may use a command. `player`: players and admins. `admin`: admins only. */
export type CommandRole = "player" | "admin";

/** Where a command comes from: the engine, the room's rule pack, or a module. */
export type CommandSource = "engine" | "pack" | "module";

/** One event for the table: the gateway gives it an id, a time and its place in the log. */
export type CommandEvent = { [K in EventKind]: { readonly kind: K; readonly data: EventPayloads[K] } }[EventKind];

/** One ephemeral signal for the table: never logged. */
export type CommandSignal = { [K in SignalKind]: { readonly kind: K; readonly data: SignalPayloads[K] } }[SignalKind];

/**
 * What a room-lifecycle command did to the room's generation. The context's writer is void
 * afterwards: the gateway publishes the command's events through a writer of the new
 * generation, and reloads the room worker from its checkpoints.
 */
export type LifecycleNotice =
  | { readonly kind: "rewind"; readonly epoch: number; readonly turn: number; readonly modulesChanged: readonly string[] }
  | { readonly kind: "reset"; readonly epoch: number; readonly scope: ResetScope }
  | { readonly kind: "import"; readonly epoch: number; readonly turn: number };

export interface CommandSuccess {
  readonly ok: true;
  /** The answer for the caller, in the caller's language; absent when there is nothing to say. */
  readonly text?: string;
  /** The structured answer for the caller. */
  readonly data?: unknown;
  /** What happened at the table, written in the room's language. */
  readonly events: readonly CommandEvent[];
  readonly signals: readonly CommandSignal[];
  readonly lifecycle?: LifecycleNotice;
  /** See `Done.modulesChanged`. */
  readonly modulesChanged?: boolean;
  /** See `Done.after`. */
  readonly after?: () => Promise<readonly string[]>;
}

export interface CommandRefusal {
  readonly ok: false;
  /** A stable code; the protocol's `error.code`. */
  readonly code: string;
  /** The reason in the caller's language. */
  readonly message: string;
}

export type CommandOutcome = CommandSuccess | CommandRefusal;

/** A handler's own refusal before it is put into words: a code and its message parameters. */
export interface Refused {
  readonly refused: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export function refuse(code: string, params?: Readonly<Record<string, string | number>>): Refused {
  return params === undefined ? { refused: code } : { refused: code, params };
}

export function isRefused(value: unknown): value is Refused {
  return typeof value === "object" && value !== null && typeof (value as { refused?: unknown }).refused === "string";
}

/** What a handler returns on success; `events` and `signals` default to none. */
export interface Done {
  readonly text?: string;
  readonly data?: unknown;
  readonly events?: readonly CommandEvent[];
  readonly signals?: readonly CommandSignal[];
  readonly lifecycle?: LifecycleNotice;
  /**
   * The room's enabled packs changed (`pack enable|disable`): the gateway restarts the room's
   * worker with the new module list and recomputes the module views.
   */
  readonly modulesChanged?: boolean;
  /**
   * What can only be finished by waiting, once the command's writes committed and its events
   * went out (indexing new lore for recall: outbound network). The gateway awaits it before
   * answering; the lines it resolves to, in the caller's language, join the answer. It never
   * fails the command: it reports its own problems.
   */
  readonly after?: () => Promise<readonly string[]>;
}

/** One command invocation, as a handler sees it. */
export interface CommandCall {
  readonly context: RoomContext;
  /** The caller's own language: the result is written in it. */
  readonly locale: string;
  /** The text form the caller typed (case-folded), or null for a structured call. */
  readonly word: string | null;
  /** Text for the caller, from this layer's catalog. */
  say(key: string, params?: Readonly<Record<string, string | number>>): string;
  /** Text for the table, in the room's language. */
  tell(key: string, params?: Readonly<Record<string, string | number>>): string;
}

/** A command's text forms, per alias table. Both tables are always searched; the caller's language only decides which first. */
export interface TextForms {
  readonly en: readonly string[];
  readonly zh: readonly string[];
}

export type Args = Readonly<Record<string, unknown>>;

/**
 * One command. `parseText` turns the argument string of a text form into the same
 * argument object a structured call passes; both are then validated against `params`
 * and reach `run` identically.
 */
export interface CommandSpec {
  readonly id: string;
  readonly source: CommandSource;
  /** Catalog keys: `<key>.title`, `<key>.description`, `<key>.usage`. */
  readonly key: string;
  /** Parameters for those three texts (a pack command's subsystem name), in a viewer's language. */
  readonly keyParams?: (locale: string) => Readonly<Record<string, string>>;
  readonly params: ObjectSchema;
  /** The text forms; a function when they depend on the room (its rule pack). */
  readonly text?: TextForms | ((context: RoomContext) => TextForms);
  readonly role: CommandRole;
  /** A command that also needs the admin for some arguments (`rule` with a variant, `lore add`). */
  readonly adminWhen?: (args: Args) => boolean;
  /** An observer may run it (help, recap). */
  readonly observers?: boolean;
  /** Destructive: a client asks before running it. */
  readonly danger?: boolean;
  /**
   * A room-lifecycle command (undo, reset, import). It runs outside the command
   * transaction, because the store's operation is its own transaction and tells external
   * storages after committing; and it should be given a writer of the room's current turn,
   * not a turn of its own.
   */
  readonly lifecycle?: boolean;
  /** Whether the command can run in this room now; a reason code when not. */
  readonly available?: (context: RoomContext) => true | string;
  /** The text form's arguments as an argument object, or a refusal. */
  parseText(rest: string, call: CommandCall): Args | Refused;
  /**
   * Gathers, before `run`, what can only be had by waiting (the module commands a help
   * text lists). Read-only; its result is `run`'s third argument.
   */
  prepare?(call: CommandCall, args: Args): Promise<unknown>;
  /** Synchronous: the store is, and a command never calls a model. */
  run(call: CommandCall, args: Args, prepared?: unknown): Done | Refused;
}

/** One entry of the `commands` view (protocol 3.0 §8.3, §8.4). */
export interface CommandViewEntry {
  readonly id: string;
  readonly source: CommandSource;
  readonly title: string;
  readonly description: string;
  readonly params: unknown;
  readonly text?: { readonly forms: readonly string[]; readonly usage: string };
  readonly role: CommandRole;
  readonly danger?: boolean;
  readonly available: boolean;
  readonly reason?: string;
}

export interface CommandsView {
  readonly commands: readonly CommandViewEntry[];
}

/**
 * Module commands (`<module>/<name>`) are dispatched by another layer, through the room's
 * worker. The registry only lists them in the view and routes a call to this seam.
 */
export interface ModuleCommandEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** JSON Schema of the arguments, as the module declared it. */
  readonly params: unknown;
  readonly forms?: readonly string[];
  readonly role: CommandRole;
  readonly available: true | string;
}

export interface ModuleCommands {
  /** The module commands of the context's room, as its member sees them. */
  list(context: RoomContext): Promise<readonly ModuleCommandEntry[]>;
  /** Run one; the dispatcher validates and applies the module's effects. */
  run(context: RoomContext, id: string, args: Args, locale: string): Promise<CommandOutcome>;
}
