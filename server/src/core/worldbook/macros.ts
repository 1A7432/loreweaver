/**
 * SillyTavern `{{macro}}` substitution for lore text, ported from `evaluateMacros` in
 * SillyTavern `public/scripts/macros.js` (and `getVariableMacros` in
 * `public/scripts/variables.js`): the same patterns, the same pass order, the same value
 * printing. The passes, in ST's order:
 *
 *  1. legacy `<USER>`, `<BOT>`, `<CHAR>` (case-insensitive);
 *  2. `{{roll:N}}` / `{{roll N}}` (`/{{roll[ : ]([^}]+)}}/gi`; a bare number means `1dN`;
 *     an invalid formula prints nothing);
 *  3. `{{getvar::name}}` (`/{{getvar::([^}]+)}}/gi`, name trimmed) and this engine's own
 *     `{{var:name}}`;
 *  4. `{{newline}}`, `{{trim}}` (with the line breaks around it), `{{noop}}`;
 *  5. `{{user}}`, `{{char}}` (exact, case-insensitive: `new RegExp('{{user}}', 'gi')`);
 *  6. `{{// comment}}` (`/\{\{\/\/([\s\S]*?)\}\}/gm`), after the names, so a comment may
 *     contain braces and resolved names;
 *  7. the time macros, `{{reverse:…}}`, `{{random…}}`, `{{pick…}}`.
 * Every pass sees the previous pass's output, exactly as ST's chained `replace` calls do.
 *
 * Where this differs from ST on purpose:
 * - time macros print the supplied GAME clock (ST prints the wall clock via moment);
 *   without a clock string the macro stays as written;
 * - `{{random}}` draws from the injected `RandomSource` (one `nextInt(0, n-1)` per macro,
 *   left to right); `{{pick}}` is ST's "stable pick": seeded from the caller's `pickSeed`,
 *   the raw text and the macro's offset (ST seeds from the chat id hash, the raw content
 *   hash and the offset), so a retry of the same text picks the same item;
 * - a macro whose context is absent (no names, no roller, no random source, no pick
 *   seed) stays as written instead of printing `undefined` or a fresh random choice;
 * - the variable-WRITING macros (`{{setvar}}`, `{{addvar}}`, `{{incvar}}`, `{{decvar}}`,
 *   the global variants) are not run: lore assembly does not write variables through
 *   macros, so they stay as written.
 * Values print like ST's `MacrosParser.sanitizeMacroValue`: strings as they are, null and
 * undefined as nothing, objects and arrays as JSON, everything else through `String`
 * (`true`, `2`, `1e+21`).
 */

import { parseDice, rollExpression } from "../dice/index.ts";
import { type RandomSource, SeededRandom } from "../random.ts";
import type { GameClock, VariableSnapshot } from "./types.ts";
import { readVariable } from "./variables.ts";

/** Rolls a dice formula and returns its total; throws on a formula it cannot roll. */
export type DiceRoller = (formula: string) => number;

export interface MacroContext {
  /** Display names for `{{user}}` / `{{char}}` (and the legacy `<USER>` / `<BOT>` / `<CHAR>`). */
  readonly names?: { readonly user?: string; readonly char?: string };
  readonly variables?: VariableSnapshot;
  readonly clock?: GameClock;
  /** Backs `{{random}}`. */
  readonly random?: RandomSource;
  /** Backs `{{pick}}`: same seed, same text, same pick. */
  readonly pickSeed?: string;
  /** Backs `{{roll}}`; must be the real dice engine (`diceRoller`), or a test double. */
  readonly roll?: DiceRoller;
}

/** A `DiceRoller` over the engine's dice, drawing from `random`. */
export function diceRoller(random: RandomSource): DiceRoller {
  return (formula) => rollExpression(parseDice(formula), random).total;
}

/** ST's `sanitizeMacroValue`. */
export function macroValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  if (typeof value === "function" || typeof value === "symbol") return "";
  return String(value);
}

const COMMA_PLACEHOLDER = "\u0000COMMA\u0000";

/** ST's list split for random/pick: `::` if present (no trimming), else commas (trimmed, `\,` escapes). */
function macroList(listString: string): string[] {
  if (listString.includes("::")) return listString.split("::");
  return listString
    .replaceAll("\\,", COMMA_PLACEHOLDER)
    .split(",")
    .map((item) => item.trim().replaceAll(COMMA_PLACEHOLDER, ","));
}

/** Substitutes the supported macros in `text`; anything unknown stays as written. */
export function substituteMacros(text: string, context: MacroContext): string {
  if (text === "") return text;
  const raw = text;
  const names = context.names ?? {};
  let out = text;

  // 1. Legacy names.
  if (names.user !== undefined) out = out.replace(/<USER>/giu, () => names.user ?? "");
  if (names.char !== undefined) out = out.replace(/<BOT>|<CHAR>/giu, () => names.char ?? "");
  if (!out.includes("{{")) return out;

  // 2. Dice.
  const roll = context.roll;
  if (roll !== undefined) {
    out = out.replace(/\{\{roll[ :]([^}]+)\}\}/giu, (_match, value: string) => {
      let formula = value.trim();
      if (/^\d+$/u.test(formula)) formula = `1d${formula}`;
      try {
        const total = roll(formula);
        return Number.isFinite(total) ? String(total) : "";
      } catch {
        return "";
      }
    });
  }

  // 3. Variable reads.
  const variables = context.variables;
  if (variables !== undefined) {
    out = out.replace(/\{\{getvar::([^}]+)\}\}/giu, (_match, name: string) => macroValueText(readVariable(variables, name.trim())));
    out = out.replace(/\{\{\s*var:([^{}]+?)\s*\}\}/gu, (_match, name: string) => macroValueText(readVariable(variables, name.trim())));
  }

  // 4. Layout macros.
  out = out.replace(/\{\{newline\}\}/giu, "\n");
  out = out.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/giu, "");
  out = out.replace(/\{\{noop\}\}/giu, "");

  // 5. Names.
  if (names.user !== undefined) out = out.replace(/\{\{user\}\}/giu, () => names.user ?? "");
  if (names.char !== undefined) out = out.replace(/\{\{char\}\}/giu, () => names.char ?? "");

  // 6. Comments.
  out = out.replace(/\{\{\/\/([\s\S]*?)\}\}/gu, "");

  // 7. Clock, reverse, random, pick.
  const clock = context.clock ?? {};
  const clockMacros: ReadonlyArray<readonly [RegExp, string | undefined]> = [
    [/\{\{time\}\}/giu, clock.time],
    [/\{\{date\}\}/giu, clock.date],
    [/\{\{weekday\}\}/giu, clock.weekday],
    [/\{\{isotime\}\}/giu, clock.isoTime],
    [/\{\{isodate\}\}/giu, clock.isoDate],
  ];
  for (const [pattern, value] of clockMacros) {
    if (value !== undefined && value !== "") out = out.replace(pattern, () => value);
  }
  out = out.replace(/\{\{reverse:(.+?)\}\}/giu, (_match, value: string) => Array.from(value).reverse().join(""));
  const random = context.random;
  if (random !== undefined) {
    out = out.replace(/\{\{random\s?::?([^}]+)\}\}/giu, (_match, listString: string) => {
      const list = macroList(listString);
      return list[random.nextInt(0, list.length - 1)] ?? "";
    });
  }
  const pickSeed = context.pickSeed;
  if (pickSeed !== undefined) {
    out = out.replace(/\{\{pick\s?::?([^}]+)\}\}/giu, (_match, listString: string, offset: number) => {
      const list = macroList(listString);
      return list[new SeededRandom(`${pickSeed}\u0000${offset}\u0000${raw}`).nextInt(0, list.length - 1)] ?? "";
    });
  }
  return out;
}
