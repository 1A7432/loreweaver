// Messages between the main thread and a room's worker. Each request gets exactly one
// response with the same `id`. Everything here is plain data (structured-cloned); the
// value shapes are the SDK runner's, since the worker is a thin shell around it.
import type { ReplyPhaseEvent, ToolUseEvent, TurnStartEvent } from "loreweaver/module";
import type { CallValue, CommandRequest, CommandValue, LoadValue, RenderRequest, RenderValue, TurnStartValue } from "loreweaver/runner";

export type {
  CallValue,
  CommandRequest,
  CommandValue,
  Effect,
  Failure,
  LoadValue,
  ModuleDescription,
  Refusal,
  RenderRequest,
  RenderValue,
  TurnStartValue,
} from "loreweaver/runner";

/**
 * The lore exchange's request: plain data shaped as `worker/templates`' `LoreAssemblyRequest`.
 * This layer cannot name that type (it sits below `core`), and nothing needs it to: the
 * worker reads the request as that shape, and its answer is checked by the engine as
 * untrusted data (`agent/lore_step.ts`), so the answer is typed `unknown` here.
 */
export type LoreRequest = Readonly<Record<string, unknown>>;

export type WorkerRequest =
  | {
      readonly id: number;
      readonly op: "load";
      /** Absolute paths of the module entry files, in dispatch order. */
      readonly paths: readonly string[];
      /** Last checkpoints by module id; a module with none starts fresh. */
      readonly snapshots: Readonly<Record<string, unknown>>;
    }
  | { readonly id: number; readonly op: "turnStart"; readonly event: TurnStartEvent }
  | { readonly id: number; readonly op: "toolUse"; readonly event: ToolUseEvent }
  | { readonly id: number; readonly op: "replyPhase"; readonly event: ReplyPhaseEvent }
  | { readonly id: number; readonly op: "command"; readonly request: CommandRequest }
  | { readonly id: number; readonly op: "render"; readonly request: RenderRequest }
  /** Read-only: the worldbook scan and template rendering of one prompt assembly. */
  | { readonly id: number; readonly op: "lore"; readonly request: LoreRequest };

/** The value each op answers with. */
export interface WorkerValues {
  /** `failed`: modules left out because they could not be imported or were refused, one line each. */
  readonly load: LoadValue & { readonly failed?: readonly string[] };
  readonly turnStart: TurnStartValue;
  readonly toolUse: CallValue;
  readonly replyPhase: CallValue;
  readonly command: CommandValue;
  readonly render: RenderValue;
  /** A `LoreAssemblyResult`, unchecked: the engine validates it. */
  readonly lore: unknown;
}

export type WorkerOp = WorkerRequest["op"];

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: WorkerValues[WorkerOp] }
  | { readonly id: number; readonly ok: false; readonly error: string };
