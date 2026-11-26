// The room state a Keeper turn owns beyond what its pieces declare:
//
// - `PLAYER_ACTIONS`: the module commands players ran themselves since the Keeper's last
//   turn. The room records each one after the command (`recordPlayerAction`); the next
//   Keeper turn reads them into its prompt and clears what it read in its final commit, so
//   a failed turn loses none of them.
// - `CONTEXT_READING`: the fold meter — the last completed turn's prompt size against the
//   Keeper model's window, written at the end of every turn (and on a context overflow, as
//   the overflow's reading), read by the next turn's routine fold.
//
// Both are `story`: they describe play so far, and a fresh story starts without them.
import { charCount } from "loreweaver-protocol/v3";

import type { ContextReading } from "../../core/chronicle/index.ts";
import { jsonStateKey, type StateKey } from "../../infra/lifecycle/declarations.ts";
import type { Store } from "../../infra/store.ts";
import type { RoomContext } from "../context.ts";
import type { PlayerAction } from "../prompt/index.ts";

// ---------------------------------------------------------------- player actions

/** Player actions waiting for the Keeper's next prompt; past this a new one is refused. */
export const MAX_PLAYER_ACTIONS = 16;
export const MAX_PLAYER_ACTION_ACTOR_CHARS = 64;
export const MAX_PLAYER_ACTION_ID_CHARS = 200;
/** A command's answer may be up to the module cap of 4,000 code points. */
export const MAX_PLAYER_ACTION_TEXT_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fits(value: unknown, max: number, allowEmpty: boolean): value is string {
  return typeof value === "string" && (allowEmpty || value.trim() !== "") && charCount(value) <= max;
}

function isPlayerAction(value: unknown): value is PlayerAction {
  return (
    isRecord(value) &&
    fits(value.actor, MAX_PLAYER_ACTION_ACTOR_CHARS, false) &&
    fits(value.action, MAX_PLAYER_ACTION_ID_CHARS, false) &&
    fits(value.text, MAX_PLAYER_ACTION_TEXT_CHARS, true)
  );
}

/** The commands players ran since the Keeper's last turn, oldest first. */
export const PLAYER_ACTIONS: StateKey<PlayerAction[]> = jsonStateKey(
  "keeper.player_actions",
  { reset: "story" },
  (value): value is PlayerAction[] => Array.isArray(value) && value.length <= MAX_PLAYER_ACTIONS && value.every(isPlayerAction),
);

export type PlayerActionRefusal =
  /** `MAX_PLAYER_ACTIONS` are already waiting. */
  | "too_many"
  /** The actor or the command id is empty or over its cap. */
  | "bad_field"
  /** The result text is over `MAX_PLAYER_ACTION_TEXT_CHARS`. */
  | "too_long";

export type PlayerActionRecord = { readonly ok: true } | { readonly ok: false; readonly code: PlayerActionRefusal };

export function readPlayerActions(store: Store, room: string): readonly PlayerAction[] {
  return store.stateGet(room, PLAYER_ACTIONS) ?? [];
}

/**
 * Record a command a player ran, for the Keeper's next prompt. Call it through the
 * command's own context (its writer), after the command's result was shown. Over a cap
 * the entry is refused with a code — never cut — and the room reports it.
 */
export function recordPlayerAction(context: Pick<RoomContext, "services" | "room" | "writer">, entry: PlayerAction): PlayerActionRecord {
  if (!fits(entry.actor, MAX_PLAYER_ACTION_ACTOR_CHARS, false) || !fits(entry.action, MAX_PLAYER_ACTION_ID_CHARS, false)) return { ok: false, code: "bad_field" };
  if (!fits(entry.text, MAX_PLAYER_ACTION_TEXT_CHARS, true)) return { ok: false, code: "too_long" };
  const waiting = readPlayerActions(context.services.store, context.room);
  if (waiting.length >= MAX_PLAYER_ACTIONS) return { ok: false, code: "too_many" };
  context.writer.statePut(PLAYER_ACTIONS, [...waiting, { actor: entry.actor, action: entry.action, text: entry.text }]);
  return { ok: true };
}

// ---------------------------------------------------------------- the fold meter

export interface StoredReading extends ContextReading {
  /** The turn the reading was taken on. */
  readonly turn: number;
}

function wholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The last turn's context reading. */
export const CONTEXT_READING: StateKey<StoredReading> = jsonStateKey(
  "keeper.context_reading",
  { reset: "story" },
  (value): value is StoredReading =>
    isRecord(value) && wholeNumber(value.turn) && wholeNumber(value.tokens) && wholeNumber(value.window) && typeof value.estimated === "boolean",
);

export function readContextReading(store: Store, room: string): ContextReading | null {
  const stored = store.stateGet(room, CONTEXT_READING);
  return stored === null ? null : { tokens: stored.tokens, window: stored.window, estimated: stored.estimated };
}

export function writeContextReading(context: Pick<RoomContext, "writer" | "turn">, reading: ContextReading): void {
  context.writer.statePut(CONTEXT_READING, { turn: context.turn, tokens: reading.tokens, window: reading.window, estimated: reading.estimated });
}

// ---------------------------------------------------------------- consuming queued inputs

/**
 * `current` without the entries a turn consumed: each consumed entry removes ONE equal
 * entry (by value), so what was added while the turn ran — a Scribe pass finishing late, a
 * fact from a command in this turn — stays for the next one.
 */
export function withoutConsumed<T>(current: readonly T[], consumed: readonly T[]): T[] {
  const remaining = [...current];
  for (const item of consumed) {
    const key = JSON.stringify(item);
    const at = remaining.findIndex((candidate) => JSON.stringify(candidate) === key);
    if (at !== -1) remaining.splice(at, 1);
  }
  return remaining;
}
