import { expect, test } from "bun:test";

import { charCount, foldCase } from "./text.ts";

test("foldCase folds per code point, in any script", () => {
  expect(foldCase("Attack")).toBe("attack");
  expect(foldCase("ATTACK at BO")).toBe("attack at bo");
  // Full-width letters fold to their full-width lower case; they are not turned into ASCII.
  expect(foldCase("ＳＴＲ")).toBe("ｓｔｒ");
  expect(foldCase("ＳＴＲ")).not.toBe("str");
  // CJK has no case.
  expect(foldCase("攻击 刀客")).toBe("攻击 刀客");
  // Mixed.
  expect(foldCase("Ａttack 攻 Strasse")).toBe("ａttack 攻 strasse");
  // Where upper-casing and back is how the fold is made.
  expect(foldCase("Straße")).toBe("strasse");
  expect(foldCase("ſ")).toBe("s");
  expect(foldCase("İ")).toBe("i̇");
  // No context-dependent final sigma: each code point on its own.
  expect(foldCase("ΟΔΟΣ")).toBe("οδοσ");
  expect(foldCase("")).toBe("");
});

test("charCount counts code points, not UTF-16 units", () => {
  expect(charCount("")).toBe(0);
  expect(charCount("attack")).toBe(6);
  expect(charCount("攻击")).toBe(2);
  expect(charCount("ＳＴＲ")).toBe(3);
  expect(charCount("𠮷")).toBe(1);
  expect(charCount("a𠮷b")).toBe(3);
  expect(charCount("😀😀")).toBe(2);
  expect("😀😀".length).toBe(4);
});
