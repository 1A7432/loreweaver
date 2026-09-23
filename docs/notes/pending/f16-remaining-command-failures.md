# Pending: the command failures that still broadcast (F16 scope)

- **Problem:** F16 says a reply reporting that a command did NOT happen is for its author
  only (`CommandCtx.fail`). The 2026-09-23 QQ run found `.pc` breaking it — a mistyped
  claim was posted to the whole group — and that is fixed. A sweep shows more broadcast
  usage/failure replies: `checks.py` (invalid dice expression ×3), `media.py`
  (`.audio`/`.avatar` usage and not-found), `cast.py` (`.party` usage), `rooms.py`
  (`.botlist`/`.undo`/`.save` usage, save failure). Many other hits are private-reply
  commands (`.model`, `.imagegen`, `.forge`, `.room`, `.bind`) and already reach only the
  author.
- **Options:** (a) route all of them through `ctx.fail`; (b) leave player-level typos
  (`.r 3dx`) broadcast, as classic dice bots do in a group, and fix only keeper-gated ones;
  (c) leave as is.
- **Recommendation:** (a). F16's wording already covers them ("bad usage, unknown
  target, … broken input"), and in a QQ group every typo is otherwise a public post; the
  author still sees the error (the bridge sends it privately).
- **Impact:** player-visible — a typo's error moves from the group to the typer's private
  chat on the QQ bridge, and off peers' screens in Studio/TUI.
- **Date:** 2026-09-23.
