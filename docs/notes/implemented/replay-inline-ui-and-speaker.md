# Implemented: inline `ui` frames ride the join-replay lane; a late writer names its anchor

- **Problem:** live 2026-10-21 (Studio, protocol 2.4, 《安土》): after a client reload the
  join replay restored the narration, the player lines and the NPC lines but none of the
  Stage Director's staging — the scene picture, an engagement letter, a copied survey
  table. `agent.stage_director._publish` and the hook `ui` fan-out in `gateway.turn`
  published to the hub only; nothing wrote them where replay reads (the 09-24 run's
  拔营 ledger cards vanished across a restart the same way). And every replayed player
  line showed the Keeper-facing speaker tag (`[平知章 (Dirac)]`) inside the bubble with
  no name header, where the live echo carried the name in its own field.
- **Verdict:** every INLINE `ui` frame joins the lane (`record_turn_events`; a `sidebar`
  frame is a region replaced by `id` and stays out, as the protocol always said). Hook
  frames anchor to the turn's reply by id. The Director's frames anchor to
  `ScribeEpoch.transcript_leaf` — the message the turn ENDED on, captured when the pass
  was scheduled, under the turn lock — never to the leaf at publish time, which is the
  next turn's player line whenever the pass runs late (defensive pattern #7). The end of
  the turn rather than the Keeper's reply, so a companion exchange that closed the turn
  replays before the staging, as it was seen. Replay re-runs `filter_ui_media` on each
  laned frame (a pack disabled since would leave a broken picture); the lane holds
  hashes only, and room media outlives the lane in every reset scope. A replayed player
  line is split with `agent.player_line.split_player_line` and sent in the live echo's
  shape (`name` + plain body). The split reads the RAW stored line and only the body is
  stripped (2026-10-22, Cursor Bugbot): stripping first ate the newline the tag needs, so a
  whitespace-only line the session had accepted (`[Rook]\n   `) replayed as a nameless
  "[Rook]" bubble. A tagged line with an empty body replays as nothing.
- **Undo:** no leak. `agent.undo.restore` cancels and drains the pass before swapping the
  lane for the snapshot's copy, and a record anchored on an abandoned branch is never on
  the path a replay walks. The residual is a LOSS: hook frames and Director staging land
  after `run_kp_turn` photographs turn N, and reach that snapshot only through the pass's
  refresh — which stands down once a newer turn has started (or never runs with the
  Scribe off). A rewind to N from a later turn then replays N without them. Accepted as
  the same exposure every post-turn write already has.
- **Rule home:** `gateway/turn.py::record_turn_events` / `_laned`, `agent/scribe_coord.py`
  (`ScribeEpoch.transcript_leaf`), `agent/stage_director.py::_publish`,
  `net/session.py::_replay_history_body`; `docs/protocol.md` (join replay, `ui`).
- **Date:** 2026-10-21.
