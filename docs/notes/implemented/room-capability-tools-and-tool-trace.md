# Implemented: room-capability tool filtering, a tool trace, panel text, cast commands

- **Problem:** the 2026-08-18 《安土》 run-1 play-test (docs/specs/playtests/) surfaced four
  gaps that were not bugs in any one component but missing seams: (1) five knowledge-pool
  tools are backed by a store only a `--module` TEXT upload builds, yet they sat in every
  world-card room's schema and failed 102 times in 50 turns; (2) five root causes were
  findable only from tool ARGUMENTS and RESULTS, which the harness had to monkey-patch
  `Toolset.dispatch` to capture; (3) `.panel` produced no frame at all, so a tier-2
  panel's `fallback` — written to be read by clients that cannot draw the page — was
  unreachable from a terminal; (4) no keeper command could list or remove a room's NPCs,
  so a mistakenly-registered companion had to be removed by asking the Keeper in narration.
- **Verdict (owner, 2026-08-19): do all four.** In the same batch, two verdicts that
  produced no code: a behavior gate for "the Keeper overrode a player's declared action"
  is NOT wanted (人工抽检 instead), and 《安土》's two knowledge gates opening on day 15 is
  design intent, not a defect.
- **Shape:** `needs=` on `@tool` + `agent.tool_phase.room_capabilities` join `gated` and
  `prep_only` as a third filter of the same family (recomputed per turn, so a room that
  gains a pool mid-session gets the tools back). `TRPG_DEBUG__TOOL_TRACE` writes one JSON
  line per dispatched call; it records keeper-grade content by construction, so it is off
  by default, lands under the private `data_dir`, and both docs say it is not a shareable
  log. `core.panels.render_panel_text` renders a panel per viewer through the SAME
  `core.condexpr` grammar clients use — one evaluator, so server and client cannot disagree
  about visibility — and `.panel [<id>]` answers with it privately while the HUD refresh
  still rides along. `.npc` / `.companion` are keeper-only, private, and never print a
  dossier in a listing.
- **Review follow-up (same day), four judo moves instead of four more branches:**
  (a) the player-name reservation moved from two tools' preambles into the cast WRITER
  (`agent.npc.create_npc` raises `PlayerNameReservedError`; `create_companion` wraps it),
  because the run's actual path was `add_companion`, which the first cut never covered —
  a player is any sheet not owned by a `companion:` uid, plus the claimable pregens,
  casefolded, and an unreadable store refuses rather than waves the write through;
  `add_companion` also undoes its record when the sheet write fails (the run's phantom
  `npc-4`). (b) The trace hangs off `agent.loop._dispatch_one` (`agent.tool_trace`), not
  `Toolset.dispatch`: it names the room, sees a hook veto and a subsystem tool, and the
  dispatcher knows nothing about files. (c) `.panel` attaches its own `Event.panel` to
  the reply; `gateway.turn` no longer recognizes the command by name. (d) The text
  renderer filters repeat matches BEFORE capping (the `* 4` slice silently emptied a
  large MVU tree), drops `hidden` variables and unresolvable choice labels exactly as
  the reference client does, and has its own unit tests. (e) Removing a companion —
  `remove_companion` or `.companion` / `.npc delete` — retires it WHOLE (sheet + roster row
  + record, `agent.kp_tools_companion.retire_companion`): the record-only delete left a
  `companion:<old id>` sheet as a ghost party member no command could reach, and a
  same-name re-add under a fresh id then hit `CharacterNameTakenError` on it — the very
  path `.companion delete` was added for. Not done, deliberately: the
  1000-line file split (`kp_tools_mechanics.py`) — a separate hygiene change, not this
  batch's debt.
- **Rule home:** `docs/plugins.md` Layer B (the three filters); `infra.config.DebugSettings`
  (what the trace holds); `core/panels.py` (rendering semantics); `agent/npc.py`
  (`PlayerNameReservedError`); `gateway/commands.py` (`cmd_panel`, `cmd_cast`).
- **Date:** 2026-08-19.
