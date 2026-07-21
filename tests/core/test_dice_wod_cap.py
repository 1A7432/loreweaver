"""Regression tests for the World of Darkness pool-size DoS cap.

`roll_wod_pool` used to build a `pool_size`-length list with no bound, so a
model-supplied `pool_size=20000000` would allocate that list and block the
event loop for seconds. It now clamps `pool_size` to `_MAX_WOD_POOL` and
`difficulty` to `_MIN_WOD_DIFFICULTY.._MAX_WOD_DIFFICULTY`.
"""

import time

from core.dice_engine import (
    _MAX_WOD_DIFFICULTY,
    _MAX_WOD_POOL,
    _MIN_WOD_DIFFICULTY,
    DiceRoller,
    seed_dice,
)


def test_huge_pool_size_is_clamped_and_returns_fast():
    roller = DiceRoller()
    seed_dice(1)

    start = time.perf_counter()
    result = roller.roll_wod_pool(20_000_000, difficulty=6)
    elapsed = time.perf_counter() - start

    assert len(result["rolls"]) == _MAX_WOD_POOL
    assert result["pool_size"] == _MAX_WOD_POOL
    assert elapsed < 1.0  # would be many seconds without the cap


def test_realistic_pool_size_is_unaffected():
    roller = DiceRoller()
    seed_dice(1)

    result = roller.roll_wod_pool(5, difficulty=6)
    assert len(result["rolls"]) == 5
    assert result["pool_size"] == 5


def test_difficulty_is_clamped_into_valid_range():
    roller = DiceRoller()
    seed_dice(1)

    too_high = roller.roll_wod_pool(3, difficulty=9999)
    assert too_high["difficulty"] == _MAX_WOD_DIFFICULTY

    too_low = roller.roll_wod_pool(3, difficulty=-5)
    assert too_low["difficulty"] == _MIN_WOD_DIFFICULTY
