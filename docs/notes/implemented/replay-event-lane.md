# Implemented: the join-replay event lane anchors to transcript messages

- **Problem:** the lane (`turn_event_history`, 4aced11) keyed rolls and NPC lines by
  TURN NUMBER and replayed them before that turn's reply. The number is not one-to-one
  with transcript messages: a companion sub-turn (`gateway.director`) runs inside the
  player's turn and advances the counter mid-turn, so two messages share a stamp and a
  stamp can have no message — a typed roll keyed to the gap was orphaned, an outer
  turn's rolls replayed under the companion's line, and the outer turn's player message
  (written together with the reply, at the end) came AFTER the companion's exchange for
  anyone replaying. Typed rolls (`.ra`, `r 3d6`) were not recorded at all.
- **Verdict (owner, 2026-08-18):** persist the player's message when the turn STARTS and
  the reply when it ENDS (`agent.history.append_message`), so a nested exchange lands
  between them in the order the table saw; record every public event the moment it is
  published, anchored to the message the transcript currently ends on
  (`agent.history.current_leaf` → `after_id`; `""` = before the first message); replay
  walks the last 30 messages and emits each anchored event right after its message.
  Turn numbers stay on the record only for the lane's 40-turn window.
- **Consequences:** `.undo` needs no lane handling — turn N's rolls are in the lane
  before its snapshot is taken, the abandoned future's are not; a failed turn (provider
  error) abandons its early-written player message (`abandon_message`) so it still
  commits nothing, and a crashed attempt is healed at the next TOP-LEVEL turn's start
  (`heal_dangling_leaf`, by turn stamp; never from inside a companion sub-turn, whose
  outer turn's player line is legitimately the leaf with the same stamp — a review
  probe caught the nested heal throwing that line off the path); a member's join replay
  holds live events and flushes them after, deduplicated by IDENTITY against what the
  replay emitted: every live event carries the id of its persisted record
  (`Event.origin_id` — the player echo's pre-assigned history id, the reply's record
  id, a lane record's id), so a roll typed or a turn settled during the replay is
  delivered once while a second, identical roll still is (a content fingerprint would
  have swallowed it), with a deduped final's held deltas dropped alongside it.
- **Rule home:** `gateway/turn.py::record_turn_events` / `_emit_tool_event`,
  `agent/loop.py` (write timing), `agent/history.py`, `net/session.py::_replay_history`.
- **Date:** 2026-08-18.
