// The registry's module-command seam (`ModuleCommands`): module commands are listed from the
// room worker's load-time descriptions — with the text forms that read at load; which of
// them a room really takes is the registry's to decide — and run through the worker
// (`agent/modules.ts`, which checks the arguments against the command's `params` first);
// the effects a command asks for are applied by `applyModuleEffects` under the command's own
// context, with the room's fact review. A command that answers `more: true` is called again
// (`runModuleCommand`): each step's effects are applied and its events published by the room
// as the step completes, so the command's outcome carries them marked `published`, for the
// record of what the player did, never to be published twice.
//
// One kind of event does not fit the registry's event shape: a `blocks` event a module emits
// WITH an id replaces the earlier one of that id, and `CommandEvent` has no id. Such an event
// carries its id as an extra field (`eventIdOf` reads it back) and the room publishes it
// under that id.
import type { JsonObject, RoomMember, RoomSnapshot } from "loreweaver/module";

import type { RoomContext, Services } from "../agent/context.ts";
import { applyModuleEffects, type EffectEvent, type TextReview } from "../agent/effects.ts";
import { type ClockInfo, type CommandOutcome as DispatchOutcome, describedModules, describeModules, type ModuleInfo, runModuleCommand } from "../agent/modules.ts";
import { clockReading, moduleVariablesJson } from "../agent/turn/reader.ts";
import { translate } from "../infra/i18n.ts";
import type { RoomWorker } from "../infra/room_worker.ts";
import { type Args, COMMANDS_CATALOG, type CommandEvent, type CommandOutcome, type CommandRefusal, type KeyBook, type ModuleCommandEntry, type ModuleCommands } from "./commands/index.ts";
import { runAsWork } from "./keeper.ts";

/** What the seam needs of the room a context belongs to. */
export interface ModuleCommandRooms {
  /** The room's worker when it has modules; null otherwise. */
  worker(room: string): RoomWorker | null;
  /** The player action a command context was made for (its id seeds and attributes the work). */
  actionOf(context: RoomContext): string;
  /** The output review for a module's table text, in the context's room. */
  reviewFact(context: RoomContext): TextReview;
  /** The clock the room's module keeps, from the last render, when one does. */
  moduleClock(room: string): ClockInfo | null;
  /** Every member of the room, as a module call carries them (`roomMembers`). */
  members(room: string): readonly RoomMember[];
  /**
   * Put a command step's events on the table now, turn-less, through the context's writer;
   * false when the room moved on and they could not be.
   */
  publish(context: RoomContext, events: readonly IdentifiedEvent[]): boolean;
}

/** A command event, with the id of the event it replaces when a module gave one. */
export type IdentifiedEvent = CommandEvent & { readonly id?: string };

/** The id a module gave an event (a replacing `blocks`), or undefined. */
export function eventIdOf(event: CommandEvent): string | undefined {
  const id = (event as IdentifiedEvent).id;
  return typeof id === "string" ? id : undefined;
}

/** The room as a module call carries it: the turn, the variables, the clock, the members. */
export function moduleRoom(services: Services, room: string, turn: number, moduleClock: ClockInfo | null, members: readonly RoomMember[]): RoomSnapshot {
  return { turn, variables: moduleVariablesJson(services, room) as JsonObject, clock: clockReading(services, room, moduleClock), members };
}

function byId(a: RoomMember, b: RoomMember): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every member of a room: one per key of the room, whether or not its holder is connected,
 * sorted by member id so the same keys always give the same list. None without a keystore.
 */
export function roomMembers(keys: KeyBook | null, room: string): readonly RoomMember[] {
  if (keys === null) return [];
  return keys
    .listForAdmin(room)
    .map((key) => ({ id: key.member, name: key.name, role: key.role }))
    .sort(byId);
}

function refusal(locale: string, code: string, params: Readonly<Record<string, string | number>> = {}): CommandRefusal {
  const key = Object.hasOwn(COMMANDS_CATALOG.en ?? {}, `error.${code}`) ? `error.${code}` : "error.generic";
  return { ok: false, code, message: translate(COMMANDS_CATALOG, locale, key, { ...params, code }) };
}

function asCommandEvent(event: EffectEvent): IdentifiedEvent {
  const plain = { kind: event.kind, data: event.data } as CommandEvent;
  return event.id === null ? plain : { ...plain, id: event.id };
}

/** The members' table of module commands, from the accepted descriptions. */
function entriesOf(modules: readonly ModuleInfo[]): ModuleCommandEntry[] {
  const entries: ModuleCommandEntry[] = [];
  for (const module of modules) {
    for (const command of module.commands) {
      // A `keeper` command is the Keeper's machinery. Among MEMBERS only an admin may run it,
      // so in the members' table it is an admin command: listed for admins, absent for
      // everyone else (the registry leaves admin entries out of a player's view).
      const entry: { -readonly [K in keyof ModuleCommandEntry]: ModuleCommandEntry[K] } = {
        id: `${module.id}/${command.name}`,
        module: module.id,
        title: command.title,
        description: command.description,
        params: command.params,
        forms: command.forms,
        role: command.role === "keeper" ? "admin" : command.role,
        // The module's own `available` is asked at the moment of use, never for a listing.
        available: true,
      };
      if (command.danger) entry.danger = true;
      entries.push(entry);
    }
  }
  return entries;
}

export class RoomModuleCommands implements ModuleCommands {
  readonly #rooms: ModuleCommandRooms;

  constructor(rooms: ModuleCommandRooms) {
    this.#rooms = rooms;
  }

  async list(context: RoomContext): Promise<readonly ModuleCommandEntry[]> {
    const described = await describeModules(this.#rooms.worker(context.room));
    for (const problem of described.problems) context.services.report(context.room, problem);
    return entriesOf(described.modules);
  }

  listNow(context: RoomContext): readonly ModuleCommandEntry[] | null {
    const described = describedModules(this.#rooms.worker(context.room));
    if (described === null) return null;
    for (const problem of described.problems) context.services.report(context.room, problem);
    return entriesOf(described.modules);
  }

  async run(context: RoomContext, id: string, args: Args, locale: string): Promise<CommandOutcome> {
    const at = id.indexOf("/");
    const module = id.slice(0, at);
    const command = id.slice(at + 1);
    const room = context.room;
    const action = this.#rooms.actionOf(context);
    const events: IdentifiedEvent[] = [];
    // Every step's effects are applied, and its events go to the table, as the step completes:
    // a later step that fails or times out loses only itself.
    const apply = (step: Extract<DispatchOutcome, { status: "ok" }>): boolean => {
      const applied = applyModuleEffects(context, step, { review: this.#rooms.reviewFact(context), action, work: "action", members: this.#rooms.members(room) });
      if (applied.stale) return false;
      for (const log of step.logs) context.services.report(room, `module command ${id}: module ${log.module} log — ${log.text}`);
      for (const problem of applied.problems) context.services.report(room, `module command ${id}: ${problem.code}${problem.detail === undefined ? "" : ` (${problem.detail})`}`);
      const stepEvents = applied.events.map(asCommandEvent);
      events.push(...stepEvents);
      return this.#rooms.publish(context, stepEvents);
    };
    const outcome = await runAsWork(context.writer, () =>
      runModuleCommand(
        this.#rooms.worker(room),
        { module, command, args, who: context.who, by: "member", seed: `${room}:${context.writer.epoch}:${context.turn}:${action}:command` },
        { now: () => context.services.clock.now(), apply, room: () => moduleRoom(context.services, room, context.turn, this.#rooms.moduleClock(room), this.#rooms.members(room)) },
      ),
    );
    for (const problem of outcome.problems) context.services.report(room, problem);
    switch (outcome.status) {
      case "refused":
        switch (outcome.reason) {
          case "unknown":
            return refusal(locale, "unknown_command", { id });
          case "role":
            // The same refusal for an admin command and for a `keeper` one: it says no more.
            return refusal(locale, "forbidden");
          case "invalid":
            return refusal(locale, "module_args");
          case "args":
            // The engine's own refusal of arguments that do not fit, as for an engine command.
            return refusal(locale, outcome.problem?.code ?? "invalid_arg", { path: outcome.problem?.path ?? "" });
          case "unavailable":
            // The module's own reason is authorial text, shown to that member as written.
            return outcome.text === null ? refusal(locale, "module_unavailable") : { ok: false, code: "module_unavailable", message: outcome.text };
        }
        break;
      case "failed":
        return refusal(locale, "command_failed");
      case "stale":
        return refusal(locale, "stale_generation");
      case "ok": {
        const success: { ok: true; text?: string; data?: unknown; events: readonly CommandEvent[]; signals: []; published: true } = {
          ok: true,
          events,
          signals: [],
          published: true,
        };
        // A command cut short says so after its own answer, in the caller's language.
        const lines = [outcome.result.text ?? "", outcome.stopped === null ? "" : translate(COMMANDS_CATALOG, locale, `module.stopped_${outcome.stopped}`, { steps: outcome.steps })].filter((line) => line !== "");
        if (lines.length > 0) success.text = lines.join("\n");
        if (outcome.result.data !== null) success.data = outcome.result.data;
        return success;
      }
    }
    return refusal(locale, "command_failed");
  }
}
