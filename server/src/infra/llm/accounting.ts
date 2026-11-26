// One record per LOGICAL model call — retries and their waits included, because the room
// is occupied for that whole span — naming the lane that asked. A lane is declared by the
// code that assembles the prompt (keeper, npc, scribe, director, memory, …) around its
// call; the scope survives awaits and a nested scope restores the outer one when it ends,
// so an NPC voiced inside a Keeper round reports as itself and the next Keeper call as
// the Keeper. infra/ cannot know who consumes the records, so the sink is installed.
import { AsyncLocalStorage } from "node:async_hooks";

import type { LLMErrorCode } from "./errors.ts";
import type { StopReason, Usage, Wire } from "./types.ts";

export type LaneFields = Readonly<Record<string, string | number>>;

export interface LaneScope {
  readonly lane: string;
  readonly fields: LaneFields;
}

export interface CallRecord {
  /** `null` when the call ran outside any lane scope. */
  readonly lane: string | null;
  readonly fields: LaneFields;
  readonly wire?: Wire;
  readonly model?: string;
  readonly durationMs: number;
  readonly attempts: number;
  readonly usage?: Usage;
  readonly stopReason?: StopReason;
  /**
   * The failure's code and status only. The provider's message stays out: an auth
   * failure's body can quote the credential it rejected.
   */
  readonly error?: { readonly code: LLMErrorCode | "thrown"; readonly status?: number };
}

export type CallSink = (record: CallRecord) => void;

const scopes = new AsyncLocalStorage<LaneScope>();
let sink: CallSink | null = null;

/** Runs `body` with every model call inside it attributed to `lane`. */
export function withLane<T>(lane: string, body: () => T, fields: LaneFields = {}): T {
  return scopes.run({ lane, fields }, body);
}

export function currentLane(): LaneScope | undefined {
  return scopes.getStore();
}

/** Installs the one process-wide consumer; returns the function that removes it. */
export function installCallSink(next: CallSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

/** Hands a finished call to the sink. Never throws: accounting must not cost the call. */
export function recordCall(record: Omit<CallRecord, "lane" | "fields">): void {
  const current = sink;
  if (current === null) return;
  const scope = scopes.getStore();
  try {
    current({ lane: scope?.lane ?? null, fields: scope?.fields ?? {}, ...record });
  } catch {
    // A broken sink is the sink's problem, never the turn's.
  }
}
