// Output review: the last check on text before it reaches the table — the word filter.
//
// Every table-visible text the engine produces passes through here exactly once, at the
// moment it is final: the Keeper's narrative after its variable blocks and text tool calls
// are stripped (§12 3.2 step 11c), a module's table fact before it is published as a
// system narrative event (steps 2 and 13), and the text the authoring lane wrote for a new
// character before it is stored (`genchar`, a player's card import). Three entry points,
// `reviewNarrative`, `reviewFact` and `reviewAuthored`, so a call site says which it is;
// all run the same filter.
//
// Ported from the reference's `gateway/ops.py` `Censor`:
//   - it ships OFF: no built-in word list. A filter built from nothing is an explicit no-op,
//     never a false impression of moderation; the operator supplies the list;
//   - matching is bypass-resistant: input and words are compared after NFKC and case
//     folding, letters of a word may be separated by spacing, dots, asterisks, hyphens,
//     middle dots and zero-width characters, and a word matches only as a whole word
//     (no Scunthorpe problem). Masks land on the ORIGINAL characters;
//   - each word has a level 1-5; a hit masks it, and a hit at level 4 (danger) or above
//     also marks the text as blocked. The caller decides what a block means (the
//     reference only ever used the masked text);
//   - a room with a mature skill enabled (`content-rating: mature | explicit`) is not
//     filtered at all: the admin lifted it for that room (`core/skills`).
//
// One departure: case folding is `toLowerCase` after NFKC, JavaScript's nearest to Python's
// `casefold` (they differ on a handful of characters such as `ß`).
import enReview from "../../locales/en/review.json" with { type: "json" };
import zhReview from "../../locales/zh/review.json" with { type: "json" };

import { type Catalog, translate } from "../infra/i18n.ts";

/** This area's messages: only the mask that replaces a filtered word. */
export const REVIEW_CATALOG: Catalog = { en: enReview, zh: zhReview };

export const REVIEW_LEVELS = { notice: 1, caution: 2, warning: 3, danger: 4, forbidden: 5 } as const;
export type ReviewLevel = 1 | 2 | 3 | 4 | 5;

/** A word list longer than this is refused, not cut. */
export const MAX_REVIEW_WORDS = 10_000;
/** One word, in code points. */
export const MAX_REVIEW_WORD_CHARS = 100;
/** The inline form of a list (`word[:level],…`), in code points. */
export const MAX_REVIEW_INLINE_CHARS = 1_000_000;

// Inter-letter noise allowed inside a word: whitespace, dot, asterisk, hyphen, middle dot,
// and the zero-width / soft-hyphen format characters. None is a word character, so the
// whole-word lookarounds around a hit are unaffected.
const SEPARATOR = "[\\s.*\\-\\u00b7\\u200b\\u200c\\u200d\\ufeff\\u00ad]*";
// Python's `\w` on text: letters, digits (any script) and the underscore.
const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}_]";

interface CompiledWord {
  readonly word: string;
  readonly level: ReviewLevel;
  readonly pattern: RegExp;
}

/** The filter's settings, compiled once. Build with `reviewFilter`; `REVIEW_OFF` has no words. */
export interface ReviewFilter {
  readonly words: readonly CompiledWord[];
}

export const REVIEW_OFF: ReviewFilter = Object.freeze({ words: Object.freeze([]) });

/** What the room says about filtering: a mature skill lifts the filter. */
export interface ReviewRoom {
  readonly unfiltered: boolean;
}

export type ReviewDisposition = "allow" | "mask" | "block";

export interface ReviewResult {
  /** The text to show: the input with every hit masked, or the input unchanged. */
  readonly text: string;
  /** False when a hit reached the danger level (`disposition: "block"`). */
  readonly allowed: boolean;
  readonly disposition: ReviewDisposition;
  /** The highest level hit; 0 for none. */
  readonly level: number;
  /** The words that matched, in list order. */
  readonly hits: readonly string[];
  /** The room's mature skill lifted the filter for this text. */
  readonly lifted: boolean;
}

export type ReviewListRefusal = "too_many_words" | "word_too_long" | "too_long";

export type ReviewListResult = { readonly ok: true; readonly filter: ReviewFilter } | { readonly ok: false; readonly code: ReviewListRefusal };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** NFKC + lower case, one original character at a time, with each folded unit's origin index. */
function fold(text: string): { readonly folded: string; readonly origin: readonly number[] } {
  let folded = "";
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = char.normalize("NFKC").toLowerCase();
    for (let unit = 0; unit < piece.length; unit++) origin.push(index);
    folded += piece;
    index += char.length;
  }
  return { folded, origin };
}

function escapeChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/-]/gu, "\\$&");
}

function compileWord(word: string): RegExp | null {
  const letters = [...fold(word).folded].filter((char) => !/\s/u.test(char));
  if (letters.length === 0) return null;
  const core = letters.map(escapeChar).join(SEPARATOR);
  return new RegExp(`(?<!${WORD_CHAR})${core}(?!${WORD_CHAR})`, "gu");
}

function clampLevel(level: number): ReviewLevel {
  if (!Number.isFinite(level)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(level))) as ReviewLevel;
}

/**
 * A filter from `[word, level]` pairs (a later duplicate wins). Words that fold to nothing
 * are skipped; an empty list is `REVIEW_OFF`.
 */
export function reviewFilter(words: Iterable<readonly [string, number]>): ReviewListResult {
  const byWord = new Map<string, ReviewLevel>();
  for (const [word, level] of words) {
    const trimmed = word.trim();
    if (trimmed === "") continue;
    if (codePoints(trimmed) > MAX_REVIEW_WORD_CHARS) return { ok: false, code: "word_too_long" };
    byWord.set(trimmed, clampLevel(level));
    if (byWord.size > MAX_REVIEW_WORDS) return { ok: false, code: "too_many_words" };
  }
  const compiled: CompiledWord[] = [];
  for (const [word, level] of byWord) {
    const pattern = compileWord(word);
    if (pattern !== null) compiled.push({ word, level, pattern });
  }
  return { ok: true, filter: compiled.length === 0 ? REVIEW_OFF : Object.freeze({ words: Object.freeze(compiled) }) };
}

/**
 * The operator's inline list, `word[:level],word2[:level2],…` (one environment variable,
 * no file). A missing or unreadable level is 1 (notice).
 */
export function parseReviewList(inline: string): ReviewListResult {
  if (codePoints(inline) > MAX_REVIEW_INLINE_CHARS) return { ok: false, code: "too_long" };
  const pairs: [string, number][] = [];
  for (const item of inline.split(",")) {
    const at = item.lastIndexOf(":");
    const word = (at < 0 ? item : item.slice(0, at)).trim();
    const levelText = at < 0 ? "" : item.slice(at + 1).trim();
    const level = /^\d{1,2}$/u.test(levelText) ? Number(levelText) : 1;
    if (word !== "") pairs.push([word, level]);
  }
  return reviewFilter(pairs);
}

function mask(text: string, spans: [number, number][], replacement: string): string {
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return out + text.slice(cursor);
}

function review(filter: ReviewFilter, room: ReviewRoom, text: string, locale: string): ReviewResult {
  const pass = (lifted: boolean): ReviewResult => ({ text, allowed: true, disposition: "allow", level: 0, hits: [], lifted });
  if (text === "" || filter.words.length === 0) return pass(false);
  if (room.unfiltered) return pass(true);
  const { folded, origin } = fold(text);
  const spans: [number, number][] = [];
  const hits: string[] = [];
  let level = 0;
  for (const word of filter.words) {
    let matched = false;
    word.pattern.lastIndex = 0;
    for (const match of folded.matchAll(word.pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (end <= start) continue;
      const first = origin[start] as number;
      const lastOrigin = origin[end - 1] as number;
      // The original character at `lastOrigin` may be a surrogate pair.
      const lastLength = (text.codePointAt(lastOrigin) ?? 0) > 0xffff ? 2 : 1;
      spans.push([first, lastOrigin + lastLength]);
      matched = true;
    }
    if (matched) {
      hits.push(word.word);
      level = Math.max(level, word.level);
    }
  }
  if (spans.length === 0) return pass(false);
  const blocked = level >= REVIEW_LEVELS.danger;
  return {
    text: mask(text, spans, translate(REVIEW_CATALOG, locale, "review.mask")),
    allowed: !blocked,
    disposition: blocked ? "block" : "mask",
    level,
    hits,
    lifted: false,
  };
}

/** The Keeper's (or an NPC's) final narrative text, just before it is published. */
export function reviewNarrative(filter: ReviewFilter, room: ReviewRoom, text: string, locale: string): ReviewResult {
  return review(filter, room, text, locale);
}

/** A module's table fact, just before it is published as a system narrative event. */
export function reviewFact(filter: ReviewFilter, room: ReviewRoom, text: string, locale: string): ReviewResult {
  return review(filter, room, text, locale);
}

/**
 * A free-text field the authoring lane wrote for a new character (`genchar`, a player's card
 * import: the occupation, the backstory, the notes), before it is stored on the sheet.
 */
export function reviewAuthored(filter: ReviewFilter, room: ReviewRoom, text: string, locale: string): ReviewResult {
  return review(filter, room, text, locale);
}
