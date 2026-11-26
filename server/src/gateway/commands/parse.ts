// Reading a line a player typed: a command, or speech.
//
// The rules, carried over from the reference router (`gateway/commands/router.py`):
//   - the three prefixes `.`, `。` and `/` are equivalent; whitespace may follow one;
//   - the command word is the first whitespace-free token after it, matched exactly
//     (case-folded): `.r3d6` is the token `r3d6`, which is no command — there is no glued
//     form;
//   - a line whose token is no command — or that has no prefix, or no token — is speech;
//     it is said at the table as written, and its `[[expr]]` inline rolls are rolled;
//   - a command's argument string is capped (`MAX_COMMAND_ARG_CHARS` code points); over
//     the cap the command is refused, never cut short.
// Which tokens are commands is the registry's knowledge; this file only splits the line.
import { charCount } from "loreweaver-protocol/v3";

import { foldCase } from "../../core/sheets/text.ts";

export const PREFIXES: readonly string[] = [".", "。", "/"];

/** The longest argument string a text command accepts, in code points. */
export const MAX_COMMAND_ARG_CHARS = 4000;
/** Inline rolls one line of speech may carry. */
export const MAX_INLINE_ROLLS = 8;

const TOKEN = /^(\S+)(?:\s+([\s\S]*))?$/u;
const INLINE = /\[\[([^[\]]+)\]\]/gu;

export interface CommandLine {
  /** The command word, case-folded, prefix removed. */
  readonly word: string;
  /** Everything after it, trimmed. */
  readonly rest: string;
}

/** The command word and argument string of a prefixed line, or null when the line is not shaped like a command. */
export function splitCommand(line: string): CommandLine | null {
  const stripped = line.trim();
  const prefix = PREFIXES.find((candidate) => stripped.startsWith(candidate));
  if (prefix === undefined) return null;
  const match = TOKEN.exec(stripped.slice(prefix.length).trimStart());
  if (match === null) return null;
  return { word: foldCase(match[1] as string), rest: (match[2] ?? "").trim() };
}

/** Whether an argument string is over the cap. */
export function argumentTooLong(rest: string): boolean {
  return rest.length > MAX_COMMAND_ARG_CHARS && charCount(rest) > MAX_COMMAND_ARG_CHARS;
}

/** The `[[expr]]` inline rolls of a line of speech, trimmed, in order. */
export function inlineRolls(line: string): string[] {
  return [...line.matchAll(INLINE)].map((match) => (match[1] as string).trim()).filter((expr) => expr !== "");
}

/** Split on the first `|` (or full-width `｜`): `title | content`. Null when there is none. */
export function splitBar(text: string): readonly [string, string] | null {
  const at = text.search(/[|｜]/u);
  if (at < 0) return null;
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

/** The first whitespace-separated word, case-folded, and the rest. */
export function firstWord(text: string): readonly [string, string] {
  const match = TOKEN.exec(text.trim());
  if (match === null) return ["", ""];
  return [foldCase(match[1] as string), (match[2] ?? "").trim()];
}

const INTEGER = /^[+-]?\d+$/u;

/** A whole number written in plain ASCII digits, or null. */
export function parseInteger(text: string): number | null {
  const trimmed = text.trim();
  if (!INTEGER.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
