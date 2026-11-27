// Everything the Keeper's prompt is built from, already read by the caller.
//
// The assembler is a pure function of this value: it reads no store, no clock and no
// randomness, so the same snapshot always gives the same bytes. Every document here is
// taken at KEEPER grade, deliberately — the Keeper holds the whole truth of the room
// (iron rule 3); restraint toward the players is its behaviour, not this input's shape.
import type { CampaignSummary, ChronicleRecord, PlotThread } from "../../core/chronicle/index.ts";
import type { CharacterTableView } from "../../core/characters/index.ts";
import type { GameClockTableView, InitiativeView } from "../../core/clock/index.ts";
import type { TableHabits } from "../../core/habits/index.ts";
import type { SetupItem } from "../../core/lore/index.ts";
import type { KeeperNotes, SceneView } from "../../core/notes/index.ts";
import type { Relationships } from "../../core/relationships/index.ts";
import type { RulePack } from "../../core/rulepacks/index.ts";
import type { ModuleVariables, VarMap } from "../../core/variables/index.ts";

/** A seated character as the state panel shows it: name, meters and status effects. */
/**
 * One seated character as the state panel lists it. A module's character has the resources its
 * module gave (a meter may have no maximum) and no status of the engine's.
 */
export interface PartyMember {
  readonly name: string;
  readonly resources: readonly { readonly id?: string; readonly label: string; readonly value: number; readonly max: number | null }[];
  readonly status: readonly string[];
}

/** One command a module offers the Keeper (reached through `run_command` / `lookup_command`). */
export interface ModuleCommandLine {
  readonly id: string;
  /** One line saying what it does; "" when the module gave none. */
  readonly summary: string;
}

/** A command a player ran themselves since the Keeper's last turn. */
export interface PlayerAction {
  /** Who ran it (a display name). */
  readonly actor: string;
  /** The command's id. */
  readonly action: string;
  /** The result the table saw. */
  readonly text: string;
}

/** One completed turn of the conversation, as the event log pairs it. */
export interface PastExchange {
  readonly turn: number;
  /** The speaker's display name; "" leaves the line untagged. */
  readonly speaker: string;
  readonly playerText: string;
  readonly keeperReply: string;
  /**
   * What NPCs said in that turn as their own messages (`speak_as_npc`), in order. The table
   * read them before the reply, and the reply does not repeat them: without them here the
   * Keeper would not know next turn what its NPCs said.
   */
  readonly npcLines?: readonly { readonly name: string; readonly text: string }[];
}

/** The world card's own standing directives, as stored at import. */
export interface CardDirectives {
  /** Static text (bound at import): it rides the cached head. */
  readonly head: string;
  /** This turn's text, its macros already expanded by the caller. */
  readonly postHistory: string;
}

export interface KeeperPromptSnapshot {
  /** The room's language. */
  readonly locale: string;

  // --- Room configuration: what the cached head is built from -----------------------
  /** The room's rule system; null when it has none (the generic expertise text is used). */
  readonly pack: RulePack | null;
  /** Null when no world card was imported, or it carried no directives. */
  readonly cardDirectives: CardDirectives | null;
  /** The bodies of the room's enabled skills, in the order they were enabled. */
  readonly skills: readonly string[];
  /**
   * The room's WHOLE module command catalogue. It sits in the cached head, so it must
   * change only when the room's modules change — never filter it per turn.
   */
  readonly moduleCommands: readonly ModuleCommandLine[];
  /** The rolling campaign summary; null before the first fold. */
  readonly summary: CampaignSummary | null;

  // --- Live state: the volatile tail --------------------------------------------------
  /** Whether a world was imported into this room (the `.import … world` marker). */
  readonly worldImported: boolean;
  /** The lore the room's worker assembled for this turn (its rendered entries), or "". */
  readonly lore: string;
  readonly scene: SceneView | null;
  readonly clock: GameClockTableView | null;
  /** The seated characters, in seat order. */
  readonly party: readonly PartyMember[];
  readonly keeperNotes: KeeperNotes | null;
  readonly initiative: InitiativeView | null;
  readonly relationships: Relationships | null;
  readonly habits: TableHabits | null;
  readonly variables: ModuleVariables | null;
  /** The lore overlay's set-up choices still pending (`pendingSetup`). */
  readonly setupPending: readonly SetupItem[];
  /** The imported variable tree, whole. */
  readonly variableTree: VarMap | null;
  /** The Scribe's whispers for this turn. */
  readonly whispers: readonly string[];
  /** Commands players ran since the Keeper's last turn, already capped by their writer. */
  readonly playerActions: readonly PlayerAction[];
  /** Module injections for this turn (from `turnStart`). */
  readonly injections: readonly string[];
  /** Every plot thread, in stored order (the open ones are shown). */
  readonly threads: readonly PlotThread[];
  /** Folded chronicle records recalled against this turn, most relevant first. */
  readonly recalled: readonly ChronicleRecord[];

  // --- The conversation -----------------------------------------------------------------
  /** Completed turns, oldest first. Those the summary covers are not replayed. */
  readonly history: readonly PastExchange[];
  /** This turn's speaker (display name) and line. */
  readonly speaker: string;
  readonly line: string;
}
