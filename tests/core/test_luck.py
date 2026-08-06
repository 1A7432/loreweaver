"""Deterministic Luck-spend outcome adjustment (graded by the compiled ladder)."""

import pytest

from core.check_outcome import RollDetail
from core.luck import adjust_check_with_luck
from core.rulepacks import load_rulepack


def _grade_for(target: int):
    resolver = load_rulepack("coc7").resolver
    return lambda roll: resolver.interpret(RollDetail("1d100", (roll,), roll), target).rank


def test_adjust_check_with_luck_mutates_outcome_without_rerolling() -> None:
    check = {
        "skill": "Spot Hidden",
        "target": 50,
        "roll": 55,
        "success": False,
        "rank_id": "fail",
        "difficulty": 1,
        "rule": 0,
    }

    adjustment = adjust_check_with_luck(check, 6, grade=_grade_for(50))

    assert adjustment.before_roll == 55
    assert adjustment.after_roll == 49
    assert adjustment.before.success is False
    assert adjustment.after.success is True
    assert adjustment.before.tier < adjustment.after.tier
    assert check["raw_roll"] == 55
    assert check["roll"] == 49
    assert check["adjusted_roll"] == 49
    assert check["rank_id"] == "regular"
    assert check["success"] is True
    assert check["fumble"] is False
    assert check["luck_adjusted"] is True
    assert check["luck_spent"] == 6


def test_repeated_luck_spend_preserves_original_roll_and_accumulates_points() -> None:
    check = {"target": 50, "roll": 55, "difficulty": 1, "rule": 0}

    adjust_check_with_luck(check, 3, grade=_grade_for(50))
    adjustment = adjust_check_with_luck(check, 4, grade=_grade_for(50))

    assert adjustment.before_roll == 52
    assert adjustment.after_roll == 48
    assert check["raw_roll"] == 55
    assert check["luck_spent"] == 7


def test_luck_spend_is_allowed_even_when_success_rank_does_not_change() -> None:
    check = {"target": 80, "roll": 39, "difficulty": 1, "rule": 0}

    adjustment = adjust_check_with_luck(check, 1, grade=_grade_for(80))

    assert adjustment.before.id == adjustment.after.id == "hard"
    assert adjustment.before.tier == adjustment.after.tier
    assert check["roll"] == 38
    assert check["luck_spent"] == 1


def test_luck_cannot_buy_off_a_fumble() -> None:
    check = {"skill": "Spot Hidden", "target": 45, "roll": 100, "difficulty": 1, "rule": 0}

    with pytest.raises(ValueError, match="luck_cannot_adjust_fumble"):
        adjust_check_with_luck(check, 60, grade=_grade_for(45))

    assert check == {"skill": "Spot Hidden", "target": 45, "roll": 100, "difficulty": 1, "rule": 0}


def test_luck_spend_cannot_reduce_roll_below_one() -> None:
    check = {"target": 25, "roll": 27, "difficulty": 1, "rule": 0}

    with pytest.raises(ValueError, match="luck_points_exceed_roll"):
        adjust_check_with_luck(check, 27, grade=_grade_for(25))

    assert "luck_adjusted" not in check

    adjustment = adjust_check_with_luck(check, 26, grade=_grade_for(25))

    assert adjustment.after_roll == 1
    assert check["raw_roll"] == 27
