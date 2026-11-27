// The two text helpers the form grammar and the argument check need. The SDK imports nothing
// from the server or the protocol package, so each is restated here with exactly the behaviour
// of the engine's own: `foldCase` of `server/src/core/sheets/text.ts` and `charCount` of the
// protocol package. A test on the server's side holds that the pairs agree
// (`server/test/agent/sdk_text.test.ts`): change one, change the other.

/**
 * Case folding for matching typed words. JavaScript has no `casefold`; mapping each code
 * point to upper case and back to lower case reproduces it for the cases that matter here
 * (`ß` → `ss`, `ǅ` → `ǆ`, `İ` → `i̇`, the long `ſ` → `s`) and, being per code point, avoids
 * `toLowerCase`'s context-dependent final sigma.
 */
export function foldCase(text: string): string {
  let out = "";
  for (const ch of text) out += ch.toUpperCase().toLowerCase();
  return out;
}

/** The length of a text in code points: the unit every character limit counts in. */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}
