/**
 * Keyword matching, after `WorldInfoBuffer.matchKeys` and the key loop of `checkWorldInfo`
 * in SillyTavern `public/scripts/world-info.js`.
 *
 * - The scanned text is the newest `scanDepth` messages, each trimmed, joined so that no
 *   key can span two messages (ST joins with "\n\x01").
 * - Case: both sides lower-cased unless the entry is case-sensitive.
 * - Whole words: a key that is several whitespace-separated words is a plain substring
 *   test; a single-word key must be bounded on both sides by the text's edge or a
 *   character outside `[A-Za-z0-9_]` (ST: `new RegExp('(?:^|\\W)(' + key + ')(?:$|\\W)')`,
 *   a regex WITHOUT the `u` flag, whose `\W` is ASCII). So `gun` IS found in `他拿起gun了`:
 *   CJK letters are boundaries, not word characters. The boundary test is done by hand
 *   over every occurrence, so no content becomes a pattern.
 * - Not supported: ST's `/regex/flags` keys. They would compile content as a regular
 *   expression on every turn with no way to bound its running time on a synchronous
 *   thread; such a key matches as the literal text it is.
 */

const JOINER = "\n\u0001";
/** Characters of transcript scanned per entry at most (newest kept): a work bound. */
export const MAX_SCAN_CHARS = 200_000;

function isAsciiWordUnit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** The text an entry scans: the newest `depth` messages (0 = all of them), trimmed and joined. */
export function scanText(transcript: readonly string[], depth: number): string {
  const window = depth > 0 ? transcript.slice(-depth) : transcript;
  const joined = JOINER + window.map((message) => message.trim()).join(JOINER);
  return joined.length > MAX_SCAN_CHARS ? joined.slice(joined.length - MAX_SCAN_CHARS) : joined;
}

export interface MatchMode {
  readonly caseSensitive: boolean;
  readonly matchWholeWords: boolean;
}

/** Whether `key` occurs in `haystack` under `mode`. `haystack` is already case-folded as `mode` says. */
function keyOccurs(haystack: string, key: string, mode: MatchMode): boolean {
  const needle = mode.caseSensitive ? key : key.toLowerCase();
  if (needle === "") return false;
  if (!mode.matchWholeWords || needle.split(/\s+/u).length > 1) return haystack.includes(needle);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? -1 : haystack.charCodeAt(at - 1);
    const end = at + needle.length;
    const after = end >= haystack.length ? -1 : haystack.charCodeAt(end);
    if ((before < 0 || !isAsciiWordUnit(before)) && (after < 0 || !isAsciiWordUnit(after))) return true;
    from = at + 1;
  }
}

/** A prepared scan: the window text once, case-folded once. */
export class ScanWindow {
  readonly #raw: string;
  #lower: string | undefined;

  constructor(text: string) {
    this.#raw = text;
  }

  /** ST trims every key before matching (`substituted.trim()`); a blank key never matches. */
  matches(key: string, mode: MatchMode): boolean {
    const trimmed = key.trim();
    if (trimmed === "") return false;
    if (mode.caseSensitive) return keyOccurs(this.#raw, trimmed, mode);
    this.#lower ??= this.#raw.toLowerCase();
    return keyOccurs(this.#lower, trimmed, mode);
  }
}
