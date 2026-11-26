// "Was this turn checkable?" — the dice-first rule's denominator, ported from the 2.6 eval
// (`scripts/playtest.py` `name_checkable_skill` / `judge_checkable`; its docstrings carry the
// red nights that shaped each condition).
//
// ONE evidence rule, grounded in rule-pack data plus a small request vocabulary: a skill
// name the pack declares appears next to check-request words ("make a Library Use check",
// "掷一次侦查"). "Next to" is three conditions:
//   1. the request word is searched OUTSIDE the term's own span (`投掷` is a skill and
//      contains `掷`: it must not license itself);
//   2. it sits in the same SENTENCE (hard stops bound it; a comma or colon does not), within
//      a window, and is a request WORD, not a character inside another pack term;
//   3. an ASCII term has at least three letters ("the rope is 30 cm short; you roll it up").
// What it deliberately gives up — a checkable action declared in plain words with nobody
// saying "check" — needs the fiction read; that is the Scribe's `unrolled_check`, a live
// lane, not something a deterministic judge should imitate.
import type { RulePack } from "../src/core/rulepacks/index.ts";

export interface CheckEvidence {
  readonly skill: string;
  readonly quote: string;
  readonly source: "player_action" | "keeper_reply";
  readonly rule: "explicit_check_request";
}

const QUOTE_MAX = 160;
const REQUEST_WINDOW = 32;
const MIN_ASCII_TERM_LEN = 3;
const CLAUSE_SPLIT = /[,.!?;:\n。！？；：，]/gu;
const SENTENCE_SPLIT = /[.!?;\n。！？；]/gu;
const CHECK_REQUEST = /\b(?:check|checks|roll|rolls|rolling|test|tests)\b|检定|判定|骰|掷/giu;

const isAscii = (text: string): boolean => /^[\x00-\x7f]*$/u.test(text);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Every skill and attribute surface form of the packs: names, aliases, display names; two characters at least. */
export function checkTerms(packs: readonly RulePack[]): ReadonlySet<string> {
  const terms = new Set<string>();
  for (const pack of packs) {
    for (const name of pack.sheet.defaults.keys()) terms.add(name);
    for (const [variant, canonical] of pack.sheet.aliases) {
      terms.add(variant);
      terms.add(canonical);
    }
    for (const table of pack.sheet.displayNames.values()) for (const display of table.values()) terms.add(display);
  }
  return new Set([...terms].map((term) => term.trim()).filter((term) => [...term].length >= 2));
}

function termPattern(terms: ReadonlySet<string>): RegExp {
  // Longest first, so a compound skill wins over its own prefix.
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(ordered.map((term) => (isAscii(term) ? `\\b${escape(term)}\\b` : escape(term))).join("|"), "giu");
}

function matchesIn(pattern: RegExp, text: string, from: number, to: number): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const match of text.slice(from, to).matchAll(pattern)) {
    found.push({ start: from + match.index, end: from + match.index + match[0].length });
  }
  return found;
}

function quoteSpan(text: string, start: number, end: number): string {
  const before = matchesIn(CLAUSE_SPLIT, text, 0, start);
  const left = before.length === 0 ? 0 : (before[before.length - 1] as { end: number }).end;
  const after = matchesIn(CLAUSE_SPLIT, text, end, text.length);
  const right = after.length === 0 ? text.length : (after[0] as { start: number }).start;
  return text.slice(left, right).split(/\s+/u).filter((part) => part !== "").join(" ").slice(0, QUOTE_MAX);
}

function requestBounds(text: string, start: number, end: number): readonly [number, number] {
  const floor = Math.max(0, start - REQUEST_WINDOW);
  const ceiling = Math.min(text.length, end + REQUEST_WINDOW);
  const before = matchesIn(SENTENCE_SPLIT, text, floor, start);
  const left = before.length === 0 ? floor : (before[before.length - 1] as { end: number }).end;
  const after = matchesIn(SENTENCE_SPLIT, text, end, ceiling);
  return [left, after.length === 0 ? ceiling : (after[0] as { start: number }).start];
}

function requestWordOutsideTerms(text: string, lo: number, hi: number, spans: readonly { start: number; end: number }[]): boolean {
  return matchesIn(CHECK_REQUEST, text, lo, hi).some((word) => !spans.some((span) => span.start <= word.start && word.start < span.end));
}

/** The skill `text` explicitly calls a roll for, with the clause that says so; else null. */
export function nameCheckableSkill(text: string, terms: ReadonlySet<string>): { readonly skill: string; readonly quote: string } | null {
  if (text === "" || terms.size === 0) return null;
  const spans = matchesIn(termPattern(terms), text, 0, text.length);
  for (const span of spans) {
    const term = text.slice(span.start, span.end);
    if (isAscii(term) && term.length < MIN_ASCII_TERM_LEN) continue;
    const [left, right] = requestBounds(text, span.start, span.end);
    if (requestWordOutsideTerms(text, left, span.start, spans) || requestWordOutsideTerms(text, span.end, right, spans)) {
      return { skill: term, quote: quoteSpan(text, span.start, span.end) };
    }
  }
  return null;
}

/** Evidence that this turn should have rolled dice: the player's side first, then the Keeper's. */
export function judgeCheckable(action: string, reply: string, terms: ReadonlySet<string>): CheckEvidence | null {
  for (const [text, source] of [
    [action, "player_action"],
    [reply, "keeper_reply"],
  ] as const) {
    const named = nameCheckableSkill(text, terms);
    if (named !== null) return { ...named, source, rule: "explicit_check_request" };
  }
  return null;
}
