# Implemented: `.imagegen` and `.forge` engine commands (M24 WS-B)

- **Problem:** two operations a room admin needs from a chat client (`admin_set_imagegen`,
  `admin_generate`) existed only as TUI admin frames. A QQ-bridge admin has no desktop
  keeper screens, so stills and authoring were unreachable from the group.
- **Verdict:** add `.imagegen` (show / set / off) on the `llm` mixin and `.forge
  <skill|rulepack|module> <description>` as a new `forge` mixin. Both keeper-gated
  via `_is_keeper` + `_keeper_still_authorized`. No protocol change; they are
  commands, not tools, so the play-phase schema budget is untouched.
- **Shape:** `.imagegen set` calls `net.admin._set_imagegen` so the endpoint/key
  isolation rule stays in one place (omitted key reusable only for the same
  endpoint; a new `base_url` without a key clears the old key). `.forge` runs the
  same `agent.forge` generators `admin_generate` uses; a module installs into the
  caller's room. Generation is prep-phase (`room_phase == play` is refused, same
  axis as `prep_only` on the forge tools) and does not require the forge skills
  (the admin surface is already keeper-gated). It runs in-line under the per-room
  turn lock — authorization and the install share one locked scope, so a later
  `.reset` / `.undo` / import / delete cannot be overwritten by a leftover task
  (defensive-patterns §7). Replies are `private_reply`.
- **Rule home:** `gateway/commands/llm.py` (`cmd_imagegen`), `gateway/commands/forge.py`,
  spec rows in `gateway/commands/router.py`.
- **Date:** 2026-09-14.
