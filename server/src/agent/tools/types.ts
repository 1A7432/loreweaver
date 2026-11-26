// What a Keeper tool is, what it returns, and what the turn engine hands it besides the
// room.
//
// A tool is an explicit object (`ToolSpec`): its name, the description the model reads,
// its parameters (`params.ts` — the schema and the handler's argument type in one
// declaration), its flags, whether it suspends, and its handler. A handler returns a
// `ToolResult`; the catalogue (`catalog.ts`) turns it into a `ToolOutcome` — data the
// turn engine records: the text for the model, whether that text is Keeper-only, the
// table-visible events the call caused, and what it did for the turn's bookkeeping.
//
// Writes happen INSIDE the handler, through `context.writer` and the document layer, in
// the handler's synchronous stretch: a suspending handler (an NPC actor's model call, a
// worker exchange, an outbound request) re-reads what it needs after it resumes and
// commits in one synchronous block, so nothing it read before the suspension is trusted.
import type { DiceData, MediaData, NarrativeData } from "loreweaver-protocol/v3";

import type { ClockAdvance } from "../../core/clock/index.ts";
import type { Document, JsonObject } from "../../core/documents/model.ts";
import type { RoomContext } from "../context.ts";
import type { CommandInfo, CommandOutcome } from "../modules.ts";
import type { ArgsOf, ParamSet } from "./params.ts";

/** Where a handler may suspend: a model call, a room-worker exchange, outbound network. */
export type Suspension = "model" | "worker" | "network";

export interface ToolFlags {
  /** The result carries Keeper-only material (secrets): it is never quoted to the table. */
  readonly keeperOnly?: boolean;
  /** Offered only when one of the room's enabled skills unlocks it. */
  readonly gated?: boolean;
  /** Writes nothing, so calls of it may overlap with other calls of the round. */
  readonly readOnly?: boolean;
  /**
   * Calls naming DIFFERENT values of this argument touch different documents and may
   * overlap; calls naming the same value stay serial.
   */
  readonly concurrentBy?: string;
}

/** Something the table sees because of a call: added to the room's log by the turn engine, in call order. */
export type TableEvent =
  | { readonly kind: "dice"; readonly data: DiceData }
  | { readonly kind: "narrative"; readonly data: NarrativeData }
  | { readonly kind: "media"; readonly data: MediaData };

/** One write to a room variable, for the module hooks and the Scribe. */
export interface VariableWrite {
  /** A module variable's id, or a path into the imported variable tree. */
  readonly path: string;
  readonly op: "set" | "add";
}

/** What one call contributed to the turn's bookkeeping. */
export interface Bookkeeping {
  /** A dice tool ran (a roll, a check, a rule subsystem): the turn's dice checks look for it. */
  readonly dice: boolean;
  readonly variableWrites: readonly VariableWrite[];
  readonly clockAdvances: readonly ClockAdvance[];
  /** A module command the call ran, with the worker's answer: its effects are the turn engine's to apply. */
  readonly moduleCommand: { readonly module: string; readonly command: string; readonly outcome: CommandOutcome } | null;
}

export const NO_BOOKKEEPING: Bookkeeping = Object.freeze({ dice: false, variableWrites: Object.freeze([]), clockAdvances: Object.freeze([]), moduleCommand: null });

/** What a handler returns. */
export interface ToolResult {
  readonly text: string;
  /**
   * Default `ok`. `refused`: a request the tool turned down; nothing was written.
   * `failed`: something it depends on failed (a model lane, the worker).
   */
  readonly status?: "ok" | "refused" | "failed";
  /** A stable code for a refusal. */
  readonly code?: string;
  readonly events?: readonly TableEvent[];
  readonly bookkeeping?: Partial<Bookkeeping>;
}

/**
 * - `ok`: the tool did what was asked;
 * - `refused`: it was turned down (unknown tool, bad arguments, a rule said no, a stale room);
 * - `failed`: it broke (an exception, reported as text, never thrown into the turn);
 * - `suppressed`: a repeated initiative `next` within one turn, answered without running.
 */
export type OutcomeStatus = "ok" | "refused" | "failed" | "suppressed";

/** One call's outcome, as the turn engine records it. */
export interface ToolOutcome {
  readonly name: string;
  readonly status: OutcomeStatus;
  readonly code: string | null;
  /** The text for the model; at most `MAX_TOOL_RESULT_CHARS`, with any cut announced in it. */
  readonly text: string;
  readonly truncated: boolean;
  /** Keeper-only material: never quoted to the table. */
  readonly keeperOnly: boolean;
  readonly events: readonly TableEvent[];
  readonly bookkeeping: Bookkeeping;
}

// ---------------------------------------------------------------------------
// Injected functions: model lanes and the room worker live elsewhere
// ---------------------------------------------------------------------------

export type NpcEffort = "low" | "medium" | "high";

export interface VoiceNpcRequest {
  readonly room: string;
  readonly locale: string;
  /** The NPC's document id. */
  readonly npc: string;
  /** The NPC's document as stored: the actor is built from it alone. */
  readonly document: Document;
  readonly situation: string;
  readonly allowedActions: string;
  readonly tone: string;
  readonly target: string;
  readonly effort: NpcEffort;
}

export type VoiceNpcResult =
  /** `line` is what the table hears (may be empty when the NPC only acts); `intent` is Keeper-only. */
  | { readonly ok: true; readonly line: string; readonly intent: string; readonly mood: string }
  | { readonly ok: false; readonly code: string };

/** The NPC actor lane (`speak_as_npc`). */
export type VoiceNpc = (request: VoiceNpcRequest) => Promise<VoiceNpcResult>;

export type ImageKind = "scene" | "portrait" | "item";

export interface GenerateImageRequest {
  readonly room: string;
  readonly locale: string;
  /** Player-safe by the Keeper's word: the tool says so to the model. */
  readonly prompt: string;
  readonly kind: ImageKind;
  readonly caption: string;
}

export type GenerateImageResult =
  /** The stored image, as the table's `media` event carries it. */
  | { readonly ok: true; readonly media: MediaData }
  /** `not_configured`, `rate_limited`, or the image client's own code. */
  | { readonly ok: false; readonly code: string };

/** Image generation, storage and the room's image budget (`generate_image`). */
export type GenerateImage = (request: GenerateImageRequest) => Promise<GenerateImageResult>;

/** Semantic recall over the room's lore: entry ids, best first (`query_lore`). */
export type RecallLore = (room: string, query: string) => Promise<readonly string[]>;

export interface RunCommandRequest {
  readonly module: string;
  readonly command: string;
  readonly args: JsonObject;
}

/** One module command, run by the room's worker for the Keeper (`run_command`). */
export type RunCommand = (request: RunCommandRequest) => Promise<CommandOutcome>;

/** One command of the room's module command table. */
export interface ModuleCommand {
  readonly module: string;
  readonly info: CommandInfo;
}

/** What the turn engine supplies; a tool whose function is absent says so instead of running. */
export interface ToolDeps {
  readonly voiceNpc?: VoiceNpc;
  readonly generateImage?: GenerateImage;
  readonly recallLore?: RecallLore;
  readonly runCommand?: RunCommand;
}

// ---------------------------------------------------------------------------
// The turn's ledger
// ---------------------------------------------------------------------------

/** A recorded graded check, as a later spend of points (Luck) adjusts it. */
export interface RecordedCheckState {
  /** The character document id. */
  readonly character: string;
  /** The canonical stat name. */
  readonly skill: string;
  readonly target: number;
  /** The check's current roll (lowered when points were spent on it). */
  readonly roll: number;
  readonly rawRoll: number;
  readonly spent: number;
  readonly variant: string | null;
  readonly difficulty: string | null;
}

/** Per-turn state the tools share across calls. One per Keeper turn; the turn engine makes it. */
export class TurnLedger {
  /** An initiative `next` was dispatched this turn: a second one is suppressed. */
  initiativeAdvanced = false;
  /** The newest recorded check of each character this turn, by character id. */
  readonly checks = new Map<string, RecordedCheckState>();
}

/** What a handler receives besides the room and its arguments. */
export interface ToolTurn {
  readonly ledger: TurnLedger;
  readonly deps: ToolDeps;
  /** The room's module commands, for this turn. */
  readonly commands: readonly ModuleCommand[];
}

/** A Keeper tool. */
export interface ToolSpec<S extends ParamSet> {
  readonly name: string;
  /** For the model: the reference tool's docstring summary, carried over verbatim. */
  readonly description: string;
  readonly params: S;
  readonly flags: ToolFlags;
  /** Null: synchronous — the handler runs to completion in one stretch. */
  readonly suspends: Suspension | null;
  run(context: RoomContext, args: ArgsOf<S>, turn: ToolTurn): ToolResult | Promise<ToolResult>;
}

/** Any tool. */
export type AnyTool = ToolSpec<ParamSet>;

/** Declare a tool; checks what the type system cannot. */
export function defineTool<S extends ParamSet>(spec: ToolSpec<S>): ToolSpec<S> {
  const keyed = spec.flags.concurrentBy;
  if (keyed !== undefined && !Object.hasOwn(spec.params, keyed)) throw new Error(`tool ${spec.name}: concurrentBy names no parameter`);
  if (spec.flags.readOnly === true && keyed !== undefined) throw new Error(`tool ${spec.name}: a read-only tool needs no concurrency key`);
  return spec;
}
