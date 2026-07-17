"""Deterministic CoC7 Luck-spend outcome adjustment."""

import pytest

from core.luck import adjust_check_with_luck


def test_adjust_check_with_luck_mutates_outcome_without_rerolling() -> None:
    check = {
        "skill": "Spot Hidden",
        "target": 50,
        "roll": 55,
        "success": False,
        "rank": -1,
        "difficulty": 1,
        "rule": 0,
    }

    adjustment = adjust_check_with_luck(check, 6)

    assert adjustment.before_roll == 55
    assert adjustment.after_roll == 49
    assert adjustment.before_rank == -1
    assert adjustment.after_rank == 1
    assert check["raw_roll"] == 55
    assert check["roll"] == 49
    assert check["adjusted_roll"] == 49
    assert check["rank"] == 1
    assert check["success"] is True
    assert check["luck_adjusted"] is True
    assert check["luck_spent"] == 6


def test_repeated_luck_spend_preserves_original_roll_and_accumulates_points() -> None:
    check = {"target": 50, "roll": 55, "rank": -1, "difficulty": 1, "rule": 0}

    adjust_check_with_luck(check, 3)
    adjustment = adjust_check_with_luck(check, 4)

    assert adjustment.before_roll == 52
    assert adjustment.after_roll == 48
    assert check["raw_roll"] == 55
    assert check["luck_spent"] == 7


def test_luck_spend_is_allowed_even_when_success_rank_does_not_change() -> None:
    check = {"target": 80, "roll": 39, "rank": 2, "difficulty": 1, "rule": 0}

    adjustment = adjust_check_with_luck(check, 1)

    assert adjustment.before_rank == adjustment.after_rank == 2
    assert check["roll"] == 38
    assert check["luck_spent"] == 1


def test_luck_cannot_buy_off_a_fumble() -> None:
    check = {"skill": "Spot Hidden", "target": 45, "roll": 100, "difficulty": 1, "rule": 0}

    with pytest.raises(ValueError, match="luck_cannot_adjust_fumble"):
        adjust_check_with_luck(check, 60)

    assert check == {"skill": "Spot Hidden", "target": 45, "roll": 100, "difficulty": 1, "rule": 0}


def test_luck_spend_cannot_reduce_roll_below_one() -> None:
    check = {"target": 25, "roll": 27, "difficulty": 1, "rule": 0}

    with pytest.raises(ValueError, match="luck_points_exceed_roll"):
        adjust_check_with_luck(check, 27)

    assert "luck_adjusted" not in check

    adjustment = adjust_check_with_luck(check, 26)

    assert adjustment.after_roll == 1
    assert check["raw_roll"] == 27
