"""Deterministic Luck-spend adjustment for an already-rolled, recorded check.

This module never rolls dice and knows NO rule system: eligibility branches on
the recorded check's semantic flags and skill identity, and re-grading the
adjusted roll goes through a caller-supplied ``grade`` callable — the room
system's compiled resolver bound to the check's own target/variant/difficulty
(a pure INTERPRET, so the adjustment is replayable). The spend flow itself
(which resource pays, which checks qualify) becomes pack subsystem data in
M16 stage D; the arithmetic here is the engine half.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from core.check_outcome import Rank

# Skills a Luck spend may never adjust (the resource's own check and the
# sanity check). Game-data surface forms, matched casefolded.
_INELIGIBLE_SKILLS = {"san", "luc", "luck", "理智", "幸运"}


@dataclass(frozen=True)
class LuckAdjustment:
    """Canonical before/after outcome of one Luck spend."""

    before_roll: int
    after_roll: int
    before: Rank
    after: Rank
    total_spent: int


def find_latest_character_check(
    checks: list[dict[str, Any]], user_id: str, char_name: str
) -> dict[str, Any] | None:
    """Return the newest check belonging to one player character."""
    normalized_name = char_name.casefold()
    for check in reversed(checks):
        if check.get("user_id") != user_id:
            continue
        if str(check.get("char_name", "")).casefold() == normalized_name:
            return check
    return None


def is_luck_eligible_check(check: dict[str, Any]) -> bool:
    """Whether the rules permit Luck to adjust this recorded check."""
    return str(check.get("skill", "")).strip().casefold() not in _INELIGIBLE_SKILLS


def adjust_check_with_luck(
    check: dict[str, Any], points: int, *, grade: Callable[[int], Rank]
) -> LuckAdjustment:
    """Mutate a recorded check by subtracting Luck points from its roll.

    ``grade`` re-interprets a d100 value under the check's own conditions (the
    caller binds the resolver + target/variant/difficulty). The original
    effective roll remains in ``raw_roll`` while ``roll`` becomes the adjusted
    deterministic result. The caller re-renders ``label`` (a locale concern
    this module never owns).
    """
    if isinstance(points, bool) or not isinstance(points, int) or points <= 0:
        raise ValueError("luck_points_must_be_positive")

    before_roll = int(check["roll"])
    before = grade(before_roll)
    # Buying off a fumble is forbidden, and a d100 result can never sit below 1.
    if before.fumble:
        raise ValueError("luck_cannot_adjust_fumble")
    if points >= before_roll:
        raise ValueError("luck_points_exceed_roll")
    after_roll = before_roll - points
    after = grade(after_roll)

    if not check.get("luck_adjusted"):
        check["raw_roll"] = before_roll
    else:
        check.setdefault("raw_roll", before_roll)
    total_spent = int(check.get("luck_spent", 0) or 0) + points
    check.update(
        {
            "roll": after_roll,
            "adjusted_roll": after_roll,
            "rank_id": after.id,
            "tier": after.tier,
            "success": after.success,
            "critical": after.critical,
            "fumble": after.fumble,
            "luck_adjusted": True,
            "luck_spent": total_spent,
        }
    )
    return LuckAdjustment(
        before_roll=before_roll,
        after_roll=after_roll,
        before=before,
        after=after,
        total_spent=total_spent,
    )
