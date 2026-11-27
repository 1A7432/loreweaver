// The registry's module-command seam (`ModuleCommands`): module commands are listed from the
// room worker's load-time descriptions and run through the worker (`agent/modules.ts`); the
// effects a command asks for are applied by `applyModuleEffects` under the command's own
// context, with the room's fact review.
//
// The events come back in the command's outcome like any command's. One kind does not fit
// the registry's event shape: a `blocks` event a module emits WITH an id replaces the
// earlier one of that id, and `CommandEvent` has no id. Such an event carries its id as an
// extra field (`eventIdOf` reads it back) and the room publishes it under that id.
import type { JsonObject, RoomSnapshot } from "loreweaver/module";

import type { RoomContext, Services } from "../agent/context.ts";
import { applyModuleEffects, type EffectEvent, type TextReview } from "../agent/effects.ts";
import { type ClockInfo, describeModules, dispatchCommand } from "../agent/modules.ts";
import { clockReading, moduleVariablesJson } from "../agent/turn/reader.ts";
import { translate } from "../infra/i18n.ts";
import type { RoomWorker } from "../infra/room_worker.ts";
import { type Args, COMMANDS_CATALOG, type CommandEvent, type CommandOutcome, type CommandRefusal, type ModuleCommandEntry, type ModuleCommands } from "./commands/index.ts";
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
}

/** A command event, with the id of the event it replaces when a module gave one. */
export type IdentifiedEvent = CommandEvent & { readonly id?: string };

/** The id a module gave an event (a replacing `blocks`), or undefined. */
export function eventIdOf(event: CommandEvent): string | undefined {
  const id = (event as IdentifiedEvent).id;
  return typeof id === "string" ? id : undefined;
}

/** The room as a module call carries it: the turn, the variables, the clock. */
export function moduleRoom(services: Services, room: string, turn: number, moduleClock: ClockInfo | null): RoomSnapshot {
  return { turn, variables: moduleVariablesJson(services, room) as JsonObject, clock: clockReading(services, room, moduleClock) };
}

function refusal(locale: string, code: string, params: Readonly<Record<string, string | number>> = {}): CommandRefusal {
  const key = Object.hasOwn(COMMANDS_CATALOG.en ?? {}, `error.${code}`) ? `error.${code}` : "error.generic";
  return { ok: false, code, message: translate(COMMANDS_CATALOG, locale, key, { ...params, code }) };
}

function asCommandEvent(event: EffectEvent): IdentifiedEvent {
  const plain = { kind: event.kind, data: event.data } as CommandEvent;
  return event.id === null ? plain : { ...plain, id: event.id };
}

export class RoomModuleCommands implements ModuleCommands {
  readonly #rooms: ModuleCommandRooms;

  constructor(rooms: ModuleCommandRooms) {
    this.#rooms = rooms;
  }

  async list(context: RoomContext): Promise<readonly ModuleCommandEntry[]> {
    const described = await describeModules(this.#rooms.worker(context.room));
    for (const problem of described.problems) context.services.report(context.room, problem);
    const entries: ModuleCommandEntry[] = [];
    for (const module of described.modules) {
      for (const command of module.commands) {
        // A `keeper` command is the Keeper's machinery. Among MEMBERS only an admin may run it,
        // so in the members' table it is an admin command: listed for admins, absent for
        // everyone else (the registry leaves admin entries out of a player's view).
        const entry: { -readonly [K in keyof ModuleCommandEntry]: ModuleCommandEntry[K] } = {
          id: `${module.id}/${command.name}`,
          title: command.title,
          description: command.description,
          params: command.params,
          role: command.role === "keeper" ? "admin" : command.role,
          // Whether the module's own `available` says yes is known per viewer from a render;
          // the table lists the command and the module answers at the moment of use.
          available: true,
        };
        if (command.text.length > 0) entry.forms = command.text;
        entries.push(entry);
      }
    }
    return entries;
  }

  async run(context: RoomContext, id: string, args: Args, locale: string): Promise<CommandOutcome> {
    const at = id.indexOf("/");
    const module = id.slice(0, at);
    const command = id.slice(at + 1);
    const room = context.room;
    const action = this.#rooms.actionOf(context);
    const outcome = await runAsWork(context.writer, () =>
      dispatchCommand(this.#rooms.worker(room), {
        module,
        command,
        args,
        who: context.who,
        by: "member",
        seed: `${room}:${context.writer.epoch}:${context.turn}:${action}:command`,
        room: moduleRoom(context.services, room, context.turn, this.#rooms.moduleClock(room)),
      }),
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
          case "unavailable":
            // The module's own reason is authorial text, shown to that member as written.
            return outcome.text === null ? refusal(locale, "module_unavailable") : { ok: false, code: "module_unavailable", message: outcome.text };
        }
        break;
      case "failed":
        return refusal(locale, "command_failed");
      case "ok": {
        const applied = applyModuleEffects(context, outcome, { review: this.#rooms.reviewFact(context), action, work: "action" });
        if (applied.stale) return refusal(locale, "stale_generation");
        for (const problem of applied.problems) context.services.report(room, `module command ${id}: ${problem.code}${problem.detail === undefined ? "" : ` (${problem.detail})`}`);
        const success: { ok: true; text?: string; data?: unknown; events: readonly CommandEvent[]; signals: [] } = {
          ok: true,
          events: applied.events.map(asCommandEvent),
          signals: [],
        };
        if (outcome.result.text !== null && outcome.result.text !== "") success.text = outcome.result.text;
        if (outcome.result.data !== null) success.data = outcome.result.data;
        return success;
      }
    }
    return refusal(locale, "command_failed");
  }
}
