// A view value as text, for comparing one computation with the last one sent and for
// measuring it against the size cap.

/**
 * JSON with every object's keys sorted: two values that differ only in key order (a
 * module that builds its object in another order this time) compare equal. Keys are
 * compared by code unit, which is deterministic for any text.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    // `defineProperty`: a key from content may be `__proto__`.
    Object.defineProperty(out, key, { value: sortKeys((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const encoder = new TextEncoder();

/** The UTF-8 size of a text, in bytes. */
export function byteSize(text: string): number {
  return encoder.encode(text).length;
}
