// The two fixed tools through which the Keeper reaches a room's module commands
// (decision 34): `run_command` and `lookup_command`. The prompt carries one line per
// command (its id and title); tool cost does not grow with the module. The command table
// and the function that runs a command in the room's worker are the turn engine's.
import type { JsonObject } from "../../core/documents/model.ts";
import { param } from "./params.ts";
import { refuse } from "./shared.ts";
import { defineTool, type ModuleCommand, type ToolResult } from "./types.ts";

/** A command's id as the Keeper names it: `module/command`. */
export function commandId(command: ModuleCommand): string {
  return `${command.module}/${command.info.name}`;
}

/** The command an id names: the full `module/command`, or a bare command name no other module shares. */
export function findCommand(commands: readonly ModuleCommand[], id: string): ModuleCommand | null {
  const wanted = id.trim();
  const exact = commands.find((command) => commandId(command) === wanted);
  if (exact !== undefined) return exact;
  const bare = commands.filter((command) => command.info.name === wanted);
  return bare.length === 1 ? (bare[0] as ModuleCommand) : null;
}

function unknownCommand(commands: readonly ModuleCommand[], id: string): ToolResult {
  const known = commands.map(commandId).join(", ");
  return refuse("unknown_command", `No module command "${id}". This room's commands: ${known === "" ? "(none)" : known}.`);
}

const WHO_MAY_RUN: Readonly<Record<ModuleCommand["info"]["role"], string>> = {
  player: "any player, and you",
  keeper: "you only (players never see it)",
  admin: "the room admin only; you cannot run it",
};

export const lookupCommandTool = defineTool({
  name: "lookup_command",
  description: "Look up one of this room's module commands: what it does, who may run it, and the full JSON Schema of its arguments. Use it before run_command when you do not know a command's parameters.",
  params: {
    id: param.string("The command's id as your command list shows it (module/command)."),
  },
  flags: { readOnly: true },
  suspends: null,
  run(_context, args, turn): ToolResult {
    const command = findCommand(turn.commands, args.id);
    if (command === null) return unknownCommand(turn.commands, args.id);
    const info = command.info;
    const lines = [
      `Command ${commandId(command)}: ${info.title}`,
      info.description,
      `Who may run it: ${WHO_MAY_RUN[info.role]}${info.checksAvailability ? " (the module may refuse it at the moment of use)" : ""}`,
      `Arguments (JSON Schema): ${JSON.stringify(info.params)}`,
    ];
    return { text: lines.filter((line) => line !== "").join("\n") };
  },
});

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run one of this room's module commands and get its answer. Pass the command's id (module/command) and its arguments as a JSON object; call lookup_command first when you do not know the arguments. The module applies its own effects; narrate from its answer.",
  params: {
    id: param.string("The command's id as your command list shows it (module/command)."),
    args: param.object("The command's arguments, as its schema describes them; {} when it takes none.").or({}),
  },
  flags: {},
  suspends: "worker",
  async run(_context, args, turn): Promise<ToolResult> {
    const command = findCommand(turn.commands, args.id);
    if (command === null) return unknownCommand(turn.commands, args.id);
    const runner = turn.deps.runCommand;
    if (runner === undefined) return refuse("modules_unavailable", "Module commands cannot be run on this server.");
    const id = commandId(command);
    const outcome = await runner({ module: command.module, command: command.info.name, args: args.args as JsonObject });
    const bookkeeping = { moduleCommand: { module: command.module, command: command.info.name, outcome } };
    switch (outcome.status) {
      case "ok": {
        const { text, data } = outcome.result;
        const answer = text ?? (data === null ? "done." : JSON.stringify(data));
        return { text: `${id}: ${answer}`, bookkeeping };
      }
      case "refused": {
        const reasons = {
          unknown: "the module does not have this command",
          // The Keeper may run any command but an admin's, whoever is speaking.
          role: "it is reserved for the room admin; you cannot run it",
          invalid: "the arguments are not a JSON object within the size limit",
          unavailable: `the module says it is unavailable now${outcome.text === null ? "" : `: ${outcome.text}`}`,
        } as const;
        const reason: string = reasons[outcome.reason];
        return { status: "refused", code: `command_${outcome.reason}`, text: `${id} refused: ${reason}${/[.!?。！？]$/u.test(reason) ? "" : "."}`, bookkeeping };
      }
      case "failed":
        return { status: "failed", code: "command_failed", text: `${id} failed inside the module; nothing it did was kept. Carry on without it.`, bookkeeping };
    }
  },
});
