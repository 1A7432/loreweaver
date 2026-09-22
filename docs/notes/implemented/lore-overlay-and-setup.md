# Implemented: the lore overlay and "set before play" variables

- **Problem:** imported lore is stored faithfully, so the human at the table had no
  switch at all — flipping an entry's `enabled` meant asking the AI Keeper to rewrite the
  author's file, and `.var set` never reached the imported variable tree. The 2026-08-06
  verdict "route curation is keeper-manual" had no manual lever for six weeks. The
  prompting case was heavy SillyTavern cards whose opening-configuration wizard is a
  frontend script we do not run, but the gap is engine-native: about half the surveyed
  card library ships entries nothing here can ever fire.
- **Verdict:** two layers, no inference. (1) A per-room, keeper-only `lore_overlay`
  document keyed by entry TITLE states effective `enabled`/`condition`; one function
  computes effective state for all three activation paths, the stored entry is never
  rewritten, and a re-import keeps the overlay exactly as it keeps variable progress. It
  is written by `.lore enable/disable/bind/unbind/restore/overlay` or by a pack's
  `overlay:` file. (2) A variable may be flagged `setup: true` — a choice the table owes
  the module — which stays pending until the path is written, and `.var set`/`add` now
  reach the imported tree so an admin can make it. The import receipt reports a COUNT of
  entries that landed disabled and keyless; that predicate has no other use anywhere.
- **Reason:** the measured need is "turn a file-disabled entry on, by hand or as a
  function of the variable tree, without editing the file" — and the variable tree is
  already the card's own source of truth, so activation is derived from it rather than
  duplicated beside it. The rejected alternative was inferring families from titles
  (`docs/notes/rejected/sole-active-card-mechanism.md`): it covers 3 of 29 surveyed
  works, misfires on its own home sample in three distinct ways, and its predecessor was
  deleted the day after it shipped. Nothing here reads a title for structure, groups
  entries or offers a pick. Every switch that turns something on returns a budget
  receipt, because "chose = did nothing" is the failure mode this replaces, and it would
  otherwise come back in a new form: the 12-slot cut runs before the character cap, so a
  switched-on entry can be dropped in silence.
- **Two trust lines the review pass added (2026-09-22).** (a) A pack's `expose:` may name
  explicit prefixes only — `*` is refused at parse time, because "publish the whole
  variable tree to the players" is a judgement about one table's spoilers and only the
  keeper sitting at it (`.var expose *`) may make it; how many prefixes a pack's overlays
  publish is disclosed on the trust card BEFORE install, not discovered on the party
  screen after. (b) The admin write path refuses a CONTAINER: "the path exists" is not
  "the path is a value", and `.var set 配置 残酷` replaced a whole subtree with a string
  and then reported the deleted dict as the old value. The model's own `_.set` may still
  restructure the tree — that shape is the module's business — but a human typing a value
  is changing a value.
- **Rule home:** `core/lore_overlay.py`'s module docstring (the concept, the single
  effective-state function, the no-inference line) and AGENTS.md iron rule 3's card-split
  paragraph (the overlay is keeper-only and never rides a player import).
- **Date:** 2026-09-22 (M26; owner verdicts 2026-09-21 — the heuristic layer is dead,
  `.var set` may write the imported tree, the binding command is `.lore bind`, the
  `constant` discrepancy is a documentation fix, the setup flag is in).
