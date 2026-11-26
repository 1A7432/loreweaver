import { expect, test } from "bun:test";

import { builtInSkillRegistry, liftsOutputFilter } from "../../src/core/skills/index.ts";
import {
  MAX_REVIEW_WORDS,
  parseReviewList,
  REVIEW_OFF,
  reviewFact,
  reviewFilter,
  reviewNarrative,
  type ReviewFilter,
} from "../../src/gateway/review.ts";

const OPEN = { unfiltered: false };

function filter(inline: string): ReviewFilter {
  const parsed = parseReviewList(inline);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.filter;
}

test("off by default: no word list, no change, for either entry point", () => {
  for (const review of [reviewNarrative, reviewFact]) {
    expect(review(REVIEW_OFF, OPEN, "anything at all", "en")).toEqual({ text: "anything at all", allowed: true, disposition: "allow", level: 0, hits: [], lifted: false });
  }
  expect(parseReviewList("")).toEqual({ ok: true, filter: REVIEW_OFF });
  expect(parseReviewList(" , :3 ,")).toEqual({ ok: true, filter: REVIEW_OFF });
});

test("a word list masks whole words, bypass-resistant, on the original characters", () => {
  const words = filter("darn,heck:2");
  expect(reviewNarrative(words, OPEN, "Darn it, you heck-hound.", "en")).toMatchObject({
    text: "[filtered] it, you [filtered]-hound.",
    disposition: "mask",
    allowed: true,
    level: 2,
    hits: ["darn", "heck"],
  });
  // Spacing, dots and zero-width characters between letters; full-width forms; case.
  expect(reviewNarrative(words, OPEN, "d.a.r.n / d a r n / ｄａｒｎ / d​arn / DARN", "en").text).toBe(
    "[filtered] / [filtered] / [filtered] / [filtered] / [filtered]",
  );
  // Whole words only: no Scunthorpe problem.
  expect(reviewNarrative(words, OPEN, "darning needles", "en").text).toBe("darning needles");
  expect(reviewFact(words, OPEN, "darn", "zh").text).toBe("[已屏蔽]");
});

test("a word at danger level blocks", () => {
  const words = filter("darn:1,curse:4");
  const result = reviewFact(words, OPEN, "a darn curse", "en");
  expect(result).toMatchObject({ allowed: false, disposition: "block", level: 4, text: "a [filtered] [filtered]" });
});

test("a mature skill lifts the filter for its room", () => {
  const words = filter("darn");
  const registry = builtInSkillRegistry();
  const room = { unfiltered: liftsOutputFilter(registry, ["mature-mode"]) };
  expect(reviewNarrative(words, room, "darn", "en")).toEqual({ text: "darn", allowed: true, disposition: "allow", level: 0, hits: [], lifted: true });
  expect(reviewNarrative(words, { unfiltered: liftsOutputFilter(registry, ["image-gen"]) }, "darn", "en").text).toBe("[filtered]");
});

test("an over-long list is refused, not cut", () => {
  const pairs = Array.from({ length: MAX_REVIEW_WORDS + 1 }, (_, index) => [`w${index}`, 1] as const);
  expect(reviewFilter(pairs)).toEqual({ ok: false, code: "too_many_words" });
  expect(reviewFilter([["x".repeat(101), 1]])).toEqual({ ok: false, code: "word_too_long" });
});
