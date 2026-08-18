# Implemented: the playtest harness plays pack modules, not just module text

- **Problem:** `scripts/playtest.py` only knew module TEXT files (`module_fulltext`
  → knowledge pool), so a pack module (a lorecard world card with secret entries,
  typed variables, hooks, a skill and panels) — the flagship 《安土》 first of all —
  could not be smoke-tested against a real model with the sentinel gate at all.
  Two engine gaps surfaced on the way: keeper tool variable writes never fired
  `variables_changed`, and `query_lore` returned nothing but a module's always-on
  entries.
- **Verdict:** `--pack <src-dir|.lwpack> --world-card <path in pack> [--pc-system]`
  builds/installs into the run's data dir exactly like `app.py --install`, wires
  skill/rulepack discovery at that dir, then lands the card through the REAL keeper
  command surface (`.import <card> <system> world`, `.panels enable`, `.skill enable`)
  and scores leaks against the card's secret entries; the leak-snippet splitter cuts
  on CJK punctuation. `variables_changed` now carries keeper-tool writes; `match()`
  grew `include_constant` and the browse tool passes False.
- **Reason:** the module's own red lines (sentinel zero-leak, dice-first) must be
  provable against a live model through the same door a keeper walks through, not
  through a text-file approximation of the module.
- **Rule home:** `scripts/playtest.py` (`install_pack_for_playtest`, `_setup_world_card`),
  `agent/kp_tools_vars.py::_record_variable_write`, `core/worldbook.py::Worldbook.match`.
- **Date:** 2026-08-18.
