// One Keeper turn, at its thinnest: notify the modules, assemble the prompt, call the
// model while streaming its draft, publish the reply. A turn suspends in exactly three
// kinds of place — a worker exchange, a model call, outbound network — and holds no
// room state across any of them.
import type { NarrativeData } from "loreweaver-protocol/v3";
import type { Who } from "loreweaver/module";

import type { Clock } from "../infra/ids.ts";
import type { ChatMessage, LLMClient } from "../infra/llm/index.ts";
import type { RoomWorker } from "../infra/room_worker.ts";
import { dispatchTurnStart } from "./modules.ts";

/** What a turn needs from the room it runs in; implemented by the gateway. */
export interface TurnSink {
  /** Add one narrative to the room's log and send it to the table. */
  narrate(id: string, turn: number, data: NarrativeData): void;
  /** Streaming text for the bubble `narrate(id, …)` will replace. */
  draft(id: string, text: string): void;
  /** Drop a bubble that will get no final text. */
  discardDraft(id: string): void;
  busy(actor: string): void;
  idle(): void;
  /** For the operator's log. */
  problem(text: string): void;
}

export interface TurnDeps {
  readonly llm: LLMClient;
  readonly clock: Clock;
  readonly worker: RoomWorker | null;
  readonly systemPrompt: string;
}

export interface TurnInput {
  readonly room: string;
  /** Counted from 1. */
  readonly turn: number;
  readonly speaker: string;
  readonly text: string;
  /**
   * Who is speaking, as modules are told. Until the room passes seating, it is the
   * speaker as a player with no character.
   */
  readonly who?: Who;
}

export async function runTurn(deps: TurnDeps, sink: TurnSink, input: TurnInput): Promise<void> {
  sink.busy(input.speaker);
  const replyId = deps.clock.id();
  let drafted = false;
  try {
    const started = await dispatchTurnStart(deps.worker, {
      turn: input.turn,
      seed: `${input.room}:${input.turn}:turnStart`,
      text: input.text,
      who: input.who ?? { member: { id: input.speaker, name: input.speaker, role: "player" }, character: null },
      variables: {},
      clock: null,
    });
    for (const problem of started.problems) sink.problem(problem);

    const system = [deps.systemPrompt, ...started.injections].join("\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `[${input.speaker}]\n${input.text}` },
    ];
    const result = await deps.llm.chat(messages, {
      onTextDelta: (text) => {
        drafted = true;
        sink.draft(replyId, text);
      },
    });
    sink.narrate(replyId, input.turn, { speaker: "kp", text: result.content, format: "markdown" });
  } catch (error) {
    // A provider failure never crashes a turn and never leaves a bubble open.
    if (drafted) sink.discardDraft(replyId);
    sink.problem(error instanceof Error ? error.message : String(error));
  } finally {
    sink.idle();
  }
}
