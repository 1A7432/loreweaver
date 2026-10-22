# Implemented: a tool call naming an argument the tool does not have is refused

- **Problem:** `Toolset.dispatch` coerced only the parameters the tool declares and
  dropped every other key. The Keeper called `kp_note(action="set",
  category="current_scene", value=...)` (`value` is `game_clock`'s argument; kp_note's
  is `content`), `content` fell to its `""` default, and the player-visible scene
  name was set to empty with a success reply.
- **Verdict:** an unknown argument name raises `ToolArgumentError`, which dispatch
  already returns as the localized `agent.tools.bad_arguments` result, naming the
  unknown keys and listing the accepted parameters so the model corrects itself next
  round. Underscore-prefixed (caller-injected) and `ctx` parameters count as unknown
  to a model call, as before they could not be set. Pack subsystem tools use their
  own dispatch and are untouched.
- **Reason:** a dropped key is a silent write on defaults; the cost of the refusal
  is one tool round, the cost of the silence was a blanked scene.
- **Rule home:** `agent.tools._coerce_arguments`.
- **Date:** 2026-10-21.
