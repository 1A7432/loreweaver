/**
 * The data shapes of check resolution: a compiled `Resolution` (one system's `resolution:`
 * section) and what grading and rolling return. All plain readonly data; the compiled
 * objects are frozen, and their tables are `FrozenMap`s, so nothing handed out can be
 * changed by the caller that holds it.
 */

import type { CompiledExpr } from "../condexpr.ts";
import type { DiceExpression, PercentileRoll, Roll } from "../dice/index.ts";

/** Whether a check compares against a skill value (roll-under), a DC (roll-over), or nothing (a pool reading its own successes). */
export type TargetKind = "skill" | "dc" | "none";
export type Compare = "<=" | ">=";

/**
 * One rung of a ladder. `id` is pack vocabulary and doubles as the LABEL KEY a caller
 * localizes through the pack's labels; `tier` and the three flags are the semantics a
 * caller may branch on.
 */
export interface Rank {
  readonly id: string;
  readonly tier: number;
  readonly success: boolean;
  readonly critical: boolean;
  readonly fumble: boolean;
}

/** A ladder rule: the first whose `when` holds wins; `when` is null only for the last (the fallback). */
export interface RankRule {
  readonly rank: Rank;
  readonly when: CompiledExpr | null;
}

export type Ladder = readonly RankRule[];

/** A named difficulty: a transform of the target (null = identity) and the command words that select it, per lower-cased locale. */
export interface Difficulty {
  readonly id: string;
  readonly target: CompiledExpr | null;
  readonly prefixes: FrozenMap<string, readonly string[]>;
}

/** A `{slot}` in the roll notation: an integer clamped into `[min, max]`; `default` is used when the caller gives none. */
export interface ParamSpec {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly default: number | null;
}

/**
 * A named roll modifier. `roll` replaces the check's notation (advantage-style); `tensReroll`
 * adds extra percentile tens dice per count, keeping the lowest (bonus) or highest (penalty).
 */
export interface RollModifier {
  readonly name: string;
  readonly roll: DiceExpression | null;
  readonly tensReroll: "keep_lowest" | "keep_highest" | null;
}

/** How the generic check lanes feed this system; every field is optional pack data. */
export interface CheckDefaults {
  /** The modifier a net favourable count routes to. */
  readonly favorable: string | null;
  /** The modifier a net unfavourable count routes to. */
  readonly unfavorable: string | null;
  /** The target a dc-kind check uses when the caller names none. */
  readonly defaultTarget: number | null;
  /** The canonical stat a "proficient" check adds. */
  readonly proficiency: string | null;
  /** The canonical stat a bare check command rolls. */
  readonly defaultSkill: string | null;
}

/** One system's compiled `resolution:` section. Frozen. */
export interface Resolution {
  readonly packId: string;
  /** The notation every check rolls unless a modifier overrides it. */
  readonly roll: DiceExpression;
  readonly targetKind: TargetKind;
  readonly compare: Compare;
  /** In declared order. */
  readonly modifiers: FrozenMap<string, RollModifier>;
  /** The default ladder. */
  readonly ladder: Ladder;
  /** House-rule ladders by variant id, in declared order. */
  readonly variants: FrozenMap<string, Ladder>;
  readonly difficulties: FrozenMap<string, Difficulty>;
  readonly params: FrozenMap<string, ParamSpec>;
  /** The pack's margin expression; null = the distance between roll and target. */
  readonly margin: CompiledExpr | null;
  readonly check: CheckDefaults;
}

/** What grading reads off a roll. A `RolledCheck` is one; a test or a replay may build one by hand. */
export interface RolledValues {
  /** The dice total, before the situational modifier. */
  readonly total: number;
  /** The kept natural faces of the roll's primary dice group (`dice[i]` in expressions). */
  readonly dice: readonly number[];
  /** Success-pool counts; absent or null outside a pool, read as 0 by expressions. */
  readonly successes?: number | null;
  readonly ones?: number | null;
}

export interface GradeOptions {
  /** The raw target (skill value, DC). Absent or null = the check has none. */
  readonly target?: number | null;
  /** A house-rule ladder; an id the pack does not declare grades by the default ladder. */
  readonly variant?: string | null;
  /** A named difficulty; an id the pack does not declare leaves the target as it is. */
  readonly difficulty?: string | null;
  /** The situational flat add folded into `roll` (d20-style systems); default 0. */
  readonly modifier?: number;
}

/** One graded check, as data. Labels are the caller's: localize `rank.id`. */
export interface CheckOutcome {
  readonly rank: Rank;
  /** Signed distance on the success side, in the system's own metric; null when the system defines none for this check. */
  readonly margin: number | null;
  /** The raw target as given; null when none. */
  readonly target: number | null;
  /** The difficulty-adjusted target the roll was compared to; null when none. */
  readonly effectiveTarget: number | null;
  /** The compared value: dice total plus the situational modifier. */
  readonly roll: number;
  /** The variant whose ladder graded the check; null = the default ladder. */
  readonly variant: string | null;
}

/** The roll step's result. Satisfies `RolledValues`, so it can be graded directly. */
export interface RolledCheck extends RolledValues {
  /** The canonical notation rolled: the pack's, or the overriding modifier's. */
  readonly notation: string;
  /** The dice engine's full roll; null for a percentile roll with extra tens dice. */
  readonly roll: Roll | null;
  /** The percentile roll when extra tens dice were rolled; else null. */
  readonly percentile: PercentileRoll | null;
  readonly successes: number | null;
  readonly ones: number | null;
  /** The modifiers that applied, with their counts, in the order given. */
  readonly modifiers: FrozenMap<string, number>;
  /** The clamped parameter values the notation was rolled with, in declared order. */
  readonly params: FrozenMap<string, number>;
}

/** A rolled check and, unless it was left ungraded, its outcome. */
export interface PerformedCheck {
  readonly rolled: RolledCheck;
  /** The dice total plus the situational modifier: what the target was compared to. */
  readonly total: number;
  /**
   * Null for an UNGRADED roll: a system that compares against a target, rolled without
   * one (a lane shows it as a bare number). A `target: none` system always grades.
   */
  readonly outcome: CheckOutcome | null;
}

/**
 * A read-only, frozen, insertion-ordered map. Pack names are content (any slug, never
 * a prototype member), so tables are maps, never plain objects; this wrapper keeps the
 * compiled tables immutable, which a `Map` itself cannot be.
 */
export class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]> = []) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((value, key) => callback.call(thisArg, value, key, this));
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }
}
