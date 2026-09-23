# Implemented: what the first real QQ table changed (bridge routing, lost turns, shared ids)

- **Problem:** the 2026-09-23 run was the first time the OneBot bridge met a real NapCat and
  a real QQ group (《安土》 v0.2.4, grok-4.6). Every probe had passed; the table did not.
  The admin's private chat got a copy of every system reply and NPC line two seconds late,
  plus their own command read back to them; a player's `.help` or failed command vanished;
  an engine restart re-posted the transcript into the group; a NapCat restart mid-turn lost
  that turn's narration for good; the merged-forward card never fired; `.report` showed
  raw Markdown in every client and broadcast the server's absolute file path; NPC names
  and lines showed twice.
- **Verdict (owner, 2026-09-23 — "fix what you hit and keep testing"):**
  one wire id per event, fixed at creation, so every member of a room sees the same `id`
  for the same line; the bridge routes a member link's `narrative{speaker:"system"}` by
  whether the engine broadcast it (group post, plus a private copy when typed in private)
  or unicast it (private chat, players and admins alike) and never renders a member
  link's `speaker:"player"` echo; the observer dedupes replayed lines by content as well
  as id, and a fresh bridge posts only the replayed lines after the last one the group
  already saw; the OneBot outbox holds sends across a dropped connection (15 minutes,
  in order, then dropped and logged); OneBot text reaches the transport whole so it can
  become one forward card; `CommandReply.markdown`; the table copy of an NPC line leaves
  the name to the frame and the Keeper is told the line is already at the table.
- **Reason:** each one was seen live, and each is the protocol working as written with a
  consumer that assumed more than it said — ids that were unique per render, a reply
  format that was always `plain`, an echo the bridge took for admin material. Fixing the
  shared id in the engine, not a bridge heuristic, is what makes the observer's
  "already posted" check mean what it says for any multi-link client.
- **Rule home:** `gateway/hub.py` (`Event.__post_init__`), `gateway/turn.py` (reply
  format), `clients/tui/src/bridge/router.ts` (`onEcho`, `onCommandReply`,
  `postMissedTail`), `clients/tui/src/bridge/deliverer.ts` (`held`), `docs/qq.md`
  (reply routing, admin guard); tests `tests/gateway/test_event_ids.py`,
  `clients/tui/src/bridge/router.test.ts`, `clients/tui/src/bridge/deliverer.test.ts`.
- **Date:** 2026-09-23.
