# Implemented: player-invoked module actions, protocol 2.6, and hook capacity

- **Problem:** a simulation-heavy module needs MUD-paced micro-actions a player can take
  without a Keeper round (forage, craft, move a token), but module actions could only be
  called by the Keeper's `module_action` tool; a client had no way to know which actions a
  room offers; and one 40,000-character `hooks.js` with a 1 MiB private-state store could
  not hold a real simulation kernel. The owner also wants this line released as 2.6.0,
  which the version scheme only allows on a protocol 2.6.
- **Verdict (owner):** `defineAction` gains `player: true` and `label` (string or
  `{en, zh}`, ≤ 60 chars); such an action may be run by any member with `.act <name>
  [args]` — handlers see `event.source: "player"` — and its result is PLAYER-VISIBLE output,
  broadcast like a `.ra` result. It shares one runner with the tool path
  (`agent.hook_actions.run_module_action`) and differs only in source, caps and delivery:
  no per-turn cap, no `tool_use` check, `variables_changed` fired once after variable writes,
  a per-room `.act` counter for its seed stream, and a read-and-clear "since your last turn,
  players ran" section in the Keeper's next prompt (player command results never reached
  the Keeper before). Protocol 2.6 (additive) lists the player actions on `state`
  (`state.actions`) from a manifest cached at every engine build. Hook capacity rises to
  400,000 characters per script / 2,000,000 per room, and the private state to 1 MiB per
  value, 64 keys, 4 MiB per room.
- **Reason:** one runner keeps the two lanes from drifting; a player-visible result is the
  trust stance `narrate`/`emitUI` already have, and keeper-only actions are never named to
  players (an unknown name and a keeper-only one get one reply). The Keeper section is the
  whisper pattern (persisted, read-and-clear, assembled only in `agent/prompt_builder.py`),
  so iron rule #5 holds and an undo replays it. Measured on an Apple M5 Pro: an engine with a
  400,000-character script and a full 4 MiB store builds in ~51 ms (~6 ms empty); a full
  store still fits the 12 MiB room-export budget and the undo snapshot path (tested).
- **Rule home:** `core/hooks.py` (`ActionSpec`, the caps), `agent/hook_actions.py`
  (`run_module_action`, `run_player_action`, the `hook_command_seq` and `player_action_log`
  facets), `agent/hook_runtime.py` (`hook_action_manifest` facet), `gateway/commands/world.py`
  (`cmd_act`), `net/state.py` (`_actions`), `docs/protocol.md` "2.6 (additive)",
  `docs/hooks.md` "Player actions", `docs/lwf/formats/skills-hooks.md` §4; tests
  `tests/gateway/test_player_actions.py`, `tests/core/test_hooks.py`,
  `tests/agent/test_hook_state.py`.
- **Date:** 2026-11-25.
