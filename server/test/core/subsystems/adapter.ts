// Maps the `rules_subsystems` rows (recorded end to end through the 2.x Keeper tool
// layer) onto the pure subsystem flows: a row's 2.x sheet dict becomes a `Sheet`, its
// tool arguments become a typed request, and its draws are replayed.
import { ScriptedRandom } from "../../../src/core/random.ts";
import { parseSheet, type Sheet, type SheetSpec } from "../../../src/core/sheets/index.ts";
import { derivedAttrKeys, type Json, type LegacySheet, legacyView, toInput, withoutAttributes } from "../sheets/adapter.ts";

export type Draw = [number, number, number, number];

export interface FlowRow {
  kind: "flow";
  pack: string;
  subsystem: string;
  locale: "en" | "zh";
  variant: string | null;
  arguments: Record<string, Json>;
  prior_check: { char_name: string; skill: string; target: number; roll: number; details: Record<string, Json> } | null;
  draws: Draw[];
  reply: string;
  error: { class: string; message: string } | null;
  dice_payloads: Record<string, Json>[];
  sheet_input: LegacySheet | null;
  sheet_before: LegacySheet | null;
  sheet_after: LegacySheet | null;
  skill_checks: Record<string, Json>[] | null;
  player_stats: Record<string, Json> | null;
}

export function scripted(draws: Draw[]): ScriptedRandom {
  return new ScriptedRandom(draws.map(([lo, hi, value, step]) => ({ lo, hi, value, step })));
}

/** The row's sheet as the 3.0 sheet layer reads it (derived attribute slots are never stored). */
export function sheetOf(spec: SheetSpec, old: LegacySheet): Sheet {
  const parsed = parseSheet(spec, toInput(spec, withoutAttributes(old, derivedAttrKeys(spec))));
  if (parsed.violations.length > 0) throw new Error(`row sheet did not parse cleanly: ${JSON.stringify(parsed.violations)}`);
  return parsed.sheet;
}

/** A 3.0 sheet in the row's 2.x dict shape, derived attribute slots filled in as 2.x stored them. */
export function legacyOf(spec: SheetSpec, sheet: Sheet): LegacySheet {
  return legacyView(spec, sheet, true);
}

/** Python's `int(value)` as the 2.x tool applied it to a loose argument; NaN where it raised. */
export function pyInt(value: Json | undefined): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value.trim());
  return Number.NaN;
}

/** The integers printed in a reply line, in order. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+/g)].map((match) => Number(match[0]));
}

export interface Tally {
  compared: number;
  skipped: Record<string, number>;
}

export function tally(): Tally {
  return { compared: 0, skipped: {} };
}

export function skip(t: Tally, reason: string): void {
  t.skipped[reason] = (t.skipped[reason] ?? 0) + 1;
}
