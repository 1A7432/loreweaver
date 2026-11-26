// Adapters between the reference vectors' shapes (README "Shared shapes") and the
// worldbook's own types. The vectors were recorded from the frozen Python engine.

import type { ImportedEntry, LoreEntry } from "../../../src/core/worldbook/index.ts";
import type { ScriptedDraw } from "../../../src/core/random.ts";

/** The recorded stored-entry shape (`entries_after`, `stored_entries`). */
export interface RecordedEntry {
  readonly title: string;
  readonly content: string;
  readonly keys: string[];
  readonly secondary_keys: string[];
  readonly selective_logic: string;
  readonly constant: boolean;
  readonly enabled: boolean;
  readonly secret: boolean;
  readonly condition: string;
  readonly priority: number;
  readonly probability: number;
  readonly case_sensitive: boolean;
  readonly match_whole_words: boolean;
  readonly scan_depth: number;
  readonly position: string;
  readonly sticky: number;
  readonly cooldown: number;
  readonly delay: number;
  readonly group: string;
  readonly group_weight: number;
  readonly category: string;
  readonly scope: string;
}

/** An entry in the recorded shape. `scope` is always `session` for imports. */
export function toRecorded(entry: ImportedEntry): RecordedEntry {
  return {
    title: entry.title,
    content: entry.content,
    keys: [...entry.keys],
    secondary_keys: [...entry.secondaryKeys],
    selective_logic: entry.selectiveLogic,
    constant: entry.constant,
    enabled: entry.enabled,
    secret: entry.secret,
    condition: entry.condition,
    priority: entry.priority,
    probability: entry.probability,
    case_sensitive: entry.caseSensitive,
    match_whole_words: entry.matchWholeWords,
    scan_depth: entry.scanDepth,
    position: entry.placement === "before" ? "before" : entry.placement === "after" ? "after" : "",
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    group: entry.group,
    group_weight: entry.groupWeight,
    category: entry.category,
    scope: "session",
  };
}

/** Gives imported entries stable ids (the store's job in production). */
export function withIds(entries: readonly ImportedEntry[], prefix = "e"): LoreEntry[] {
  return entries.map((entry, index) => ({ ...entry, id: `${prefix}${index}` }));
}

/** One recorded draw (README "Scripted randomness"). */
export type RecordedDraw =
  | { readonly method: "randint"; readonly args: [number, number]; readonly value: number }
  | { readonly method: "choices"; readonly population: string[]; readonly weights: number[]; readonly index: number; readonly value: string }
  | { readonly method: "choice"; readonly options: string[]; readonly index: number; readonly value: string }
  | { readonly method: "roll"; readonly expr: string; readonly value: number | null; readonly raised: boolean };

/**
 * The `nextInt` calls this engine makes for a recorded draw: a probability roll is
 * `nextInt(1, 100)`; a group pick is `nextInt(1, total weight)` answered with the running
 * weight of the recorded index; a `{{random}}` pick is `nextInt(0, n - 1)`. Rolls are
 * answered by a scripted roller instead, so they produce no draw here.
 */
export function scriptedDraws(draws: readonly RecordedDraw[]): ScriptedDraw[] {
  const out: ScriptedDraw[] = [];
  for (const draw of draws) {
    switch (draw.method) {
      case "randint":
        out.push({ lo: draw.args[0], hi: draw.args[1], step: 1, value: draw.value });
        break;
      case "choices": {
        const total = draw.weights.reduce((sum, weight) => sum + weight, 0);
        const running = draw.weights.slice(0, draw.index + 1).reduce((sum, weight) => sum + weight, 0);
        out.push({ lo: 1, hi: total, step: 1, value: running });
        break;
      }
      case "choice":
        out.push({ lo: 0, hi: draw.options.length - 1, step: 1, value: draw.index });
        break;
      case "roll":
        break;
    }
  }
  return out;
}

/** A dice roller answering from a recorded `{expr: total | "raise"}` map. */
export function scriptedRoller(rolls: Readonly<Record<string, number | string>> | null | undefined): (formula: string) => number {
  return (formula) => {
    const value = rolls?.[formula];
    if (typeof value !== "number") throw new Error(`no scripted roll for ${formula}`);
    return value;
  };
}

/** The recorded injected text minus its two header lines (the caller's). */
export function injectedBody(recorded: string): string {
  if (recorded === "") return "";
  return recorded.split("\n").slice(2).join("\n");
}
