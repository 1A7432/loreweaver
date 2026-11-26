// The engine's side of the module contract: ask the room's worker, then validate and
// cap what came back. A module REQUESTS effects; this is the code that applies them.
// A module that fails or hangs loses its effects and the turn goes on without it.
import { charCount } from "loreweaver-protocol/v3";
import type { TurnStartEvent } from "loreweaver/module";

import type { RoomWorker } from "../infra/room_worker.ts";

/** Guard rails, not format rules: adjustable defaults. */
export const MAX_INJECTIONS = 8;
export const MAX_INJECT_CHARS = 4000;

export interface TurnStartOutcome {
  /** Sections to add to this turn's Keeper prompt, in module order. */
  readonly injections: readonly string[];
  /** What went wrong, for the operator's log. Never shown at the table. */
  readonly problems: readonly string[];
}

const NOTHING: TurnStartOutcome = { injections: [], problems: [] };

export async function dispatchTurnStart(worker: RoomWorker | null, event: TurnStartEvent): Promise<TurnStartOutcome> {
  if (worker === null) return NOTHING;
  let value;
  try {
    value = await worker.turnStart(event);
  } catch (error) {
    return { injections: [], problems: [error instanceof Error ? error.message : String(error)] };
  }
  const injections: string[] = [];
  const problems = value.failures.map((failure) => `module ${failure.module}: ${failure.error}`);
  for (const effect of value.effects) {
    if (effect.kind !== "inject") continue;
    if (injections.length >= MAX_INJECTIONS) {
      problems.push(`module ${effect.module}: injection dropped, the turn already has ${MAX_INJECTIONS}`);
    } else if (charCount(effect.text) > MAX_INJECT_CHARS) {
      problems.push(`module ${effect.module}: injection dropped, longer than ${MAX_INJECT_CHARS} characters`);
    } else if (effect.text.trim().length > 0) {
      injections.push(effect.text);
    }
  }
  return { injections, problems };
}
