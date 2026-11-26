// A Keeper turn: the engine (`runKeeperTurn`), the boundary it shares with the room
// (`types.ts`), the room state it owns (`records.ts`) and its reads of the room
// (`reader.ts`). The pure parts it calls — checks, the stream gate, the reply steps, usage —
// are imported from their own files by whoever needs them.
export { KEEPER_LANE, runKeeperTurn } from "./engine.ts";
export {
  CONTEXT_READING,
  MAX_PLAYER_ACTION_ACTOR_CHARS,
  MAX_PLAYER_ACTION_ID_CHARS,
  MAX_PLAYER_ACTION_TEXT_CHARS,
  MAX_PLAYER_ACTIONS,
  PLAYER_ACTIONS,
  type PlayerActionRecord,
  type PlayerActionRefusal,
  readContextReading,
  readPlayerActions,
  recordPlayerAction,
} from "./records.ts";
export { FACTS_TURN_LINE, HISTORY_PAGE_EVENTS, MAX_HISTORY_SCAN_EVENTS, OPENING_NOTE, readHistory, type HistoryReading } from "./reader.ts";
export type { TurnEnvironment, TurnInput, TurnPorts, TurnResult, TurnSettings, TurnStatus } from "./types.ts";
