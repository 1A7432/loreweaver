# Implemented: display labels beside raw ids — protocol 2.5

- **Problem:** four wire surfaces handed clients bare ids where a table expects words: an
  enum variable's value (《安土》's column panel showed `marching`; its tier-2 page kept
  a private id→word table to hide it), character attribute keys (`APP`), the dice
  frame's `subsystem` (`sanity_check` in Studio's log), and the pregen cast (`claimed_by`
  is a member id like `tui:1a2b3c4d`; the one-line concept never left the server).
- **Verdict:** additive fields only, each beside the id it names — `value_label`,
  `attribute_labels`, `subsystem_label`, pregen `blurb` / `claimed_by_name`. No id,
  key or value changes meaning; a client without a label shows the id, as before.
- **Locale is server-resolved, and `join.locale` is deliberately NOT added.** These
  labels resolve like every existing wire label (`Resource.label`, `variables[].label`,
  `outcome.label`): in the server's `settings.locale`. A per-connection language is a
  separate public-contract decision; the state frame is already built per member, so
  it can arrive later without reshaping these fields. The docs that said "THIS
  viewer's locale" now say what the code does.
- **Templates display the label, never compare it.** `value` stays the raw option id
  because `visible_when`, hooks, `.var set` and the Keeper speak ids; a template
  binding that DISPLAYS a value shows `value_label`, while conditions, badge tones and
  numeric fields read `value`. Python and TypeScript renderers share the vectors.
- **Option names are pack data; the Keeper's define tool gains nothing.** `option_labels`
  rides the card's variable spec (tolerant, like `labels`). The play-phase tool schema
  budget is not spent on it, so a Keeper-defined enum has no labels.
- **Pregens carry the blurb only.** The entry is built from a field whitelist: an
  author's `notes` are keeper-facing (《安土》's pregen notes name clue keys) and the sheet
  is the claimable payload — neither may ride a player frame.
- **The claimer's name is persisted at claim time** (refreshed on a re-claim, cleared
  wherever the claim is) instead of looked up when state is built: an offline claimer
  stays named, and `net.state` needs no keystore wiring. A later rename leaves the
  stored name until the next claim — accepted.
- **Replay freezes `subsystem_label`** with the rest of the recorded dice frame, as
  `expr` and `outcome.label` already are; frames recorded before 2.5 lack it.
- **Rule home:** `docs/protocol.md` (2.5 entry, "Labels and locale");
  `docs/lwf/formats/panels.md` §5.1 rule 7; `docs/lwf/formats/cards.md` (`option_labels`).
- **Date:** 2026-10-22.
