/**
 * Text rules shared by the sheet layer: how a typed stat name is normalised for alias
 * lookup, how a locale picks a label, and how a number arrives from loose input.
 *
 * Names are content (CJK skill names, `驾驶：飞行器`, `Spot_Hidden`), so none of this
 * leans on ASCII-only regex classes; whitespace is the explicit set Python's `str.strip`
 * and `\s` use, because the alias tables were written against that behaviour.
 */

// Python's whitespace (str.isspace): ASCII controls 9-13 and 28-31, space, NEL, NBSP, and
// the Unicode space separators. JavaScript's `\s` differs (it adds U+FEFF and lacks 28-31
// and U+0085), so the class is spelled out.
const WS = "\\t\\n\\u000b\\f\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_WS = new RegExp(`^[${WS}]+`);
const TRAILING_WS = new RegExp(`[${WS}]+$`);
const WS_RUN = new RegExp(`[${WS}]+`, "g");

/** Strip leading and trailing whitespace (the Python set, see above). */
export function stripSpace(text: string): string {
  return text.replace(LEADING_WS, "").replace(TRAILING_WS, "");
}

/**
 * Case folding for name matching. JavaScript has no `casefold`; mapping each code point
 * to upper case and back to lower case reproduces it for the cases that matter here
 * (`ß` → `ss`, `ǅ` → `ǆ`, `İ` → `i̇`, the long `ſ` → `s`) and, being per code point,
 * avoids `toLowerCase`'s context-dependent final sigma. It differs from Unicode case
 * folding only for scripts whose fold target is the upper case (Cherokee).
 */
export function foldCase(text: string): string {
  let out = "";
  for (const ch of text) out += ch.toUpperCase().toLowerCase();
  return out;
}

/**
 * The alias-table key of a typed name: trimmed, case-folded, `_` read as a space, the
 * full-width `：（）` read as ASCII, whitespace runs collapsed to one space. Trimming
 * happens FIRST, so `_str` keeps its leading space and does not match `str` (the alias
 * vectors pin this order). No NFKC: a full-width `ＳＴＲ` is not `STR`.
 */
export function normalizeAlias(name: string): string {
  const folded = foldCase(stripSpace(name))
    .replaceAll("_", " ")
    .replaceAll("：", ":")
    .replaceAll("（", "(")
    .replaceAll("）", ")");
  return folded.replace(WS_RUN, " ");
}

/** A locale tag as label maps key it: lower case, `_` written as `-`. */
export function normalizeLocale(locale: string): string {
  return foldCase(stripSpace(locale)).replaceAll("_", "-");
}

/**
 * The keys to try, in order, for a viewer `locale`: the full tag, its base language,
 * then `en`. A missing or empty locale asks for `en` directly.
 */
export function localeCandidates(locale: string | null | undefined): readonly string[] {
  const tag = typeof locale === "string" ? normalizeLocale(locale) : "";
  if (tag === "") return ["en"];
  const base = tag.split("-", 1)[0] ?? tag;
  return [...new Set([tag, base, "en"])];
}

/** A label for `locale` from a locale→text map, falling back to `en`, then to `id`. */
export function pickLabel(labels: ReadonlyMap<string, string>, locale: string | null | undefined, id: string): string {
  for (const candidate of localeCandidates(locale)) {
    const text = labels.get(candidate);
    if (text !== undefined) return text;
  }
  return id;
}

/**
 * A stat value from loose input (a stored sheet, a tool argument, an import), or `null`
 * when it is not a number:
 * - a safe integer is itself;
 * - a finite non-integer number is truncated toward zero (what the reference engine's
 *   `int()` did: `12.7` → 12, `-2.5` → -2);
 * - a string of decimal digits with an optional sign, surrounded by whitespace at most, is
 *   that integer (`" 80 "` → 80). Any Unicode decimal digit counts, as in the reference
 *   engine's `int()`: full-width `８０` from a CJK input method is 80, Arabic-Indic `٣` is 3.
 *   Nothing else in a string is read (`"12abc"`, `"1e3"`, `"0x10"`, `"1_000"`, `""` are not
 *   numbers);
 * - booleans, null, arrays, objects, `NaN`, `±Infinity`, and anything outside
 *   ±(2^53 − 1) are not numbers. The reference engine read `true` as 1 in formulas and as
 *   0 elsewhere; a boolean has no single honest integer reading, so it has none here.
 */
export function coerceInt(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const truncated = Math.trunc(raw);
    if (!Number.isSafeInteger(truncated)) return null;
    return truncated === 0 ? 0 : truncated;
  }
  if (typeof raw === "string") return parseDecimal(stripSpace(raw));
  return null;
}

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/**
 * The value of one decimal digit character, or null. Unicode assigns decimal digits only
 * in runs of complete 0-9 blocks (a stability guarantee), so a digit's value is its
 * distance from the start of its run, modulo 10.
 */
function digitValue(ch: string): number | null {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (!DECIMAL_DIGIT.test(ch)) return null;
  let start = code;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (code - start) % 10;
}

function parseDecimal(text: string): number | null {
  let sign = 1;
  let rest = text;
  if (rest.startsWith("+") || rest.startsWith("-")) {
    sign = rest.startsWith("-") ? -1 : 1;
    rest = rest.slice(1);
  }
  if (rest === "") return null;
  let value = 0;
  for (const ch of rest) {
    const digit = digitValue(ch);
    if (digit === null) return null;
    value = value * 10 + digit;
    if (!Number.isSafeInteger(value)) return null;
  }
  const signed = sign * value;
  return signed === 0 ? 0 : signed;
}

/** Whether `value` is a sheet integer: a safe integer (negative allowed). */
export function isSheetInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
