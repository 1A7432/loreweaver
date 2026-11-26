/**
 * The worldbook's data model: one stored lore entry, the activation inputs that are not
 * entries, and the timer state that carries from one turn to the next. Everything here
 * is plain data (no class instances, no functions), because the same shapes cross the
 * room worker's structured-clone boundary.
 */

/**
 * How an entry's secondary keys gate it once a primary key matched. The integer codes
 * SillyTavern writes (`world_info_logic` in `public/scripts/world-info.js`) map 0..3 onto
 * these in that order: AND_ANY, NOT_ALL, NOT_ANY, AND_ALL.
 */
export type SelectiveLogic = "and_any" | "not_all" | "not_any" | "and_all";

/**
 * Where SillyTavern would insert the entry (`world_info_position` in world-info.js:
 * 0 before, 1 after, 2 author's-note top, 3 author's-note bottom, 4 at depth, 5 examples
 * top, 6 examples bottom, 7 outlet). The engine renders ONE lore section, so only
 * `before` and `after` change the order inside it; the rest sort with `default` and are
 * reported on each injected entry for a caller that places them itself.
 */
export type Placement =
  | "before"
  | "default"
  | "after"
  | "author_note_top"
  | "author_note_bottom"
  | "at_depth"
  | "examples_top"
  | "examples_bottom"
  | "outlet";

/** Who the assembled lore is for. A player-grade result never contains a secret entry. */
export type ViewerGrade = "keeper" | "player";

/** One lore entry as an import produces it, before the store gives it an identity. */
export interface ImportedEntry {
  readonly title: string;
  /** Entry text with its leading `@@decorator` lines removed. */
  readonly content: string;
  readonly keys: readonly string[];
  readonly secondaryKeys: readonly string[];
  readonly selectiveLogic: SelectiveLogic;
  /** Selected every turn without a key match (subject to timers, probability, budget). */
  readonly constant: boolean;
  readonly enabled: boolean;
  /** Keeper-only: never part of a player-grade assembly, never stored by a player import. */
  readonly secret: boolean;
  /** An `@@if` activation condition: the closed condition language first, else JavaScript. */
  readonly condition: string;
  /** Higher sorts first and wins the budget (`priority` / V2 `insertion_order` / ST `order`). */
  readonly priority: number;
  /** Percent chance (0..100) that a triggered entry survives. */
  readonly probability: number;
  readonly caseSensitive: boolean;
  readonly matchWholeWords: boolean;
  /** How many of the newest transcript messages the keys scan; 0 = the whole window given. */
  readonly scanDepth: number;
  readonly placement: Placement;
  /** Insertion depth for `at_depth` (SillyTavern's DEFAULT_DEPTH is 4). */
  readonly depth: number;
  /** Turns an entry stays selected after it fired. */
  readonly sticky: number;
  /** Turns an entry cannot fire again once its sticky window (if any) ended. */
  readonly cooldown: number;
  /** The entry is not eligible before this turn number. */
  readonly delay: number;
  /** Inclusion groups, written as SillyTavern does: comma-separated names. */
  readonly group: string;
  readonly groupWeight: number;
  /** Wins its inclusion group outright (highest `priority` among overriders). */
  readonly groupOverride: boolean;
  readonly category: string;
  /** Which import wrote the entry; a keeper re-import of the same source replaces it. */
  readonly source: string;
}

/** A stored entry: an imported one plus the identity the store assigned. */
export interface LoreEntry extends ImportedEntry {
  readonly id: string;
}

/** One entry's open timer windows. Turn numbers are absolute. */
export interface EntryTimer {
  readonly id: string;
  /** The turn whose assembly opened the windows below. */
  readonly openedAt: number;
  /** Selected without its keys through this turn (absent: no sticky window). */
  readonly stickyUntil?: number;
  /** Not eligible through this turn (absent: no cooldown window). */
  readonly cooldownUntil?: number;
}

/** The worldbook's per-room timer state. */
export interface TimerState {
  /** The number of the last turn that was counted. */
  readonly turn: number;
  readonly entries: readonly EntryTimer[];
}

export const EMPTY_TIMERS: TimerState = Object.freeze({ turn: 0, entries: Object.freeze([]) });

/**
 * The variables entries and templates read: `flat` (module variables, checked first) and
 * `tree` (the imported MVU variable tree). Both are JSON-shaped.
 */
export interface VariableSnapshot {
  readonly flat: Readonly<Record<string, unknown>>;
  readonly tree: Readonly<Record<string, unknown>>;
}

/** The GAME clock strings the time macros print; an absent one leaves its macro as written. */
export interface GameClock {
  /** `{{time}}` */
  readonly time?: string;
  /** `{{date}}` */
  readonly date?: string;
  /** `{{weekday}}` */
  readonly weekday?: string;
  /** `{{isotime}}` */
  readonly isoTime?: string;
  /** `{{isodate}}` */
  readonly isoDate?: string;
}
