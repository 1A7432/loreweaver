# Implemented: the Keeper's history names who spoke

- **Problem:** the room echo already attributed each turn (`player_action.name`
  via `_display_name`), but the line the Keeper persisted and replayed was the
  bare player text. Two humans at one table looked like one ChatGPT user, so
  the model kept addressing the first PC and recast the second as an AI
  companion (issue #29).
- **Decision:** wrap at the gateway, with the same display name as the echo,
  before `run_kp_turn`. Format `[{name}]\n{text}` (`prompt.speaker_line`). The
  echo stays unprefixed. Direct `run_kp_turn` callers (loop unit tests, the
  cache-layout oracle) stay verbatim. Standing style forbids recasting a human
  PC as a companion and tells the model to address the tagged speaker by name.
  No volatile "who is acting" block — that identity now lives on the player
  line, which joins history next turn and rides the cached prefix. Retrieval
  and `turn_start` hooks see only `player_line_body` (the tag is not a lore
  keyword): `ctx.extra["user_message"]`, the hook payload, and
  `_recent_transcript`.
- **Reason:** the engine already knew the speaker; only the model-visible
  conversation dropped it. Old rooms are not rewritten; new turns tag going
  forward.
- **Rule home:** `core.player_line` (`attributed_player_line` /
  `split_player_line` / `player_line_body`; `agent.player_line` re-exports it
  for the Keeper side); hub + CLI wrap, the loop/assembler strip for
  retrieval, and the session report (Markdown + HTML) prints the name as the
  line's label and the bare text as its body; `locales/{en,zh}/prompt.json` (`prompt.speaker_line`,
  `prompt.style.narrative`, `prompt.style.companions`).
- **Date:** 2026-09-01.
