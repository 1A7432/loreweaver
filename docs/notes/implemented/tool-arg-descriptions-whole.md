# Implemented: a tool parameter's description is its whole `Args:` entry

- **Problem:** `agent/tools._parse_docstring_args` kept only the first physical line of
  each Google-style `Args:` entry, so a wrapped entry reached the model cut mid-sentence:
  14 play-phase parameters (27 in the prep phase) such as `game_clock.value` losing its
  `"+1 day"` example and `speak_as_npc.effort` losing the low/medium/high guidance.
- **Decision:** continuation lines (indented deeper than the arg line) are joined onto the
  description with single spaces; the entry still ends at the next arg, a dedent, or the
  end of the block. The play-phase schema ceiling moves 20_000 -> 21_000 (the toolset is
  20.4k with whole descriptions; prep 37.5k -> 39.6k); no tool docstring was trimmed to fit.
- **Reason:** the old 19.3k figure was measured with that text dropped, so the budget never
  counted guidance the model needs; shortening the docstrings would repeat the loss.
- **Rule home:** `tests/architecture/test_tool_phase_budget.py` (budget);
  `tests/agent/test_tools.py` (parser).
- **Date:** 2026-10-21.
