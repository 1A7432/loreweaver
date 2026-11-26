// The turn's tool catalogue, and dispatch through it.
//
// `buildCatalog` runs ONCE per turn and decides which tools the turn offers: the fixed
// tools, minus gated ones no enabled skill unlocks, minus the clock tool when a module
// owns the room's clock, plus the room pack's subsystem tools, plus the two module-command
// tools when the room has module commands. The same object produces the schemas sent to
// the model (`definitions`) and decides dispatch (`dispatch`), so what is offered and what
// is refused can never disagree: a call of anything not offered is answered with a
// refusal, never an exception.
//
// `dispatch` never throws into the turn. In order: an uncatalogued name is refused; a
// stale writer (the room was rewound, reset or replaced) is refused before anything runs;
// a repeated initiative `next` within the turn is suppressed; the arguments are cleaned
// (`normalizeToolInput`) and decoded; the handler runs; a write refused for staleness or
// by a document type, or any other failure, comes back as text. Results longer than
// `MAX_TOOL_RESULT_CHARS` are cut, and the cut is announced in the text.
import { StaleGeneration } from "../../infra/lifecycle/errors.ts";
import type { ToolDefinition, ToolInput } from "../../infra/llm/types.ts";
import { DocumentRefused } from "../../core/documents/raw.ts";
import type { RulePack } from "../../core/rulepacks/index.ts";
import type { RoomContext } from "../context.ts";
import { getCharacterSheetTool, listPartySheetsTool, updateCharacterAttributeTool, updateCharacterStatusTool } from "./character.ts";
import { recordChronicleTool, updateThreadTool } from "./chronicle.ts";
import { decodeArgs } from "./decode.ts";
import { hpManagerTool, initiativeTrackerTool, rollDiceTool, skillCheckTool } from "./dice.ts";
import { queryLoreTool } from "./lore.ts";
import { generateImageTool } from "./media.ts";
import { lookupCommandTool, runCommandTool } from "./module.ts";
import { gameClockTool, kpNoteTool } from "./notes.ts";
import { createNpcTool, getNpcTool, listNpcsTool, moveNpcTool, npcLearnsTool, setNpcDispositionTool, sketchNpcTool, speakAsNpcTool } from "./npc.ts";
import { parametersSchema } from "./params.ts";
import { adjustRelationshipTool, getRelationshipsTool, setRelationshipTool } from "./relationships.ts";
import { subsystemTools } from "./subsystems.ts";
import {
  type AnyTool,
  type Bookkeeping,
  type ModuleCommand,
  NO_BOOKKEEPING,
  type OutcomeStatus,
  type ToolDeps,
  type ToolOutcome,
  type ToolResult,
  type ToolTurn,
  type TurnLedger,
} from "./types.ts";
import { adjustStatTool, adjustVariableTool, getStatTool, setStatTool, setVariableTool } from "./variables.ts";

/** One tool result may not dominate the context: a longer one is cut, and the cut is said. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

export const GAME_CLOCK_TOOL = gameClockTool.name;
export const MODULE_COMMAND_TOOLS: readonly string[] = [runCommandTool.name, lookupCommandTool.name];

/** The first-release fixed tools, in the order the model is shown them. */
export const FIXED_TOOLS: readonly AnyTool[] = [
  // Dice
  rollDiceTool,
  skillCheckTool,
  hpManagerTool,
  initiativeTrackerTool,
  // Character
  getCharacterSheetTool,
  listPartySheetsTool,
  updateCharacterAttributeTool,
  updateCharacterStatusTool,
  // Notes / clock
  kpNoteTool,
  gameClockTool,
  // NPC
  createNpcTool,
  sketchNpcTool,
  speakAsNpcTool,
  getNpcTool,
  listNpcsTool,
  moveNpcTool,
  npcLearnsTool,
  setNpcDispositionTool,
  // Chronicle
  recordChronicleTool,
  updateThreadTool,
  // Lore
  queryLoreTool,
  // Variables
  setVariableTool,
  adjustVariableTool,
  setStatTool,
  adjustStatTool,
  getStatTool,
  // Gated
  adjustRelationshipTool,
  setRelationshipTool,
  getRelationshipsTool,
  generateImageTool,
  // Module
  runCommandTool,
  lookupCommandTool,
] as AnyTool[];

/** Every fixed tool that a skill must unlock. */
export const GATED_TOOLS: readonly string[] = FIXED_TOOLS.filter((tool) => tool.flags.gated === true).map((tool) => tool.name);

export interface CatalogInput {
  /** The gated tool names the room's enabled skills unlock (their `allowed-tools`, together). */
  readonly unlocked: ReadonlySet<string>;
  /** Whether the Keeper owns the room's clock (`keeperMayAdvance`); false when a module does. */
  readonly keeperOwnsClock: boolean;
  /** The room's rule pack: its subsystems become tools. Null for a room without one. */
  readonly pack: RulePack | null;
  /** The room's module commands this turn; none means the two command tools are not offered. */
  readonly commands: readonly ModuleCommand[];
  readonly deps: ToolDeps;
}

/** One call as the model made it. */
export interface CallRequest {
  readonly name: string;
  readonly input: ToolInput;
}

/** Why a name is not offered, for its refusal. */
type Withheld = "gated" | "clock" | "no_commands" | "shadowed";

function capText(text: string): { readonly text: string; readonly truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= MAX_TOOL_RESULT_CHARS) return { text, truncated: false };
  return {
    text: `${points.slice(0, MAX_TOOL_RESULT_CHARS).join("")}\n\n[…truncated: only the first ${MAX_TOOL_RESULT_CHARS} characters of this result are shown. Narrow the query or ask for a specific part if you need more.]`,
    truncated: true,
  };
}

function outcome(name: string, status: OutcomeStatus, code: string | null, text: string, keeperOnly: boolean, result?: ToolResult): ToolOutcome {
  const capped = capText(text);
  const bookkeeping: Bookkeeping = result?.bookkeeping === undefined ? NO_BOOKKEEPING : { ...NO_BOOKKEEPING, ...result.bookkeeping };
  return { name, status, code, text: capped.text, truncated: capped.truncated, keeperOnly, events: result?.events ?? [], bookkeeping };
}

function refusal(name: string, code: string, text: string): ToolOutcome {
  return outcome(name, "refused", code, text, false);
}

const STALE_TEXT = "This room was rewound, reset or replaced while the turn ran, so nothing was done. Do not narrate this call's effect.";

/**
 * The arguments as the model should have sent them: optional sentinels some providers
 * inject are dropped (the 2.6 loop's `_normalize_tool_arguments`). For `skill_check`, an
 * empty `actor` means "no actor", and then a 0 or empty `npc_target` means "none" too.
 */
export function normalizeToolInput(name: string, input: ToolInput): ToolInput {
  if (name !== "skill_check" || !input.valid) return input;
  const values = { ...input.value };
  const actor = Object.hasOwn(values, "actor") ? values.actor : undefined;
  if (actor === undefined || actor === null || (typeof actor === "string" && actor.trim() === "")) {
    delete values.actor;
    const target = Object.hasOwn(values, "npc_target") ? values.npc_target : undefined;
    if (target === undefined || target === null || target === "" || target === 0) delete values.npc_target;
  }
  return { valid: true, value: values };
}

/** Whether a call is an initiative `next` (as sent: the suppression keys on the raw action). */
function isInitiativeNext(call: CallRequest): boolean {
  return call.name === initiativeTrackerTool.name && call.input.valid && call.input.value.action === "next";
}

export class TurnCatalog {
  readonly #tools: ReadonlyMap<string, AnyTool>;
  readonly #withheld: ReadonlyMap<string, Withheld>;
  readonly #commands: readonly ModuleCommand[];
  readonly #deps: ToolDeps;
  /** Subsystem names that collided with a fixed tool and were left out, for the operator's log. */
  readonly problems: readonly string[];

  constructor(input: CatalogInput) {
    const tools = new Map<string, AnyTool>();
    const withheld = new Map<string, Withheld>();
    const hasCommands = input.commands.length > 0;
    for (const tool of FIXED_TOOLS) {
      if (tool.flags.gated === true && !input.unlocked.has(tool.name)) withheld.set(tool.name, "gated");
      else if (tool.name === GAME_CLOCK_TOOL && !input.keeperOwnsClock) withheld.set(tool.name, "clock");
      else if (MODULE_COMMAND_TOOLS.includes(tool.name) && !hasCommands) withheld.set(tool.name, "no_commands");
      else tools.set(tool.name, tool);
    }
    const problems: string[] = [];
    for (const tool of input.pack === null ? [] : subsystemTools(input.pack)) {
      // A pack cannot replace a fixed tool, offered here or not.
      if (tools.has(tool.name) || withheld.has(tool.name)) {
        problems.push(`rule pack ${input.pack?.id}: subsystem ${tool.name} shares a fixed tool's name and is not offered`);
        continue;
      }
      tools.set(tool.name, tool);
    }
    this.#tools = tools;
    this.#withheld = withheld;
    this.#commands = input.commands;
    this.#deps = input.deps;
    this.problems = problems;
  }

  /** The offered tools, in the order the model is shown them. */
  get tools(): readonly AnyTool[] {
    return [...this.#tools.values()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): AnyTool | null {
    return this.#tools.get(name) ?? null;
  }

  /** The schemas to send the model this turn. */
  definitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: parametersSchema(tool.params) as unknown as Readonly<Record<string, unknown>> }));
  }

  /**
   * The independence key of one call, or null for "serial": a tool declaring
   * `concurrentBy` keys a call by that argument's value (trimmed, case-folded); an empty
   * value, an unreadable call or another tool has none.
   */
  concurrencyKey(call: CallRequest): string | null {
    const tool = this.#tools.get(call.name);
    const by = tool?.flags.concurrentBy;
    if (by === undefined || !call.input.valid) return null;
    const value = normalizeToolInput(call.name, call.input);
    const raw = value.valid && Object.hasOwn(value.value, by) ? value.value[by] : undefined;
    if (raw === undefined || raw === null) return null;
    const key = String(raw).trim().toLowerCase();
    return key === "" ? null : key;
  }

  /** Whether a call writes nothing (an uncatalogued call is not: it stays serial). */
  isReadOnly(name: string): boolean {
    return this.#tools.get(name)?.flags.readOnly === true;
  }

  /** Whether a call may suspend (an uncatalogued call answers at once). */
  suspends(name: string): boolean {
    const tool = this.#tools.get(name);
    return tool !== undefined && tool.suspends !== null;
  }

  /** Run one call. Never throws: every failure is a refusal or a failure the model can read. */
  async dispatch(context: RoomContext, call: CallRequest, ledger: TurnLedger): Promise<ToolOutcome> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      switch (this.#withheld.get(call.name)) {
        case "clock":
          return refusal(call.name, "clock_owned_by_module", `Tool ${call.name} is not available in this room: a module keeps this room's clock. Use its commands instead.`);
        case "gated":
        case "no_commands":
          return refusal(call.name, "not_available", `Tool ${call.name} is not available in this room.`);
        default:
          return refusal(call.name, "unknown_tool", `Unknown tool: ${call.name}`);
      }
    }
    if (!context.writer.current()) return refusal(call.name, "stale_room", STALE_TEXT);
    if (isInitiativeNext(call)) {
      if (ledger.initiativeAdvanced) {
        return outcome(call.name, "suppressed", "initiative_next_repeated", "Initiative already advanced once this turn; duplicate next suppressed.", false);
      }
      ledger.initiativeAdvanced = true;
    }
    const decoded = decodeArgs(tool.params, normalizeToolInput(call.name, call.input));
    if (!decoded.ok) return refusal(call.name, "bad_arguments", `Invalid arguments for tool ${call.name}: ${decoded.error}`);
    const turn: ToolTurn = { ledger, deps: this.#deps, commands: this.#commands };
    const keeperOnly = tool.flags.keeperOnly === true;
    try {
      const result = await tool.run(context, decoded.args, turn);
      return outcome(call.name, result.status ?? "ok", result.code ?? null, result.text, keeperOnly, result);
    } catch (error) {
      if (error instanceof StaleGeneration) return refusal(call.name, "stale_room", STALE_TEXT);
      if (error instanceof DocumentRefused) {
        const first = error.violations[0];
        return refusal(call.name, "document_refused", `The store refused the write (${first === undefined ? "invalid" : `${first.code} at ${first.path}`}); nothing was changed.`);
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return outcome(call.name, "failed", "tool_failed", `Tool ${call.name} failed: ${message}`, keeperOnly);
    }
  }
}

export function buildCatalog(input: CatalogInput): TurnCatalog {
  return new TurnCatalog(input);
}

/** The turn's bookkeeping, from its outcomes in call order. */
export function mergeBookkeeping(outcomes: readonly ToolOutcome[]): {
  readonly diceTools: readonly string[];
  readonly variableWrites: Bookkeeping["variableWrites"];
  readonly clockAdvances: Bookkeeping["clockAdvances"];
  readonly moduleCommands: readonly NonNullable<Bookkeeping["moduleCommand"]>[];
} {
  return {
    diceTools: outcomes.filter((item) => item.bookkeeping.dice).map((item) => item.name),
    variableWrites: outcomes.flatMap((item) => item.bookkeeping.variableWrites),
    clockAdvances: outcomes.flatMap((item) => item.bookkeeping.clockAdvances),
    moduleCommands: outcomes.flatMap((item) => (item.bookkeeping.moduleCommand === null ? [] : [item.bookkeeping.moduleCommand])),
  };
}
