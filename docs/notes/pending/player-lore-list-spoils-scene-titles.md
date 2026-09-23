# Pending: a player's `.lore list` shows every non-secret scene title, endings included

- **Problem:** `.lore list` is open to players by design (secret entries are hidden,
  `gateway/commands/world.py cmd_lore`). In 《安土》 v0.2.4 a player's list is 65 titles,
  among them every scene of every act — including ones whose activation condition is far
  from met — and every ending: "二幕·圣街倒查②挪水纪要（七个签名）" all but states sentinel
  ④ 圣街七签 (earned only through N6), "尾声·木言（最后一份报告，以月为单位）" names an
  ending. Seen 2026-09-23 on the QQ bridge (a demoted admin's listing); the same list
  reaches Studio and the terminal. The pack's sentinel test greps the five words, not
  their paraphrase in a title.
- **Options:** (a) a player's listing omits entries whose activation condition is not
  met right now (engine; does not cover unconditional endings like 尾声·木言);
  (b) players do not get `.lore list` at all (engine; loses a feature);
  (c) 《安土》 retitles its public scene/ending entries so a title never says more than the
  table has earned (content; the pack test learns the paraphrases); (d) (a) + (c).
- **Recommendation:** (d). (a) is the structural half — a condition-gated entry is not
  yet part of the players' world, so listing it is a spoiler by construction for every
  pack, not just this one; (c) covers what (a) cannot.
- **Impact:** player-visible listing shrinks to what is live; keeper listing unchanged.
  Iron rule #3 territory, hence an owner call.
- **Date:** 2026-09-23.
