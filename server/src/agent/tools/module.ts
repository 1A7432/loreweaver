// The two fixed tools through which the Keeper reaches a room's module commands
// (decision 34): `run_command` and `lookup_command`. The prompt carries one line per
// command the Keeper may run (its id, its arguments when they are few and plain, and the first
// line of its description); tool cost does not grow with the module. An `admin` command and a member's own verb (`keeper: false`) are
// not in that list; the tools still find them by id, describe them as not the Keeper's, and
// refuse to run them. The command table and the function that runs a command in the room's
// worker are the turn engine's.
import { keeperMayRun, type StepStop } from "loreweaver/runner";

import type { JsonObject } from "../../core/documents/model.ts";
import { param } from "./params.ts";
import { refuse } from "./shared.ts";
import { defineTool, type ModuleCommand, type ToolResult, type ToolTurn } from "./types.ts";

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

/**
 * The refusal for an id that names no module command. When the id — or what follows its last
 * `/` — is one of the Keeper's own tools (`taixu/kp_note`), it says so: listing the room's
 * commands alone leaves the model to try the same tool through `run_command` again.
 */
function unknownCommand(turn: ToolTurn, id: string): ToolResult {
  const known = turn.commands.map(commandId).join(", ");
  const listed = `This room's commands: ${known === "" ? "(none)" : known}.`;
  const wanted = id.trim();
  const tool = turn.tools.find((name) => name === wanted || name === wanted.slice(wanted.lastIndexOf("/") + 1));
  if (tool !== undefined) return refuse("unknown_command", `"${tool}" is one of your own tools, not a module command: call ${tool} directly, with its own arguments. ${listed}`);
  return refuse("unknown_command", `No module command "${id}". ${listed}`);
}

const WHO_MAY_RUN: Readonly<Record<ModuleCommand["info"]["role"], string>> = {
  player: "any player, and you",
  keeper: "you (players never see it; the room admin may also run it by hand)",
  admin: "the room admin only; you cannot run it",
};

/** A member's own verb: the Keeper does not run it, whatever its role allows a member. */
const MEMBERS_ONLY = "the players themselves (it is a player's own action); you cannot run it";

const STOPPED: Readonly<Record<StepStop, string>> = {
  steps: "the step limit",
  time: "the time limit",
  failed: "the next step failed inside the module and nothing it did was kept; the steps before it stand",
};

/** What a command that ran in steps says besides its answer: how many, and why it stopped early. Empty for one call. */
function stepsNote(steps: number, stopped: StepStop | null): string {
  if (stopped !== null) return `(Stopped after ${steps} step${steps === 1 ? "" : "s"}: ${STOPPED[stopped]}.)`;
  return steps > 1 ? `(Ran in ${steps} steps.)` : "";
}

/** Who may run a command, as the Keeper is told. */
function whoMayRun(info: ModuleCommand["info"]): string {
  return info.keeper ? WHO_MAY_RUN[info.role] : MEMBERS_ONLY;
}

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
    if (command === null) return unknownCommand(turn, args.id);
    const info = command.info;
    const lines = [
      `Command ${commandId(command)}: ${info.title}`,
      info.description,
      `Who may run it: ${whoMayRun(info)}${info.checksAvailability ? " (the module may refuse it at the moment of use)" : ""}`,
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
    if (command === null) return unknownCommand(turn, args.id);
    const runner = turn.deps.runCommand;
    if (runner === undefined) return refuse("modules_unavailable", "Module commands cannot be run on this server.");
    const id = commandId(command);
    // Refused here, before the worker: an admin command or a member's own verb is not the Keeper's.
    if (!keeperMayRun(command.info.role, command.info.keeper)) {
      const why = command.info.keeper ? "it is reserved for the room admin; you cannot run it" : "it is a player's own action; you cannot run it";
      return { status: "refused", code: "command_role", text: `${id} refused: ${why}.` };
    }
    const outcome = await runner({ module: command.module, command: command.info.name, args: args.args as JsonObject });
    const bookkeeping = { moduleCommand: { module: command.module, command: command.info.name, outcome } };
    switch (outcome.status) {
      case "ok": {
        const { text, data } = outcome.result;
        const answer = text ?? (data === null ? "done." : JSON.stringify(data));
        const steps = stepsNote(outcome.steps, outcome.stopped);
        return { text: `${id}: ${answer}${steps === "" ? "" : `\n${steps}`}`, bookkeeping };
      }
      case "stale":
        return { status: "failed", code: "command_failed", text: `${id} was cut short: the room moved on while it ran. Carry on without it.`, bookkeeping };
      case "refused": {
        const reasons = {
          unknown: "the module does not have this command",
          // The Keeper may run any command but an admin's, whoever is speaking.
          role: "it is reserved for the room admin; you cannot run it",
          invalid: "the arguments are not a JSON object within the size limit",
          args: `the arguments do not fit its schema (${outcome.problem?.code ?? "invalid_arg"} at ${outcome.problem === undefined || outcome.problem.path === "" ? "the top level" : outcome.problem.path}); call lookup_command for the schema`,
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
