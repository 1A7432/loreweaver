# Implemented: a sole bundled rulepack pins the room system on world import

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
- **Rule home:** `core/pack.py::installed_pack_sole_rulepack`,
  `agent/kp_tools_charcard.py::import_world_card`,
  `agent/kp_tools_subsystems.py::room_rulepack` (fallback order).
- **Date:** 2026-08-17.
