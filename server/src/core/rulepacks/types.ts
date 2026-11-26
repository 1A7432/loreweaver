/**
 * The compiled rule pack: one system's YAML, checked once and frozen. Every table is a
 * `FrozenMap` in declared order (names and ids are content, never object keys), and the
 * layers below are held compiled: `resolution` (how a check rolls and grades), `sheet`
 * (the sheet shape, defaults, aliases, display names, derived formulas, creation
 * constraints), `subsystems`.
 */

import type { DiceExpression } from "../dice/index.ts";
import type { FrozenMap, Resolution } from "../resolution/index.ts";
import type { JsonObject, JsonValue, SheetSpec } from "../sheets/index.ts";
import type { SubsystemSpec } from "../subsystems/spec.ts";

/**
 * One rank's presentation for one locale: `display` is what a table reads; `markers` are
 * surface forms a runtime may take as proof that narration already stated a graded
 * outcome (a pack keeps generic words like "Success" out of them).
 */
export interface RankLabel {
  readonly display: string;
  readonly markers: readonly string[];
}

/** What a dot-command word does: the generic check, character creation in this system, or a subsystem with preset arguments. */
export type CommandBinding =
  | { readonly kind: "action"; readonly action: "check" | "make_char" }
  | { readonly kind: "tool"; readonly tool: string; readonly args: JsonObject };

/**
 * One row of the end-of-turn check table, shape-checked only: what a condition name means
 * is the agent layer's, which skips a name it does not implement and clamps `maxRounds`.
 */
export interface TurnCheck {
  /** The row's id, or null (the agent layer then uses the condition name). */
  readonly id: string | null;
  /** The condition name (written as `when`, or `condition`). */
  readonly condition: string;
  /** Instruction text by case-folded locale. */
  readonly instruction: FrozenMap<string, string>;
  readonly maxRounds: number | null;
  /** False only when the row says `enabled: false`. */
  readonly enabled: boolean;
}

export interface RulePack {
  /** The system id (a pack's file stem). */
  readonly id: string;
  /** Lookup names for the system, as declared. */
  readonly names: readonly string[];
  /** Lookup names that system-selection commands accept, as declared. */
  readonly setKeys: readonly string[];
  /** The compiled `resolution:` section; null for a pack that declares none (it has no check). */
  readonly resolution: Resolution | null;
  /** Sheet shape, defaults, aliases, display names, derived formulas, creation constraints. */
  readonly sheet: SheetSpec;
  /** Rank labels: case-folded locale → rank id → label. */
  readonly labels: FrozenMap<string, FrozenMap<string, RankLabel>>;
  /** Dot-command words (trimmed, case-folded) → binding. */
  readonly commands: FrozenMap<string, CommandBinding>;
  /** The initiative roll; its `{name}` slots read the sheet's canonical values. Null when undeclared. */
  readonly initiative: DiceExpression | null;
  /** Declared subsystems by pack key, in declared order. */
  readonly subsystems: FrozenMap<string, SubsystemSpec>;
  /** Keeper-expertise prompt text by case-folded locale. */
  readonly expertise: FrozenMap<string, string>;
  readonly turnChecks: readonly TurnCheck[];
  /** Opaque sheet-display hints (`top`, `sortBy`, ...), not validated; null when undeclared. */
  readonly stShow: JsonValue;
  /**
   * The whole document after `extends:` was resolved, deep-frozen. Informative sections no
   * engine layer compiles (`creation_constraints.methods.standard_array`,
   * `archetype_priorities`, unknown top-level keys) are read from here by their consumers.
   */
  readonly source: JsonObject;
}
