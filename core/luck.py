"""Deterministic CoC7 Luck-spend adjustment for an already-rolled check.

Eligibility branches ONLY on the recorded check's semantic flags (`fumble`)
and skill identity — never on a rank code. Re-grading the adjusted roll goes
through the legacy `core.coc_rules` resolver while it remains alive (stage A);
the compiled pack resolver's pure INTERPRET replaces it in stage C.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from core.check_outcome import Rank
from core.coc_rules import DEFAULT_COC_RULE, DIFFICULTY_REGULAR, RANKS, result_check_base

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
    """Whether CoC7 permits Luck to adjust this recorded check."""
    return str(check.get("skill", "")).strip().casefold() not in _INELIGIBLE_SKILLS


def adjust_check_with_luck(check: dict[str, Any], points: int) -> LuckAdjustment:
    """Mutate a recorded CoC check by subtracting Luck points from its roll.

    This function never rolls dice. The original effective d100 result remains
    in ``raw_roll`` while ``roll`` becomes the adjusted deterministic result.
    The caller re-renders ``label`` (a locale concern this module never owns).
    """
    if isinstance(points, bool) or not isinstance(points, int) or points <= 0:
        raise ValueError("luck_points_must_be_positive")

    before_roll = int(check["roll"])
    target = int(check["target"])
    difficulty = int(check.get("difficulty", DIFFICULTY_REGULAR) or DIFFICULTY_REGULAR)
    rule = int(check.get("rule", DEFAULT_COC_RULE) or DEFAULT_COC_RULE)
    before_code, _ = result_check_base(rule, before_roll, target, difficulty)
    before = RANKS[before_code]
    # CoC7 forbids buying off a fumble, and a d100 result can never sit below 1.
    if before.fumble:
        raise ValueError("luck_cannot_adjust_fumble")
    if points >= before_roll:
        raise ValueError("luck_points_exceed_roll")
    after_roll = before_roll - points
    after_code, _ = result_check_base(rule, after_roll, target, difficulty)
    after = RANKS[after_code]

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
