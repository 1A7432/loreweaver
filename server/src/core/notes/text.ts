// Small readers for this directory's payloads. Each core directory keeps its own copy so
// none depends on another's internals. Payloads arrive from the store and from tool
// arguments as loose JSON, so every read checks the shape it needs.

/** A plain JSON object (not an array, not a class instance). */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether `text` is at most `max` code points. Characters are counted in code points so a
 * CJK or emoji name has the same budget as a Latin one; the UTF-16 length bounds the count
 * from both sides, so the exact count is only taken when it can matter.
 */
export function fitsCodePoints(text: string, max: number): boolean {
  if (text.length <= max) return true;
  if (text.length > max * 2) return false;
  let count = 0;
  for (const _ of text) if (++count > max) return false;
  return true;
}

/** A trimmed, non-empty text of at most `max` code points, or null. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && fitsCodePoints(text, max) ? text : null;
}

/** Text that may be empty (a blurb, a note), trimmed and at most `max` code points, or null. */
export function cleanOptionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return fitsCodePoints(text, max) ? text : null;
}

/** Whether a record has exactly the allowed keys (no extra key slips into storage). */
export function onlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) return key;
  return null;
}
