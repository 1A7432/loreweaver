# Implemented: a hook-private state store (`getstate` / `setstate`)

- **Problem:** a hook could persist only through `setvar`, which lands in the variable
  space: declared module variables (max 64, text ≤ 200 chars) or the MVU tree (≤ 512
  nodes, the first 100 leaves printed into the Keeper prompt every turn). Modules with
  real deterministic machinery need scratch state that is none of those; the flagship
  pack `content/antu` already spends keeper-visibility variables as hook-only notebooks
  (four, by the owner's count), paying prompt lines and variable slots for state the
  Keeper never needs.
- **Verdict (owner):** add a hook-only JSON store, `getstate(key)` / `setstate(key,
  value)` (`null`/`undefined` deletes), outside the variable space: never in the Keeper
  prompt, never on a wire frame, never a `variables_changed` write or a turn's
  `hook_writes`, invisible to the Scribe, conditions and panels, and absent from the
  shared EJS template bridge. Buffered in the sandbox and validated, capped and persisted
  by engine code after every dispatch except `tool_use` (deny-only, as for variable
  writes); one `room_state` row per key under `hook_state:`; facet `hook_state` dies at
  `.reset all`, mirroring the module variables and the MVU tree.
- **Reason:** iron rule #1 keeps durable state the engine's; this gives machinery state
  an engine-owned home with the same request-then-apply shape as `setvar`, without
  spending the Keeper's context or the table's variable budget on it. Per-key rows keep a
  small write small and let undo, export/import and reset carry it with no code of
  their own.
- **Rule home:** `core/hooks.py` (module docstring, `MAX_STATE_*`, `plan_state_writes`),
  `agent/hook_runtime.py` (`load_hook_state`, `apply_hook_state_writes`, the
  `hook_state` facet); author contract in `docs/hooks.md` and
  `docs/lwf/formats/skills-hooks.md` §4; tests `tests/core/test_hooks.py`,
  `tests/agent/test_hook_state.py`.
- **Date:** 2026-11-25.
