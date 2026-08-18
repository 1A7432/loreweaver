# Implemented: a pack's character system pins the room system on world import

- **Problem:** a pack shipping `rulepacks/harbour.yaml` (`extends: coc7`, new
  skills) installed as discoverable, but world-import pregens were built on the
  room's CURRENT system, so the author's skills never reached the claimable
  cast; the install banner promised "usual rule commands" that don't exist.
- **Verdict:** owner picked option 2 (2026-08-17) — when the imported world card
  lives in an installed pack whose manifest declares exactly ONE rulepack (and
  discovery can load it), `.import … world` pins that system as the room's
  default (`room_state["room_system"]`, module-provenance facet, dies with
  `reset all`). An explicit `system` argument wins and never pins; two bundled
  rulepacks is an ambiguity the pin refuses to guess about. Install/docs copy
  was fixed the same day (no more "usual rule commands").
- **Reason:** a module that ships one rule system means its cast and its
  table to run on that system; making the keeper reverse-engineer that from a
  `set_keys` alias was the walkthrough's sharpest author-side trap.
- **Widened 2026-08-18 (owner suggestion):** a pack that ships SEVERAL rulepacks
  is not automatically ambiguous — the common shape is the module's real system
  beside a subsystem-only patch (《安土》: `coc7-antu` + `baying`). Among the
  bundled rulepacks, the ones that declare a make-character word OF THEIR OWN
  (`core.rulepacks.own_make_char_word` — an inherited `.coc` routes to the base
  and does not count) are the character systems; when exactly one does, that is
  the pack's character system and it pins on world import. Zero or several such
  candidates stay ambiguous; a bundled rulepack discovery cannot load makes the
  whole pack undecidable. The same lookup now also decides a CHARACTER import
  with no system named (`.import <ref> pc` — the studio/TUI click path): a card
  that ships in such a pack is built on the pack's character system rather than
  the room's default, without pinning the room (pinning stays the keeper's
  world import's job).
- **Rule home:** `core/pack.py::installed_pack_character_system`,
  `core/rulepacks.py::own_make_char_word` (shared with `net/state._rule_systems`),
  `agent/kp_tools_charcard.py::import_world_card` / `import_character`,
  `agent/kp_tools_subsystems.py::room_rulepack` (fallback order).
- **Date:** 2026-08-17; widened 2026-08-18.
