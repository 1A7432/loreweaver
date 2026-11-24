# Implemented: the advisory pack lint

- **Problem:** `--pack` answers "is this a valid pack" and nothing else, and every
  mistake that matters to an author after that point is a perfectly valid pack: a panel
  block bound to a variable no screen receives is omitted silently, by the same
  fail-closed rule that keeps module internals off player screens — a trap the exposure
  model itself created (the H2 plan's Bomb-1 "Author DX" item). The first run of the lint
  found it in the flagship module: the `keeper-gauges` panel bound eleven
  `visibility: keeper` trackers and had never drawn one of them, through three complete
  play-throughs.
- **Decision:** `core/pack_lint.py`, a deterministic read of the source tree with the
  engine's own parsers (no model, nothing imported into a room). Surfaced three ways —
  `python -m app --lint <src-dir>`, after a successful `--pack`, and in every dev-room
  reload summary — and advisory in all three: a finding never fails a build, never blocks
  a mount, and `--lint` exits 0 whatever it finds.
- **Only what is certain.** Each check reports a state the engine's rules make true and
  steps aside where runtime could change the answer: a name a hook, prep script, tier-2
  panel or skill body mentions may be created at the table, so it is never "undeclared";
  an `[InitVar]` block the static parser cannot read turns the tree-shape checks off; a
  switched-off lore entry is parked on purpose and is not judged. A keyless entry is
  reported as reachable "only by semantic recall", not as dead, because vector recall can
  still select it. The cost of a false positive is the whole tool — a lint that cries
  wolf is ignored, and the one real finding goes with the rest.
- **Locale gaps are judged against the pack's own claim.** A pack whose manifest `name`
  carries one language is a complete single-language pack and gets no gap findings; a
  bare string is the author saying "same text everywhere". Only an `{en, zh}`-shaped map
  with one side empty, in a pack that claims both, is a gap.
- **Findings are localized.** A finding is a message key plus parameters, rendered from
  `locales/*/pack_lint.json`; `where` is a structural path. The author-diagnostic
  exemption the parsers use (English text wrapped in a localized summary) was the cheaper
  option and the wrong one here: these notes are the only thing an author reads from the
  module, and most authors on this project write in Chinese.
- **Not done:** tier-2 panel code is counted as a mention but not analysed (it reads
  variables through the client API); unreferenced leaves of an imported MVU tree are not
  reported (real cards carry large trees the model updates by itself); `--pack --json`
  keeps `warnings` (build) and `lint` (advisory) as separate lists.
- **Rule home:** `core/pack_lint.py` module docstring; `docs/authoring.md` §8.
- **Date:** 2026-11-24 (owner asked for the Bomb-1 leftovers).
