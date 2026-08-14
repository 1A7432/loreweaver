# Implemented: the preset band fold — markers place text, v1 of the style fold

- **Problem:** the v0 preset fold kept every text block of an imported ST completion
  preset but discarded its geometry — all text collapsed into one stable-head block.
  ST authors engineer exactly three positions (top-of-prompt style, framing around
  world info, and post-history commands — the position-critical slot closest to
  generation), so a preset tuned in SillyTavern lost most of its force here
  (UPSTREAM_TODO item 9, second half: "the finer marker→section mapping contract").
- **Decision (owner, 2026-08-15): four bands, faithful post-history, no 8-way map.**
  `core.preset.style_bands` walks the segment sequence monotonically and splits at
  the three anchors with an honest engine counterpart: `head` (before any marker) →
  stable head, the v0 spot, before skill bodies; `pre_lore`/`post_lore` (around
  `worldInfoBefore`/`worldInfoAfter`) → bracketing the world-lore section;
  `post_history` (after `chatHistory`) → late in the volatile tail. The other five
  ST anchors only advance the walk — mapping them to engine sections would be false
  precision (charDescription ≠ the module pool). Owner's framing: play experience
  outranks 1:1 SillyTavern reproduction; losing some information is fine.
- **The geometry is real, and free.** The volatile tail rides the wire AFTER the
  replayed history as the per-turn state message (M20 A1), so `post_history` text
  genuinely sits closest to generation — and every displaced band lands in a message
  that rebuilds each turn anyway: zero cache cost. The head band keeps the stable
  head byte-identical for marker-less presets (v0 compatibility, pinned by test).
- **Order within the tail:** preset bands are STANDING directives, so `post_history`
  still yields the very end to the engine's per-turn direction (scribe whispers,
  hook injections, chronicle recall). Each displaced band carries the provenance
  header — the model always knows this is a keeper-enabled style layer, not engine
  authority.
- **Risk stance:** post-history is where ST jailbreak culture lives; faithful
  placement is consistent with the ST trust model (keeper-explicit `.preset enable`
  per room, operator's box) and the nightly red-line evals stay the behavioral
  guarantee.
- **Rule home:** `core/preset.py::style_bands` (the contract);
  `agent/prompt_builder.py::_enabled_preset_bands` (the placements — iron rule #5,
  one assembler); `docs/plugins.md` §A.6 (author-facing).
- **Date:** 2026-08-15.
