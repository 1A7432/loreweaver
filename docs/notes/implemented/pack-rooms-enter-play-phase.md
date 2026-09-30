# Implemented: a pack room enters the play phase when its world card is imported

- **Problem:** `agent.tool_phase.room_phase` read an unpinned room as `play` only once
  `module_init_status` reached ready, and only a `--module` text upload writes that. A
  room whose module came in as a world card (every `.lwpack` module, 《安土》 included)
  never left `prep`: the 2026-09-24 Studio run made 1009 tool calls, all of them offered
  the 71-tool prep set instead of the 34-tool play set, and five of them were catalog
  calls that cannot work in a pack room. M20 B's own reason for deriving the phase ("a
  prep default would mean the milestone did nothing for anyone who never read the docs")
  was exactly what happened to pack rooms. The same run showed why the room could not
  simply be flipped: the Keeper used prep-only tools in play — `create_npc` ×14 (a pack
  seeds no NPC records, so the cast is authored as each one walks on) and
  `update_character_attribute` ×13 (《安土》's 根值, and no play tool writes a sheet
  attribute).
- **Verdict (owner, 2026-09-24, option A):**
  1. `create_npc` and `update_character_attribute` are offered in both phases, and the
     play-phase essentials in `tests/architecture/test_tool_phase_budget.py` pin them.
  2. An unpinned room reads as `play` once its module is in by either road: module
     analysis ready, or the `world_import` marker a world-card import writes.
  3. The M26 setup-pending line reaches the Keeper in either phase, for as long as a
     choice is pending. It was prep-only, and world-card rooms were always in prep, so in
     practice it already showed until set; kept prep-only, it would never have reached
     the Keeper of a pack room at all, and packs are where setup choices come from.
  4. A pack's prep scripts and `.forge` stay prep-only: the room admin pins `.phase prep`
     to run them and `.phase auto` afterwards (docs/plugins.md C.3).
- **Follow-up (review, 2026-09-30):** `import_world_card` wrote `world_import` right after
  the hooks, before the brief, variable specs, overlay and pregen sheets (the last a model
  call). Once the marker also chose the tool phase, an import that failed there left a
  half-built room in play with the bulk tools gone. The marker now lands at the end of a
  successful import, beside the `room_system` pin. It is not cleared on failure: a failed
  re-import keeps the marker its successful predecessor wrote, which is still true, and
  clearing it would drop a campaign in progress back to prep.
- **Budget:** the play set grew from 34 tools / 17.5k characters to 36 / 19.3k, inside the
  unchanged 20k ceiling. The "phasing actually cut something" check (play under half of
  prep) moved to 60%: play is now ~51% of prep, the price the owner accepted.
- **Rejected:** switching after the first turn instead of at import. It would keep a prep
  window open, but the room admin is usually also a player, so the engine cannot tell a
  setup conversation from the first turn of play; the first line typed would flip it.
- **Rule home:** `agent/tool_phase.py` (`room_phase`), `agent/prompt_builder.py`
  (`_setup_pending_line`), `agent/kp_tools_npc.py`, `agent/kp_tools_mechanics.py`,
  `docs/plugins.md` (Layer B.2, C.3), `docs/authoring.md` (`setup: true`); tests
  `tests/agent/test_tool_phase.py`, `tests/agent/test_integration_charcard_worldbook.py`,
  `tests/agent/test_prompt_builder.py`, `tests/architecture/test_tool_phase_budget.py`.
- **Date:** 2026-09-24.
