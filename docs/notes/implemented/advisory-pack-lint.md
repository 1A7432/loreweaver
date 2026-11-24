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
- **Findings are keeper-grade text.** A finding names what it is about: a secret
  entry's title, a keeper-visibility variable, an unexposed variable path. The first
  version appended them to the dev room's reload summary, which the file watcher
  publishes to the whole room and which a `.dev` command reply broadcasts — an
  independent review reproduced a player receiving a secret entry title. They are now a
  separate event addressed to the mounting admin's `user_key` (`send_lint`; the mount
  record keeps its `owner`), and no recipient means nothing is sent, never "everyone".
  `tests/gateway/test_dev_room.py` pins it with a player in the room.
- **Only what is certain.** Each check reports a state the engine's rules make true and
  steps aside where runtime could change the answer. "Would a screen receive this" is
  asked of the real document projections, never re-derived. A name that anything reaching
  the Keeper's context or running at the table mentions — a hook, a lore template's
  `setvar`, card prose telling the model to `_.set` a path, a skill body, a bundled
  preset, tier-2 panel code — may be created there, so it is never "undeclared"; a hook
  that BUILDS a variable name, or an `[InitVar]` block the static parser cannot read,
  turns the tree-shape checks off; a file too large to read turns the "nothing mentions
  it" checks off; a switched-off lore entry is parked on purpose and is not judged; one
  id declared two ways by two cards is read the way that reports nothing. A keyless entry
  is reported as reachable "only by semantic recall", not as dead, and not at all when a
  template pulls it in by title (`getwi`). The cost of a false positive is the whole
  tool — a lint that cries wolf is ignored, and the one real finding goes with the rest.
  The same review built ten correct packs that the first version flagged; each is now a
  test in `tests/core/test_pack_lint.py`.
- **It cannot raise, stall or wander.** Every tree it walks is bounded (the variable tree
  goes through the room's own `normalize_tree`), a row the import would choke on is an
  `unreadable` finding instead of a `TypeError`, `--lint --json` answers with one JSON
  object even if the lint itself fails, and the dev room runs it off the event loop.
- **Two engine fixes fell out of it.** `core.condexpr.referenced_paths` stopped a path at
  a numeric or bracket segment (`队伍.0.血量` came back as two names); and
  `Worldbook.import_entries` returned 0 for SillyTavern's own index-keyed world-info
  shape (`{"entries": {"0": …}}`), which the pack build had always accepted — such a
  lorebook built, installed, and then imported nothing.
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
