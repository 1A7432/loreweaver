// What the Keeper's side of the engine is handed to do its work: the long-lived
// services of a server, and the context of one piece of work in one room.
//
// These two types are the meeting point of everything built around the turn — tools,
// the prompt assembler, the model lanes, commands. They exist so that those parts agree
// on ONE way of reaching the store, the rule packs and the model, instead of each
// inventing its own bundle and leaving the differences to whoever wires them together.
// Nothing here is global: a server builds one `Services` at start-up and passes it down.
import type { Who } from "loreweaver/module";

import type { ModuleCharacter } from "../core/characters/index.ts";
import { type DocumentTypes, type Viewer } from "../core/documents/model.ts";
import type { RawDocuments } from "../core/documents/raw.ts";
import type { DocumentViews } from "../core/documents/views.ts";
import type { RandomSource } from "../core/random.ts";
import type { RulePack, RulePackRegistry } from "../core/rulepacks/index.ts";
import type { Clock } from "../infra/ids.ts";
import type { LLMClient } from "../infra/llm/index.ts";
import type { RoomWriter, Store } from "../infra/store.ts";

/**
 * The model clients, one per lane that may be configured apart from the Keeper's. A lane
 * with no client of its own uses the Keeper's; the caller resolves that once, here, so
 * no lane decides for itself which model it talks to.
 */
export interface LaneModels {
  readonly keeper: LLMClient;
  readonly npc: LLMClient;
  readonly scribe: LLMClient;
  readonly director: LLMClient;
  /** The chronicle fold. */
  readonly memory: LLMClient;
}

/** What lives as long as the server does. */
export interface Services {
  readonly store: Store;
  readonly types: DocumentTypes;
  /** Whole stored documents: for the code that defines their meaning and the Keeper's tools. */
  readonly documents: RawDocuments;
  /** Documents as a viewer may see them: the only way content leaves toward a connection. */
  readonly views: DocumentViews;
  readonly packs: RulePackRegistry;
  readonly models: LaneModels;
  readonly clock: Clock;
  /** For the operator's log; never shown at the table. */
  readonly report: (room: string, text: string) => void;
}

/**
 * One piece of work in one room: a Keeper turn, a command, or a background lane's commit.
 * `writer` is bound to the room's generation and to `turn` — every write goes through it,
 * and it refuses once the room has been rewound, reset or replaced. A background lane
 * keeps the context it was SCHEDULED with; it never fetches a fresh one when it finishes.
 */
export interface RoomContext {
  readonly services: Services;
  readonly room: string;
  readonly turn: number;
  readonly writer: RoomWriter;
  /** The language of this room: everything sent to the table is written in it. */
  readonly locale: string;
  /** The room's rule system, or null when it has none. */
  readonly pack: RulePack | null;
  /** The house-rule variant the room has chosen within that system, or null for the default. */
  readonly variant: string | null;
  /**
   * Who this work is for: the member who spoke or ran the command, with the character
   * they play. Both are null for work nobody at the table started (a background lane).
   */
  readonly who: Who;
  /** Randomness for this piece of work, derived from persisted inputs so it can be replayed. */
  readonly random: RandomSource;
  /**
   * The characters the room's modules offered at the last render, when the work was made: what
   * a seat on a module's character is shown as (its name, its resources). Absent: none known.
   */
  readonly moduleCharacters?: readonly ModuleCharacter[];
}

/** The viewer a context's own actor is, for projections addressed to them. */
export function viewerOf(context: RoomContext): Viewer {
  const member = context.who.member;
  if (member === null) return { grade: "observer", locale: context.locale };
  const grade = member.role === "admin" ? "admin" : member.role === "observer" ? "observer" : "player";
  return { grade, locale: context.locale, memberId: member.id };
}
