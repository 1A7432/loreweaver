/**
 * The Keeper's prompt assembler — the one place the Keeper's context is built (iron rule 5).
 *
 * `assembleKeeperPrompt(snapshot)` is pure: the caller reads the room (at Keeper grade)
 * into a `KeeperPromptSnapshot`, and gets back one `KeeperPrompt` — the cache-stable head,
 * the volatile tail and the replayed history. `keeperMessages` lays it out for a model
 * call with the cache breakpoints placed; `moveInTurnBreakpoint` keeps the in-turn mark
 * on the newest tool result; `stripCacheBreakpoints` is for calls that leave the prefix.
 */
export {
  assembleKeeperPrompt,
  type KeeperPrompt,
  keeperMessages,
  moveInTurnBreakpoint,
  replayExchange,
  speakerLine,
  stripCacheBreakpoints,
} from "./assemble.ts";
export { PROMPT_CATALOG, promptText } from "./catalog.ts";
export {
  MAX_PROMPT_LEAVES,
  MAX_PROMPT_THREADS,
  NPC_STATUS_CATEGORY,
  OPENING_FACT_TAG,
  RECALL_BUDGET_CHARS,
  WORLD_CHANGES_CATEGORY,
} from "./sections.ts";
export type {
  CardDirectives,
  KeeperPromptSnapshot,
  ModuleCommandLine,
  PartyMember,
  PastExchange,
  PlayerAction,
} from "./snapshot.ts";
