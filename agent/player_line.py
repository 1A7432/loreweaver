"""Speaker tag on the Keeper's player line (issue #29).

The format and its inverse live in ``core.player_line`` (the deterministic session
report reads the same history); this module keeps the Keeper-side import path.
"""

from __future__ import annotations

from core.player_line import attributed_player_line, player_line_body, split_player_line

__all__ = ["attributed_player_line", "player_line_body", "split_player_line"]
