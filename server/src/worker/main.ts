// The room worker: one per room, long-lived. Every module enabled in the room lives
// here across turns. Calls arrive one at a time; a call that makes the worker spin is
// ended by the main thread terminating the whole thread, which then rebuilds it from the
// last checkpoints.
import type { Effects, Json, ModuleDefinition } from "loreweaver/module";

import { importModule } from "../infra/runtime/module_loader.ts";
import { onHostMessage, postToHost } from "../infra/runtime/worker.ts";
import type { Effect, EventValue, LoadValue, WorkerRequest, WorkerResponse } from "../infra/worker_protocol.ts";

interface Loaded {
  readonly path: string;
  readonly definition: ModuleDefinition;
  /** The last state this module handed over, as JSON text; null before the first save. */
  checkpoint: string | null;
}

let modules: Loaded[] = [];

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function restore(module: Loaded): void {
  if (module.checkpoint === null) module.definition.create?.();
  else module.definition.load?.(JSON.parse(module.checkpoint) as Json);
}

async function load(request: Extract<WorkerRequest, { op: "load" }>): Promise<LoadValue> {
  const next: Loaded[] = [];
  for (const path of request.paths) {
    const definition = await importModule(path);
    if (next.some((other) => other.definition.id === definition.id)) {
      throw new Error(`two modules share the id "${definition.id}"`);
    }
    // `Object.hasOwn`: a module id is content, and `snapshots["constructor"]` must not
    // find something on the prototype.
    const snapshot = Object.hasOwn(request.snapshots, definition.id) ? request.snapshots[definition.id] : undefined;
    const module: Loaded = {
      path,
      definition,
      checkpoint: snapshot === undefined ? null : JSON.stringify(snapshot),
    };
    restore(module);
    next.push(module);
  }
  modules = next;
  return { modules: next.map((module) => ({ id: module.definition.id, path: module.path })) };
}

async function turnStart(request: Extract<WorkerRequest, { op: "turnStart" }>): Promise<EventValue> {
  const effects: Effect[] = [];
  const checkpoints: Record<string, Json> = {};
  const failures: { module: string; error: string }[] = [];
  for (const module of modules) {
    const handler = module.definition.on?.turnStart;
    if (!handler) continue;
    const id = module.definition.id;
    const own: Effect[] = [];
    const fx: Effects = {
      inject: (text) => {
        own.push({ module: id, kind: "inject", text: String(text) });
      },
      log: (text) => {
        own.push({ module: id, kind: "log", text: String(text) });
      },
    };
    try {
      await handler(request.event, fx);
      const saved = module.definition.save?.();
      if (saved !== undefined) {
        // Through text and back: what is kept is exactly what a restart would load.
        const text = JSON.stringify(saved);
        module.checkpoint = text;
        checkpoints[id] = JSON.parse(text) as Json;
      }
      effects.push(...own);
    } catch (error) {
      // The call is the unit of atomicity: its effects are dropped AND the module goes
      // back to its last checkpoint, so memory and committed effects cannot disagree.
      failures.push({ module: id, error: errorText(error) });
      try {
        restore(module);
      } catch (restoreError) {
        failures.push({ module: id, error: `rollback failed — ${errorText(restoreError)}` });
      }
    }
  }
  return { effects, checkpoints, failures };
}

onHostMessage((message) => {
  const request = message as WorkerRequest;
  const run = request.op === "load" ? load(request) : turnStart(request);
  run.then(
    (value) => {
      postToHost({ id: request.id, ok: true, value } satisfies WorkerResponse);
    },
    (error: unknown) => {
      postToHost({ id: request.id, ok: false, error: errorText(error) } satisfies WorkerResponse);
    },
  );
});
