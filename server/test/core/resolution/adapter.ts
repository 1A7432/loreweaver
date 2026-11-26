// Maps the reference vectors (`rules_*`, plus the pack-dependent `roll_for_check` rows of
// `dice_vectors`) onto the resolution API: loads each pack once, turns a row's inputs
// into calls, and turns results back into the vector's own shape, so the tests compare
// the fields that are BEHAVIOUR.
//
// Old-to-new conversions made here, on purpose:
// - The Python callers applied `int()` to loosely-typed counts and rolls; the new API
//   takes numbers and refuses non-integers. `pyInt` stands in for that `int()` at the
//   call site, so a row whose `int()` raised expects the new error code instead.
// - An old error CLASS maps to a new `code` (`expectedCode`); messages are not compared.
// - A rolled check is compared through the old `RollDetail` fields, derived from the new
//   `RolledCheck` (`asRollDetail`).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { keptFaces, primaryDice } from "../../../src/core/dice/index.ts";
import {
  type CheckOutcome,
  compileResolution,
  type Rank,
  type Resolution,
  ResolutionError,
  type ResolutionErrorCode,
  type RolledCheck,
} from "../../../src/core/resolution/index.ts";
import { loadYaml } from "../../../src/core/yaml.ts";
import { readReference } from "../../reference.ts";

export type Draw = [number, number, number, number];
export interface OldError {
  class: string;
  message: string;
  param?: string;
}
export interface OldRank {
  id: string;
  tier: number;
  success: boolean;
  critical: boolean;
  fumble: boolean;
}
export interface OldRolled {
  expression: string;
  dice: number[];
  total: number;
  successes: number | null;
  ones: number | null;
  modifiers?: Record<string, unknown>;
}

const REPO = join(import.meta.dir, "..", "..", "..", "..");

function sectionOf(yamlText: string): unknown {
  return (loadYaml(yamlText) as Record<string, unknown>).resolution;
}

let cache: Map<string, Resolution> | null = null;

/** Every pack the vectors grade with, compiled once: the three built-ins and the two literal packs. */
export function packs(): Map<string, Resolution> {
  if (cache !== null) return cache;
  cache = new Map();
  for (const id of ["coc7", "dnd5e", "wod"]) {
    cache.set(id, compileResolution(id, sectionOf(readFileSync(join(REPO, "rulepacks", `${id}.yaml`), "utf8"))));
  }
  for (const row of readReference<{ kind: string; pack: string; yaml: string }>("rules_synthetic")) {
    if (row.kind === "pack") cache.set(row.pack, compileResolution(row.pack, sectionOf(row.yaml)));
  }
  return cache;
}

export function pack(id: string): Resolution {
  const found = packs().get(id);
  if (found === undefined) throw new Error(`no compiled pack ${id}`);
  return found;
}

/** Python `int(value)` as the old callers applied it; null = it raised. */
export function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

export function compact(notation: string): string {
  return notation.replace(/\s+/g, "");
}

export function rankDict(rank: Rank): OldRank {
  return { id: rank.id, tier: rank.tier, success: rank.success, critical: rank.critical, fumble: rank.fumble };
}

export function outcomeDict(outcome: CheckOutcome): { rank: OldRank; margin: number | null; target: number | null } {
  return { rank: rankDict(outcome.rank), margin: outcome.margin, target: outcome.target };
}

/** The new error code an old error means for this row. */
export function expectedCode(error: OldError, context: "grade" | "count" | "luck_roll" = "grade"): ResolutionErrorCode {
  switch (error.class) {
    case "MissingRollParamError":
      return "MISSING_PARAM";
    case "InvalidRollParamError":
      return "INVALID_PARAM";
    case "ResolutionError":
      if (/unknown name '(?:raw_)?target'/.test(error.message)) return "TARGET_REQUIRED";
      if (/unknown name 'dice\.\d+'/.test(error.message)) return "DIE_MISSING";
      throw new Error(`unmapped ResolutionError: ${error.message}`);
    case "ValueError":
    case "TypeError":
      if (error.message === "luck_points_must_be_positive") return "LUCK_POINTS_NOT_POSITIVE";
      if (error.message === "luck_cannot_adjust_fumble") return "LUCK_FUMBLE";
      if (error.message === "luck_points_exceed_roll") return "LUCK_EXCEEDS_ROLL";
      if (error.message.startsWith("invalid literal for int()") || error.message.startsWith("int() argument")) {
        return context === "luck_roll" ? "INVALID_ROLL" : "INVALID_COUNT";
      }
  }
  throw new Error(`unmapped error ${error.class}: ${error.message}`);
}

/** Runs `fn`; a `ResolutionError` comes back as its code, anything else is rethrown. */
export function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; code: ResolutionErrorCode; param: string | undefined } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof ResolutionError) return { ok: false, code: error.code, param: error.param };
    throw error;
  }
}

/** The old notation text: the new canonical notation with its `{slot}`s filled in and no spaces (the canonical form spaces its operators). */
function oldExpression(rolled: RolledCheck): string {
  return compact(rolled.notation).replace(/\{([a-z0-9_]+)\}/g, (whole, name: string) => String(rolled.params.get(name) ?? whole));
}

/**
 * The old `RollDetail` of a rolled check. Old conventions reproduced: no kept dice reads
 * `[0]`; `modifiers` carries the applied counts plus `threshold` (pools), `base_roll` /
 * `extra_tens` / `final_tens` (percentile), `modifier` (a non-zero flat term) and
 * `dice_all` (every face of the primary group, a dropped one as 0) when dice were dropped.
 */
export function asRollDetail(rolled: RolledCheck): OldRolled {
  const modifiers: Record<string, unknown> = Object.fromEntries(rolled.modifiers);
  const dice = rolled.dice.length > 0 ? [...rolled.dice] : [0];
  if (rolled.percentile !== null) {
    modifiers.base_roll = rolled.percentile.base;
    modifiers.extra_tens = [...rolled.percentile.extraTens];
    modifiers.final_tens = rolled.percentile.finalTens;
  } else if (rolled.roll !== null && rolled.roll.root.kind === "pool") {
    modifiers.threshold = rolled.roll.root.threshold;
  } else if (rolled.roll !== null) {
    const flat = rolled.total - dice.reduce((a, b) => a + b, 0);
    if (flat !== 0) modifiers.modifier = flat;
    const group = primaryDice(rolled.roll);
    if (group !== null && keptFaces(group).length < group.dice.length) modifiers.dice_all = group.dice.map((die) => (die.kept ? die.face : 0));
  }
  return { expression: oldExpression(rolled), dice, total: rolled.total, successes: rolled.successes, ones: rolled.ones, modifiers };
}

interface PoolGridRow {
  kind: string;
  pack: string;
  pool: number;
  legend: OldRank[];
  cells: [number, number, number, number][];
}

let gridCache: Map<string, { rank: OldRank; margin: number }> | null = null;

/** What the old engine graded for a pool of `pool` dice with these counts (from the pool grids). */
export function poolGridCell(packId: string, pool: number, successes: number, ones: number): { rank: OldRank; margin: number } | undefined {
  if (gridCache === null) {
    gridCache = new Map();
    const rows = [...readReference<PoolGridRow>("rules_wod_grid"), ...readReference<PoolGridRow>("rules_synthetic").filter((row) => row.kind === "pool_grid")];
    for (const row of rows) {
      for (const [s, o, index, margin] of row.cells) gridCache.set(`${row.pack}/${row.pool}/${s}/${o}`, { rank: row.legend[index]!, margin });
    }
  }
  return gridCache.get(`${packId}/${pool}/${successes}/${ones}`);
}
