"""Bounds on the success-pool substrate and pack roll params (DoS guards).

The pre-M16 `roll_wod_pool` helper clamped a pathological model-supplied pool
size. Its replacements bound the same risk structurally: the pool expression
grammar caps the dice count at three digits, and a pack's declared `params:`
ranges clamp caller-supplied values before any dice are rolled.
"""

import time

import pytest

from core.dice_engine import DiceRoller, seed_dice
from core.rulepacks import load_rulepack


def test_pool_expression_grammar_caps_the_dice_count():
    roller = DiceRoller()
    seed_dice(1)

    start = time.perf_counter()
    detail = roller.roll_detail("999d10>=6")
    elapsed = time.perf_counter() - start
    assert len(detail.dice) == 999
    assert elapsed < 1.0

    # Four-plus digits never parse as a pool (and the d20 grammar's own
    # max_rolls guard rejects them), so a 20-million-die pool cannot exist.
    with pytest.raises(ValueError):
        roller.roll_detail("20000000d10>=6")


def test_pack_declared_params_clamp_caller_values():
    resolver = load_rulepack("wod").resolver
    assert resolver.clamp_params({"pool": 20_000_000, "difficulty": 1}) == {"pool": 200, "difficulty": 2}
    assert resolver.clamp_params({"pool": -5}) == {"pool": 1, "difficulty": 6}

    seed_dice(2)
    detail = DiceRoller().roll_for_check(resolver, params={"pool": 20_000_000, "difficulty": 6})
    assert len(detail.dice) == 200
