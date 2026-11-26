// The room worker: one per room, long-lived. Every module enabled in the room lives
// here across turns. Calls arrive one at a time; the SDK's runner performs each one (the
// same runner the authors' test host uses). A call that makes the worker spin is ended
// by the main thread terminating the whole thread, which then rebuilds it from the last
// checkpoints.
import type { Json } from "loreweaver/module";
import { errorText, ModuleRunner } from "loreweaver/runner";

import { renderRoll, rollDice } from "../core/dice/index.ts";
import { SeededRandom } from "../core/random.ts";
import { importModule } from "../infra/runtime/module_loader.ts";
import { onHostMessage, postToHost } from "../infra/runtime/worker.ts";
import type { WorkerRequest, WorkerResponse, WorkerValues } from "../infra/worker_protocol.ts";
import { assembleLore, type LoreAssemblyRequest } from "./templates/index.ts";

// Engine dice: the runner derives one seed per roll from the call's seed, the module and
// an ordinal, so a replayed call rolls the same faces.
const runner = new ModuleRunner({
  dice: (notation, seed) => {
    const roll = rollDice(notation, new SeededRandom(seed));
    return { total: roll.total, text: renderRoll(roll) };
  },
});

async function load(request: Extract<WorkerRequest, { op: "load" }>): Promise<WorkerValues["load"]> {
  const entries = [];
  for (const path of request.paths) entries.push({ path, definition: await importModule(path) });
  return runner.load(entries, request.snapshots as Readonly<Record<string, Json>>);
}

function perform(request: WorkerRequest): Promise<WorkerValues[WorkerRequest["op"]]> {
  switch (request.op) {
    case "load":
      return load(request);
    case "turnStart":
      return runner.turnStart(request.event);
    case "toolUse":
      return runner.toolUse(request.event);
    case "replyPhase":
      return runner.replyPhase(request.event);
    case "command":
      return runner.command(request.request);
    case "render":
      return runner.render(request.request);
    case "lore":
      // Pure and synchronous: a fresh template context per call, nothing kept after it.
      // It touches no module, so it returns no checkpoints.
      return Promise.resolve(assembleLore(request.request as unknown as LoreAssemblyRequest));
  }
}

onHostMessage((message) => {
  const request = message as WorkerRequest;
  let run: Promise<WorkerValues[WorkerRequest["op"]]>;
  try {
    run = perform(request);
  } catch (error) {
    run = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  run.then(
    (value) => {
      postToHost({ id: request.id, ok: true, value } satisfies WorkerResponse);
    },
    (error: unknown) => {
      postToHost({ id: request.id, ok: false, error: errorText(error) } satisfies WorkerResponse);
    },
  );
});
