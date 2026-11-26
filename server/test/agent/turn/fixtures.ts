// Shared data for the turn tests: tool calls as the checks see them, and dice payloads.
import type { DiceData } from "loreweaver-protocol/v3";

import { diceToolNames, type TurnState, type TurnToolCall } from "../../../src/agent/turn/checks.ts";

/** The engine's dice tools plus two subsystem tools a rule pack declares. */
export const DICE_TOOLS = diceToolNames(["sanity_check", "spend_luck"]);

export function dice(total: number, target?: number, rolls: number[] = [total]): DiceData {
  return { actor: "Ada", kind: "check", expr: "1d100", rolls, total, ...(target === undefined ? {} : { target }) };
}

export function call(name: string, args: Record<string, unknown> = {}, rolled: DiceData[] = [], suppressed = false): TurnToolCall {
  return { name, args, suppressed, dice: rolled };
}

export function state(reply: string, calls: TurnToolCall[] = [], toolRoundTexts: string[] = [], moduleOwnsClock = false): TurnState {
  return { reply, calls, toolRoundTexts, diceTools: DICE_TOOLS, moduleOwnsClock };
}

export function rolledCalls(total = 42, target = 65): TurnToolCall[] {
  return [call("skill_check", {}, [dice(total, target)])];
}

export const TITLE_REPLY = "🌉 Tokyo Port · Pier 5 | 10:15 pm\nThe sea wind mixes diesel and rust as the cranes sweep overhead.";

// The live shape (Studio playtest, 2026-10-21): the whole scene rode in a tool round beside
// game_clock / kp_note, and the final reply was three sentences.
export const ARCHIVE_SCENE =
  "The ledgers are bound in cracked calfskin, their spines labelled in a clerk's cramped hand: " +
  "1919 through 1924, one volume per year, and a thinner book with no label at all. You work " +
  "through them by lamplight while the archivist pretends not to watch. The columns refuse to " +
  "settle. Figures carried from one page fail to arrive on the next; a shipment of rope is " +
  "entered twice, priced differently each time; a whole quarter of 1922 has been totalled in " +
  "pencil and then inked over in a different, heavier hand. Somewhere in here money moved and " +
  "someone covered the move, but the pattern slides away every time you think you have it, and " +
  "the unlabelled book is written in a private shorthand you cannot begin to read. By the time " +
  "the archivist coughs pointedly and reaches for the lamp, your eyes ache and your notes are a " +
  "page of crossed-out sums that prove nothing except that the books were kept by a liar.";
export const CLOSING = "Outside, the bells are ringing four. The archivist locks the cabinet behind you.";
export const FULL_SCENE = `${ARCHIVE_SCENE}\n\n${CLOSING}`;

export function bookkeepingCalls(): TurnToolCall[] {
  return [
    call("game_clock", { action: "set", value: "16:00" }),
    call("kp_note", { action: "add", category: "world_changes", content: "Ledgers read; 1922 cooked." }),
  ];
}
