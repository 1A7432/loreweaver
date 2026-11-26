// Messages between the main thread and a room's worker. Each request gets exactly one
// response with the same `id`.
import type { Json, TurnStartEvent } from "loreweaver/module";

export type WorkerRequest =
  | {
      readonly id: number;
      readonly op: "load";
      /** Absolute paths of the module entry files, in dispatch order. */
      readonly paths: readonly string[];
      /** Last checkpoints by module id; a module with none starts fresh. */
      readonly snapshots: Readonly<Record<string, Json>>;
    }
  | { readonly id: number; readonly op: "turnStart"; readonly event: TurnStartEvent };

export type Effect =
  | { readonly module: string; readonly kind: "inject"; readonly text: string }
  | { readonly module: string; readonly kind: "log"; readonly text: string };

export interface LoadValue {
  readonly modules: readonly { readonly id: string; readonly path: string }[];
}

export interface EventValue {
  /** Effects of the modules whose handler succeeded, in module order. */
  readonly effects: readonly Effect[];
  /** New checkpoints, by module id, of the modules whose handler succeeded. */
  readonly checkpoints: Readonly<Record<string, Json>>;
  /** Modules whose handler threw: their effects were dropped and their state rolled back. */
  readonly failures: readonly { readonly module: string; readonly error: string }[];
}

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: LoadValue | EventValue }
  | { readonly id: number; readonly ok: false; readonly error: string };
