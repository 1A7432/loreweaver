# Pending: the keeper turn's lore budget wastes slots and drops entries in silence

- **Problem:** three engine-native defects in the per-turn selection, all surfaced while
  measuring M26 and all deliberately left alone by it.
  1. **The slot cut runs before the character cap.** `Worldbook.match` takes
     `visible[:limit]` and only then calls `_cap_entries(…, budget_chars)`, so an entry
     that can never fit — the measured sample card has a 15,685-character block against a
     12,000-character budget — still burns one of the 12 slots every turn.
  2. **`_cap_entries` drops silently.** It skips anything that does not fit and keeps
     going, so a smaller entry ranked below a large one can win a slot the reader has no
     way to observe. M26 added a RECEIPT for the entry an admin just switched on
     (`core.worldbook.probe_turn_budget`), which makes the effect visible at the moment of
     the switch — but it does not change what happens on a turn nobody is watching.
  3. **The variable dump is capped at 100 leaves.** `flatten_leaves(mvu_tree, 100)` in
     `agent/prompt_builder.py` hid 62 of the sample card's 162 leaves from the Keeper. A
     card that keeps its config under `配置.*` at positions 66-76 is visible today by
     luck of ordering, not by design.
- **Options:** (a) cap by characters first and fill the remaining slots with what fits;
  (b) keep the order but skip never-fitting entries before the slot cut (cheapest, fixes
  1 only); (c) make the drop observable — a keeper-side line naming what did not fit this
  turn; (d) raise or prioritise the leaf cap (e.g. exposed prefixes first).
- **Recommendation:** (b) + (c) together, and (d) separately. (a) changes what every
  module sees per turn.
- **Impact:** any of these changes the Keeper's context on every turn of every room, so
  it deserves its own eval run rather than a casual re-tune — the turn-latency doctrine
  (2026-08-21) applies. Cheap to do, expensive to do blind.
- **Date:** 2026-09-22 (raised by M26; the numbers are from its §1.1 measurement).
