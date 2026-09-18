# Implemented: world-card directives fold — a card's own prompts reach the Keeper only through the world path

- **Problem:** a SillyTavern card's `system_prompt` / `post_history_instructions`
  (ST's per-card prompt overrides — where a heavy card's "jailbreak" and its
  run-this-world rules usually live) were dropped silently on every import path,
  while `docs/plugins.md` listed them as consumed. Module authors lost their
  standing instructions with no receipt line saying so.
- **Verdict (owner, 2026-09-18): option B — consume on the keeper's world import,
  strip everywhere else, no full ST override semantics.** The world path copies both
  fields deterministically onto the keeper-only module brief and the prompt builder
  folds them on the two bands an imported preset already uses (head → stable head
  after the preset's head band; post-history → volatile tail after the preset's
  post-history band), under a provenance header that keeps dice/state/secrecy rules
  above them. `pc` and `companion` imports blank both fields structurally
  (`core.card_split`) and itemize them in the stripped receipt. Sub-decisions taken
  with the default recommendation: companion cards strip too (the actor prompt is
  tuned; card system prompts carry ST UI formatting rules that fight it), and v1
  ships no per-room off switch (the receipt names what landed; revisit after live
  play). Option A (doc-only) lost because heavy world cards genuinely author their
  rules there; option C (card overrides preset entries, `{{original}}`,
  `forbid_overrides`) lost to "play experience outranks 1:1 ST reproduction".
- **Reason the gate is structural:** directives are standing Keeper-prompt text, so
  they follow the machinery boundary of the card split — but they are NOT machinery:
  a persona card with a system prompt is still a `kind: character` card, so
  `WorldPayloads.any` (what `core.pack` keys the kind on) excludes them and
  `any_stripped` is the receipt's condition. The fold is gated on the brief's
  existence, which only `.import … world` creates, so a free-sandbox room or a
  player's PC import of the same card never receives them (no-blanket-directives
  doctrine). Head band folds verbatim (cache-stable, static work done at import:
  EJS out, `{{original}}` and comments dropped, `{{char}}` bound); post-history band
  gets the per-turn macro pass lore gets.
- **Rule home:** `core/card_split.py` (the split + `DIRECTIVE_KEYS`),
  `core/module_brief.py` (`prepare_directive`, `directive_bands`),
  `agent/prompt_builder.py::_world_card_directive_bands` (placement — iron rule #5,
  one assembler); `docs/plugins.md` §A.2 (author-facing).
- **Date:** 2026-09-18.
