/**
 * Which lore entries are in this turn's prompt, in what order.
 *
 * The pipeline (each step over the survivors of the previous one, in stored order):
 *  1. visibility — disabled entries, and for a player-grade viewer every secret entry,
 *     are removed before anything else looks at them: a secret entry cannot trigger,
 *     draw randomness, win a group or start a timer in a player-grade run;
 *  2. timers — a sticky-active entry is selected without its keys; an entry still in its
 *     delay or cooldown is skipped;
 *  3. triggers — constant entries, then primary keys and the secondary-key logic
 *     (`checkWorldInfo` in SillyTavern `public/scripts/world-info.js`);
 *  4. probability — one `nextInt(1, 100)` draw per triggered entry with
 *     0 < probability < 100 that is not sticky-active; it survives when the draw is
 *     <= its probability;
 *  5. conditions — an entry's `@@if` condition must hold (decided by the caller);
 *  6. inclusion groups — of the survivors sharing a group, one stays: a sticky-active
 *     member outright, else the highest-priority `groupOverride` member, else a
 *     weighted draw (`filterByInclusionGroups`: groups are comma-separated names, the
 *     winner keeps its place in the list, losers are removed);
 *  7. order — stable sort by placement bucket (`before`, everything else, `after`), then
 *     priority descending, then stored order;
 *  8. count limit, then the character budget: an entry that would overflow the budget is
 *     skipped and a later smaller one may still fit; the budget counts raw content code
 *     points.
 *
 * Steps 4-6 keep this engine's recorded order (probability before conditions before
 * groups), where ST runs groups before probability and has no conditions; and timers
 * count TURNS of this engine rather than ST's chat-message indices. Both are this
 * engine's activation model, not a reading of ST.
 *
 * Timers. `advanceTimers: true` counts a new turn: the turn number goes up by one and
 * the chosen entries with sticky/cooldown open their windows at it. `advanceTimers:
 * false` re-assembles the turn already counted (a retry) or browses: the turn number
 * stays, no window opens, and windows opened BY that turn are disregarded, so a retry
 * evaluates the turn as its first assembly did instead of seeing its own cooldowns.
 */

import type { RandomSource } from "../random.ts";
import { type MatchMode, ScanWindow, scanText } from "./matching.ts";
import type { EntryTimer, LoreEntry, Placement, TimerState, ViewerGrade } from "./types.ts";

/** The keeper turn's defaults: module cards ship several 2-5 KB constant rule entries. */
export const DEFAULT_MAX_ENTRIES = 12;
export const DEFAULT_BUDGET_CHARS = 12_000;
/** Hard ceilings on what a caller may ask for. */
export const MAX_ENTRIES_CEILING = 200;
export const BUDGET_CHARS_CEILING = 200_000;
/** At most this many entries are considered per run (an import holds at most 200). */
export const MAX_ACTIVATION_ENTRIES = 2_000;

export interface ActivationInput {
  /** The room's entries in stored order. */
  readonly entries: readonly LoreEntry[];
  /** Required, no default: every caller states who the result is for. */
  readonly viewer: ViewerGrade;
  /** The transcript window, oldest message first. */
  readonly transcript: readonly string[];
  readonly timers: TimerState;
  readonly advanceTimers: boolean;
  /** The only source of randomness (probability rolls, group picks). */
  readonly random: RandomSource;
  readonly maxEntries?: number;
  readonly budgetChars?: number;
  /** false: constant entries select only through their keys (a browse/search posture). */
  readonly includeConstant?: boolean;
  /** Whether a non-empty condition holds; called at most once per distinct condition. */
  readonly conditionHolds: (condition: string) => boolean;
}

export interface Activation {
  /** Selected entries in final order. */
  readonly selected: readonly LoreEntry[];
  /** The entries a run may show at all (enabled, and not secret for a player). */
  readonly visible: readonly LoreEntry[];
  readonly timers: TimerState;
  /** The turn number this run evaluated at. */
  readonly turn: number;
}

const PLACEMENT_RANK: Readonly<Record<Placement, number>> = {
  before: 0,
  default: 1,
  author_note_top: 1,
  author_note_bottom: 1,
  at_depth: 1,
  examples_top: 1,
  examples_bottom: 1,
  outlet: 1,
  after: 2,
};

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function clampInt(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(ceiling, Math.max(0, Math.trunc(value)));
}

/** The entries a viewer may be shown at all. Secret entries never pass for a player. */
export function visibleEntries(entries: readonly LoreEntry[], viewer: ViewerGrade): LoreEntry[] {
  return entries.filter((entry) => entry.enabled && (viewer === "keeper" || !entry.secret));
}

function keywordHit(entry: LoreEntry, window: ScanWindow): boolean {
  const mode: MatchMode = entry; // caseSensitive + matchWholeWords
  if (!entry.keys.some((key) => window.matches(key, mode))) return false;
  if (entry.secondaryKeys.length === 0) return true;
  const hits = entry.secondaryKeys.map((key) => window.matches(key, mode));
  switch (entry.selectiveLogic) {
    case "and_all":
      return hits.every(Boolean);
    case "not_any":
      return !hits.some(Boolean);
    case "not_all":
      return !hits.every(Boolean);
    default:
      return hits.some(Boolean);
  }
}

function groupNames(group: string): string[] {
  return group.split(/,\s*/u).filter((name) => name !== "");
}

/** Step 6: one survivor per inclusion group; winners keep their place. */
function resolveGroups(candidates: readonly LoreEntry[], stickyIds: ReadonlySet<string>, random: RandomSource): LoreEntry[] {
  const groups = new Map<string, LoreEntry[]>();
  for (const entry of candidates) {
    for (const name of groupNames(entry.group)) {
      const members = groups.get(name);
      if (members === undefined) groups.set(name, [entry]);
      else members.push(entry);
    }
  }
  if (groups.size === 0) return [...candidates];
  const removed = new Set<LoreEntry>();
  for (const members of groups.values()) {
    const present = members.filter((entry) => !removed.has(entry));
    if (present.some((entry) => stickyIds.has(entry.id))) {
      for (const entry of present) if (!stickyIds.has(entry.id)) removed.add(entry);
      continue;
    }
    if (present.length <= 1) continue;
    let winner: LoreEntry | undefined;
    for (const entry of present) {
      if (entry.groupOverride && (winner === undefined || entry.priority > winner.priority)) winner = entry;
    }
    if (winner === undefined) {
      const total = present.reduce((sum, entry) => sum + entry.groupWeight, 0);
      if (total <= 0) {
        // ST draws `Math.random() * 0`, which is 0, and the first member's running
        // weight (0) already satisfies `roll <= weight`.
        winner = present[0];
      } else {
        const roll = random.nextInt(1, total);
        let running = 0;
        winner = present.find((entry) => {
          running += entry.groupWeight;
          return roll <= running;
        });
      }
    }
    for (const entry of present) if (entry !== winner) removed.add(entry);
  }
  return candidates.filter((entry) => !removed.has(entry));
}

/** Runs the selection pipeline. Pure: the same input selects the same entries. */
export function activate(input: ActivationInput): Activation {
  const maxEntries = clampInt(input.maxEntries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES_CEILING);
  const budget = clampInt(input.budgetChars, DEFAULT_BUDGET_CHARS, BUDGET_CHARS_CEILING);
  const includeConstant = input.includeConstant ?? true;
  const pool = input.entries.slice(0, MAX_ACTIVATION_ENTRIES);
  const visible = visibleEntries(pool, input.viewer);
  const turn = input.timers.turn + (input.advanceTimers ? 1 : 0);

  const timerById = new Map<string, EntryTimer>();
  for (const timer of input.timers.entries) timerById.set(timer.id, timer);
  const inForce = (timer: EntryTimer | undefined): timer is EntryTimer =>
    timer !== undefined && (input.advanceTimers || timer.openedAt !== turn);
  const stickyActive = (entry: LoreEntry): boolean => {
    const timer = timerById.get(entry.id);
    return entry.sticky > 0 && inForce(timer) && timer.stickyUntil !== undefined && timer.stickyUntil >= turn;
  };
  const eligible = (entry: LoreEntry): boolean => {
    if (entry.delay > 0 && turn < entry.delay) return false;
    const timer = timerById.get(entry.id);
    return !(inForce(timer) && timer.cooldownUntil !== undefined && timer.cooldownUntil >= turn);
  };

  // Steps 2-3.
  const windows = new Map<number, ScanWindow>();
  const windowFor = (depth: number): ScanWindow => {
    let window = windows.get(depth);
    if (window === undefined) {
      window = new ScanWindow(scanText(input.transcript, depth));
      windows.set(depth, window);
    }
    return window;
  };
  const stickyIds = new Set<string>();
  const triggered: LoreEntry[] = [];
  for (const entry of visible) {
    if (stickyActive(entry)) {
      stickyIds.add(entry.id);
      triggered.push(entry);
      continue;
    }
    if (!eligible(entry)) continue;
    if ((entry.constant && includeConstant) || keywordHit(entry, windowFor(entry.scanDepth))) triggered.push(entry);
  }

  // Step 4: sticky-active entries already paid their roll when they fired.
  const survivors = triggered.filter((entry) => {
    if (stickyIds.has(entry.id) || entry.probability >= 100) return true;
    return entry.probability > 0 && input.random.nextInt(1, 100) <= entry.probability;
  });

  // Step 5.
  const verdicts = new Map<string, boolean>();
  const holds = (condition: string): boolean => {
    if (condition === "") return true;
    let verdict = verdicts.get(condition);
    if (verdict === undefined) {
      verdict = input.conditionHolds(condition);
      verdicts.set(condition, verdict);
    }
    return verdict;
  };
  const conditioned = survivors.filter((entry) => holds(entry.condition));

  // Steps 6-8.
  const grouped = resolveGroups(conditioned, stickyIds, input.random);
  const ordered = grouped
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        PLACEMENT_RANK[a.entry.placement] - PLACEMENT_RANK[b.entry.placement] || b.entry.priority - a.entry.priority || a.index - b.index,
    )
    .map(({ entry }) => entry);
  const selected: LoreEntry[] = [];
  let used = 0;
  if (budget > 0) {
    for (const entry of ordered.slice(0, maxEntries)) {
      const size = codePoints(entry.content);
      if (used + size > budget) continue;
      selected.push(entry);
      used += size;
    }
  }

  return { selected, visible, timers: nextTimers(input, pool, selected, stickyIds, turn), turn };
}

function nextTimers(
  input: ActivationInput,
  pool: readonly LoreEntry[],
  selected: readonly LoreEntry[],
  stickyIds: ReadonlySet<string>,
  turn: number,
): TimerState {
  if (!input.advanceTimers) return input.timers;
  // State survives for every enabled entry, secret ones included: a player-grade run
  // must not erase windows a keeper-grade run opened.
  const live = new Set(pool.filter((entry) => entry.enabled).map((entry) => entry.id));
  const kept = new Map<string, EntryTimer>();
  for (const timer of input.timers.entries) if (live.has(timer.id)) kept.set(timer.id, timer);
  for (const entry of selected) {
    if (stickyIds.has(entry.id) || (entry.sticky === 0 && entry.cooldown === 0)) continue;
    kept.set(entry.id, {
      id: entry.id,
      openedAt: turn,
      ...(entry.sticky > 0 ? { stickyUntil: turn + entry.sticky } : {}),
      // The cooldown window starts once the sticky window ends (ST's `onEnded.sticky`).
      ...(entry.cooldown > 0 ? { cooldownUntil: turn + entry.sticky + entry.cooldown } : {}),
    });
  }
  return { turn, entries: [...kept.values()] };
}
