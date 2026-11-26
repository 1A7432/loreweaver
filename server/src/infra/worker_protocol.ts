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
  | { readonly id: number; readonly op: "render"; readonly request: RenderRequest };

/** The value each op answers with. */
export interface WorkerValues {
  readonly load: LoadValue;
  readonly turnStart: TurnStartValue;
  readonly toolUse: CallValue;
  readonly replyPhase: CallValue;
  readonly command: CommandValue;
  readonly render: RenderValue;
}

export type WorkerOp = WorkerRequest["op"];

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: WorkerValues[WorkerOp] }
  | { readonly id: number; readonly ok: false; readonly error: string };
