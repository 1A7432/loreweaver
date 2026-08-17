# Pending: an installed module rulepack does not become the room’s system

- **Problem:** A pack can ship `rulepacks/harbour.yaml` (`extends: coc7`, extra skill `潮汐学`, `set_keys: [harbour]`). In the 2026-08-17 walkthrough, `.rule harbour` was refused (`.rule` is the house-rule *ladder*, not the system switcher). `.harbour` is not a command unless the pack declares `commands: {harbour: {action: make_char}}`. World-import pregens were built on the room’s current system (`coc7`), so the patch’s new skill never landed on the claimable cast. `set_keys` only feeds the alias resolver.
- **Landed (copy only, 2026-08-17):** install one-liner and authoring/plugin docs no longer promise “switch systems with the usual rule commands.” `pack.install.rulepacks` now says a rulepack is discoverable but does not become the room’s system; create a character on that system (`make_char` word) or name the system on import.
- **Still open:**
  1. Keep it. Authors must declare a `make_char` word and keepers must create/switch characters onto that system. (Copy rewrite is done; this is the current behavior.)
  2. World import (or `.panels enable` / first world card) pins the room’s default system to a pack-declared rulepack when the pack ships exactly one.
  3. Pregen sheet build takes an optional `system:` on the lorecard / pack, independent of the room default.
- **Recommendation:** (1) for activation (don’t silently retarget a live room), plus (3) so a module cast is built on the system the author meant. Owner asked for the copy fix first; do not implement auto-switch or `system:` until a further verdict.
- **Impact (remaining):** `agent/kp_tools_charcard.py` pregen build; pack manifest optional `system:`; `docs/authoring.md` §2 and §7 if (3) lands.
- **Date:** 2026-08-17 (three-persona review); copy landed same day.
