// The boundary between a Keeper turn and the room it runs in.
//
// The engine (`engine.ts`) does the work of one turn; the room (`gateway/room.ts`) owns
// the lock, the connections and what happens after — rendering views, releasing the lock,
// scheduling the Scribe and the Stage Director. These types are what the two agree on, so
// neither reaches into the other: the engine never sees a connection, and the room never
// sees a prompt.
import type { EventKind, EventPayloads, SignalKind, SignalPayloads } from "loreweaver-protocol/v3";

import type { SkillRegistry } from "../../core/skills/index.ts";
import type { Usage } from "../../infra/llm/index.ts";
import type { RoomWorker } from "../../infra/room_worker.ts";
import type { TextReview, WorkKind } from "../effects.ts";
import type { RecallDeps } from "../recall.ts";
import type { GenerateImage } from "../tools/index.ts";

/** What the room does for a turn. */
export interface TurnPorts {
  /**
   * Append an event to the room's log through THIS TURN'S writer and send it to the table:
   * what is sent is what was stored. Throws `StaleGeneration` when the room was rewound,
   * reset or replaced since the turn began.
   */
  publish<K extends EventKind>(kind: K, id: string, data: EventPayloads[K]): void;
  /** Send something that is not part of the log (a draft, busy/idle, a notice). */
  signal<K extends SignalKind>(kind: K, data: SignalPayloads[K]): void;
  /** The room's worker when it has module code; null for a room without modules. */
  moduleWorker(): RoomWorker | null;
  /** The room's worker for the lore exchange, started on demand. */
  loreWorker(): RoomWorker;
  /**
   * The last check on text bound for the table. `unfiltered` rooms (a mature skill is
   * enabled) are the room's business: the engine passes text, the room answers.
   */
  readonly reviewNarrative: TextReview;
  readonly reviewFact: TextReview;
}

/** What lives as long as the server and a turn needs beyond `Services`. */
export interface TurnEnvironment {
  readonly skills: SkillRegistry;
  /** Absent: recall by meaning is off; lore activates by keyword only. */
  readonly recall?: RecallDeps;
  /** Absent: the `generate_image` tool answers that pictures are not configured. */
  readonly generateImage?: GenerateImage;
  readonly settings: TurnSettings;
}

export interface TurnSettings {
  /** Tool rounds the Keeper may take before it must answer. */
  readonly maxRounds: number;
  /** The Keeper model's context window in tokens, for the fold's reading. */
  readonly contextWindow: number;
  /** False: the chronicle is never folded. */
  readonly foldEnabled: boolean;
  readonly fold: {
    readonly trigger: number;
    readonly floor: number;
    readonly emergency: number;
    readonly lagTurns: number;
    readonly summaryMaxChars: number;
  };
}

/** What a turn answers. */
export interface TurnInput {
  /**
   * `action`: a player's line. `facts_turn`: the extra turn opened for module facts marked
   * "narrate now" — it has no player line, and marks made inside it wait for the next turn.
   */
  readonly work: WorkKind;
  /** The id of the player action this work belongs to (the line's event id, or a command's). */
  readonly action: string;
  /** The player's line; empty for a `facts_turn`. */
  readonly text: string;
  /** The speaker's name as the table sees it (the character when seated, else the member). */
  readonly speaker: string;
  /** Stops model requests still in flight. Nothing waits on it otherwise. */
  readonly signal?: AbortSignal;
}

export type TurnStatus =
  /** The Keeper's reply was published. */
  | "replied"
  /** No reply: a provider failure or an internal fault. The table was told with a notice. */
  | "failed"
  /** The room was rewound, reset or replaced while the turn ran: nothing more was written. */
  | "stale"
  /** The caller's signal stopped it. */
  | "aborted";

/** What the room needs to know once a turn has ended, to do its own part. */
export interface TurnResult {
  readonly status: TurnStatus;
  /** A stable code when `failed`. */
  readonly code?: string;
  /** The reply as published (after review); null unless `replied`. */
  readonly reply: string | null;
  /** The reply event's id; null unless `replied`. */
  readonly replyId: string | null;
  /** Usage of the turn's own rounds; check rounds and folds are counted apart. */
  readonly usage: Usage;
  /** No round reported a prompt size: `usage.inputTokens` is the engine's estimate. */
  readonly usageEstimated: boolean;
  /** For the Scribe (`ScribeTurnFacts`): the tools the Keeper called, in order. */
  readonly toolsCalled: readonly string[];
  /** Variables written by content code (a module or a lore template) this turn. */
  readonly contentWrites: ReadonlySet<string>;
  /** The Keeper recorded a chronicle entry itself this turn. */
  readonly keeperRecordedChronicle: boolean;
  /** A module marked a fact "narrate now" during this turn. */
  readonly narrateNowRequested: boolean;
  /** For the operator's log: codes of things that degraded without failing the turn. */
  readonly problems: readonly string[];
}
