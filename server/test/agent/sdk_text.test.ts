// The SDK restates two text helpers of the server (`foldCase`) and of the protocol package
// (`charCount`), because it imports from neither. The form grammar and the argument check
// run in the engine and in the author's test host with the SDK's, so the two must agree with
// the originals on every input: this is the test that says so.
import { expect, test } from "bun:test";
import { charCount } from "loreweaver-protocol/v3";
import { charCount as sdkCharCount, foldCase as sdkFoldCase } from "loreweaver/runner";

import { foldCase } from "../../src/core/sheets/text.ts";

const CORPUS: readonly string[] = [
  "",
  " ",
  "attack",
  "ATTACK",
  "Attack At Bo",
  "aTtAcK_1",
  // CJK, which has no case, and CJK mixed with Latin.
  "攻击",
  "攻击 刀客",
  "j 攻 刀客",
  "ＡＴＴＡＣＫ 攻击 Ｂo",
  // Full-width letters and digits, punctuation and the ideographic space.
  "ＳＴＲ",
  "ｓｔｒ",
  "Ｔｅｓｔ１２３",
  "：（）　x",
  // Special folds: sharp s, long s, dotted capital I, dotless i, titlecase digraphs.
  "Straße",
  "STRASSE",
  "ſ",
  "İstanbul",
  "ıI",
  "ǅ ǈ ǋ",
  // Greek, with a final sigma, and Cyrillic.
  "ΟΔΟΣ Σ",
  "Привет МИР",
  // Combining marks, astral code points, emoji.
  "é é",
  "𠮷野家",
  "𝐀𝐁𝐂 𐐀𐐁",
  "😀 Ａ 😀",
  "a‍b",
];

function* generated(): Generator<string> {
  const alphabet = [..."aAbBzZ09_ ßſİıΣσςǅＡａＺ攻击刀客あカ한𠮷😀é́　-./{}"];
  let state = 0x2545f491;
  for (let count = 0; count < 3000; count++) {
    let text = "";
    for (let length = state % 12; length > 0; length--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      text += alphabet[(state >>> 8) % alphabet.length];
    }
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield text;
  }
}

test("the SDK's foldCase is the server's, on cases that matter and on generated text", () => {
  for (const text of [...CORPUS, ...generated()]) expect(sdkFoldCase(text)).toBe(foldCase(text));
});

test("the SDK's charCount is the protocol package's, on cases that matter and on generated text", () => {
  for (const text of [...CORPUS, ...generated()]) expect(sdkCharCount(text)).toBe(charCount(text));
});

test("the corpus exercises what it is for", () => {
  // Folds that change the text, and some that must not.
  expect(sdkFoldCase("Straße")).toBe("strasse");
  expect(sdkFoldCase("ＳＴＲ")).toBe("ｓｔｒ");
  expect(sdkFoldCase("攻击")).toBe("攻击");
  // Counts that differ from the UTF-16 length.
  expect(sdkCharCount("𠮷野家")).toBe(3);
  expect("𠮷野家".length).toBe(4);
  expect(new Set([...generated()]).size).toBeGreaterThan(2000);
});
