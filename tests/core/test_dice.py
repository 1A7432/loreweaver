"""Tests for core.dice_engine — the system-agnostic dice substrate.

Critical-success/failure semantics are ported from nekro
`tests/test_core_fixes.py::test_dice_result_d20_and_d100_critical_semantics`.
Check GRADING lives in the compiled rulepack resolvers and is exhaustively
tabled in `tests/core/test_resolution_tables.py`; this file covers the roll
side: expressions, the generic d100 tens-reroll modifier mechanic, pools,
fudge/explode, and seeding.
"""

import pytest

from core import dice_engine
from core.dice_engine import DiceConfig, DiceResult, DiceRoller, seed_dice
from core.rulepacks import load_rulepack
from infra.i18n import I18n

# ---------------------------------------------------------------------------
# DiceResult: d20 / d100 critical success/failure semantics
# ---------------------------------------------------------------------------


def test_d20_natural_max_is_critical_success():
    assert DiceResult("1d20", [20], dice_sides=20, is_check=True).is_critical_success()


def test_d20_natural_one_is_critical_failure():
    assert DiceResult("1d20", [1], dice_sides=20, is_check=True).is_critical_failure()


def test_d100_natural_one_is_critical_success_not_failure():
    result = DiceResult("1d100", [1], dice_sides=100, is_check=True)
    assert result.is_critical_success()
    assert not result.is_critical_failure()


def test_d100_natural_hundred_is_critical_failure_not_success():
    result = DiceResult("1d100", [100], dice_sides=100, is_check=True)
    assert result.is_critical_failure()
    assert not result.is_critical_success()


def test_crit_requires_is_check():
    result = DiceResult("1d20", [20], dice_sides=20, is_check=False)
    assert not result.is_critical_success()
    failure = DiceResult("1d20", [1], dice_sides=20, is_check=False)
    assert not failure.is_critical_failure()


def test_crit_requires_dice_count_one():
    result = DiceResult("2d20", [20, 20], dice_sides=20, dice_count=2, is_check=True)
    assert not result.is_critical_success()


def test_crit_requires_enable_critical_effects(monkeypatch):
    monkeypatch.setattr(dice_engine.config, "ENABLE_CRITICAL_EFFECTS", False)
    result = DiceResult("1d20", [20], dice_sides=20, is_check=True)
    assert not result.is_critical_success()


def test_total_is_sum_of_rolls_plus_modifier():
    result = DiceResult("1d20+5", [12], modifier=5, dice_sides=20)
    assert result.total == 17


# ---------------------------------------------------------------------------
# DiceResult.format_result — i18n-backed rendering
# ---------------------------------------------------------------------------


def test_format_result_default_locale_no_modifier():
    result = DiceResult("1d20", [15], dice_sides=20)
    assert result.format_result() == "1d20 = [15] = 15"


def test_format_result_includes_positive_modifier_sign():
    result = DiceResult("1d20+5", [15], modifier=5, dice_sides=20)
    assert result.format_result() == "1d20+5 = [15]+5 = 20"


def test_format_result_includes_negative_modifier():
    result = DiceResult("1d20-3", [15], modifier=-3, dice_sides=20)
    assert result.format_result() == "1d20-3 = [15]-3 = 12"


def test_format_result_multiple_rolls():
    result = DiceResult("3d6", [1, 2, 3], dice_count=3, dice_sides=6)
    assert result.format_result() == "3d6 = [1, 2, 3] = 6"


def test_format_result_show_details_false_uses_simple_form():
    result = DiceResult("1d20", [15], dice_sides=20)
    assert result.format_result(show_details=False) == "Result: 15"


def test_format_result_respects_explicit_zh_locale():
    result = DiceResult("1d20", [15], dice_sides=20)
    assert result.format_result(i18n=I18n(locale="zh")) == "1d20 = [15] = 15"
    assert result.format_result(show_details=False, i18n=I18n(locale="zh")) == "结果: 15"


# ---------------------------------------------------------------------------
# DiceRoller.roll_expression — d20-backed, primary-dice extraction
# ---------------------------------------------------------------------------


def test_roll_expression_simple_die():
    seed_dice(1)
    result = DiceRoller().roll_expression("1d20")
    assert result.dice_count == 1
    assert result.dice_sides == 20
    assert len(result.rolls) == 1
    assert 1 <= result.rolls[0] <= 20
    assert result.total == result.rolls[0]


def test_roll_expression_is_case_insensitive():
    seed_dice(2)
    result = DiceRoller().roll_expression("1D20+3")
    assert result.modifier == 3
    assert result.total == result.rolls[0] + 3


def test_roll_expression_modifier_is_total_minus_primary_rolls():
    seed_dice(1)
    result = DiceRoller().roll_expression("1d20+5")
    assert result.dice_count == 1
    assert result.modifier == 5
    assert result.total == result.rolls[0] + 5


def test_roll_expression_multi_term_uses_first_dice_group_as_primary():
    seed_dice(1)
    result = DiceRoller().roll_expression("3d6+2d4+5")
    assert result.dice_sides == 6
    assert result.dice_count == 3
    assert len(result.rolls) == 3
    assert all(1 <= roll <= 6 for roll in result.rolls)
    # modifier absorbs everything outside of the primary 3d6 group on a best-effort basis
    assert result.modifier == result.total - sum(result.rolls)


def test_roll_expression_keep_highest_collapses_dice_count_to_kept_faces():
    seed_dice(1)
    result = DiceRoller().roll_expression("2d20kh1", is_check=True)
    assert result.dice_count == 1
    assert result.dice_sides == 20
    assert len(result.rolls) == 1
    assert result.total == result.rolls[0]


def test_roll_expression_pure_modifier_has_no_primary_dice():
    result = DiceRoller().roll_expression("+5")
    assert result.dice_count == 0
    assert result.dice_sides == 0
    assert result.rolls == [0]
    assert result.total == 5


def test_dice_roller_accepts_custom_config():
    custom_config = DiceConfig(ENABLE_CRITICAL_EFFECTS=False)
    roller = DiceRoller(config=custom_config)
    assert roller.config is custom_config
    assert roller.config.ENABLE_CRITICAL_EFFECTS is False


def test_seed_dice_makes_rolls_reproducible():
    roller = DiceRoller()
    seed_dice(42)
    first = roller.roll_expression("3d6+2")
    seed_dice(42)
    second = roller.roll_expression("3d6+2")
    assert first.rolls == second.rolls
    assert first.modifier == second.modifier
    assert first.total == second.total


def test_seed_dice_different_seeds_are_unlikely_to_collide():
    roller = DiceRoller()
    seed_dice(1)
    first = roller.roll_expression("10d6")
    seed_dice(2)
    second = roller.roll_expression("10d6")
    assert first.rolls != second.rolls


# ---------------------------------------------------------------------------
# advantage / disadvantage
# ---------------------------------------------------------------------------


def test_roll_advantage_keeps_the_higher_total(monkeypatch):
    roller = DiceRoller()
    queued = iter(
        [
            DiceResult("1d20", [5], dice_sides=20, is_check=True),
            DiceResult("1d20", [17], dice_sides=20, is_check=True),
        ]
    )
    monkeypatch.setattr(roller, "roll_expression", lambda expression, is_check=False: next(queued))

    picked = roller.roll_advantage("1d20", is_check=True)

    assert picked.total == 17


def test_roll_disadvantage_keeps_the_lower_total(monkeypatch):
    roller = DiceRoller()
    queued = iter(
        [
            DiceResult("1d20", [5], dice_sides=20, is_check=True),
            DiceResult("1d20", [17], dice_sides=20, is_check=True),
        ]
    )
    monkeypatch.setattr(roller, "roll_expression", lambda expression, is_check=False: next(queued))

    picked = roller.roll_disadvantage("1d20", is_check=True)

    assert picked.total == 5


def test_roll_advantage_tie_prefers_the_first_roll(monkeypatch):
    roller = DiceRoller()
    first_result = DiceResult("1d20", [9], dice_sides=20, is_check=True)
    queued = iter([first_result, DiceResult("1d20", [9], dice_sides=20, is_check=True)])
    monkeypatch.setattr(roller, "roll_expression", lambda expression, is_check=False: next(queued))

    assert roller.roll_advantage("1d20", is_check=True) is first_result


def test_roll_advantage_end_to_end_returns_a_single_kept_d20_face():
    roller = DiceRoller()
    seed_dice(99)
    result = roller.roll_advantage("1d20", is_check=True)
    assert result.dice_count == 1
    assert result.dice_sides == 20
    assert 1 <= result.rolls[0] <= 20
    assert result.total == result.rolls[0]


# ---------------------------------------------------------------------------
# The generic d100 tens-reroll modifier mechanic + roll_for_check
# ---------------------------------------------------------------------------


def test_tens_reroll_keep_lowest_keeps_the_lowest_tens_digit(monkeypatch):
    roller = DiceRoller()
    # roll=47 -> tens=4, ones=7; two extra tens dice roll 8 then 2 -> min(4, 8, 2) == 2
    queued = iter([47, 8, 2])
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: next(queued))

    tens = roller._roll_d100_tens_reroll(2)

    assert tens == {
        "roll": 47,
        "final_roll": 27,
        "tens": 4,
        "ones": 7,
        "extra_tens": [8, 2],
        "final_tens": 2,
    }


def test_tens_reroll_keep_highest_keeps_the_highest_tens_digit(monkeypatch):
    roller = DiceRoller()
    queued = iter([47, 8, 2])
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: next(queued))

    tens = roller._roll_d100_tens_reroll(-2)

    assert tens == {
        "roll": 47,
        "final_roll": 87,
        "tens": 4,
        "ones": 7,
        "extra_tens": [8, 2],
        "final_tens": 8,
    }


def test_tens_reroll_net_zero_rolls_no_extra_dice(monkeypatch):
    roller = DiceRoller()
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: 47)

    tens = roller._roll_d100_tens_reroll(0)

    assert tens == {"roll": 47, "final_roll": 47, "tens": 4, "ones": 7, "extra_tens": [], "final_tens": 4}


def test_keep_highest_die_does_not_shrink_a_natural_hundred(monkeypatch):
    roller = DiceRoller()
    # raw 100 (tens 0, ones 0) is the LARGEST d100. A keep-highest die whose
    # extra tens is 3 must stay 100, never treat the bare tens 0 as "highest -> 30".
    queued = iter([100, 3])
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: next(queued))

    tens = roller._roll_d100_tens_reroll(-1)

    assert tens == {
        "roll": 100,
        "final_roll": 100,
        "tens": 0,
        "ones": 0,
        "extra_tens": [3],
        "final_tens": 0,
    }


def test_keep_lowest_die_does_not_inflate_an_x0_roll_via_a_zero_tens(monkeypatch):
    roller = DiceRoller()
    # raw 70 (tens 7, ones 0). A keep-lowest die whose extra tens is 0 must NOT
    # pick tens 0 -> that is 00+0 == 100, the LARGEST value, not an improvement.
    queued = iter([70, 0])
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: next(queued))

    tens = roller._roll_d100_tens_reroll(1)

    assert tens == {
        "roll": 70,
        "final_roll": 70,
        "tens": 7,
        "ones": 0,
        "extra_tens": [0],
        "final_tens": 7,
    }


def test_keep_lowest_never_worse_and_keep_highest_never_better_than_base():
    # Property (all d100 outcomes, incl. the x0 edge): a keep-lowest die can only
    # keep or lower the roll, a keep-highest die can only keep or raise it.
    roller = DiceRoller()
    seed_dice(2026)
    for _ in range(500):
        low = roller._roll_d100_tens_reroll(1)
        assert low["final_roll"] <= low["roll"]
        high = roller._roll_d100_tens_reroll(-1)
        assert high["final_roll"] >= high["roll"]


def test_roll_for_check_applies_pack_declared_tens_modifiers():
    resolver = load_rulepack("coc7").resolver
    roller = DiceRoller()
    seed_dice(3)
    rolled = roller.roll_for_check(resolver, modifiers={"bonus": 1})

    assert rolled.modifiers["bonus"] == 1
    assert len(rolled.modifiers["extra_tens"]) == 1
    assert isinstance(rolled.modifiers["base_roll"], int)
    assert 1 <= rolled.total <= 100
    # Opposing counts cancel 1-for-1 -> a plain 1d100 with no tens bookkeeping.
    plain = roller.roll_for_check(resolver, modifiers={"bonus": 2, "penalty": 2})
    assert "extra_tens" not in plain.modifiers


def test_roll_for_check_roll_override_modifier_swaps_the_expression():
    resolver = load_rulepack("dnd5e").resolver
    roller = DiceRoller()
    seed_dice(5)
    rolled = roller.roll_for_check(resolver, modifiers={"advantage": 1})
    assert rolled.expression == "2d20kh1"
    assert len(rolled.dice) == 1  # kept face only
    assert rolled.modifiers["advantage"] == 1


# ---------------------------------------------------------------------------
# Explode / Fate / repeat
# ---------------------------------------------------------------------------


def test_roll_explode_chains_on_repeated_max_faces():
    roller = DiceRoller()
    seed_dice(19)  # known to roll a 6 then a 1 on 1d6e6
    result = roller.roll_explode("1d6")
    assert result.rolls == [6, 1]
    assert result.total == 7
    assert result.expression == "1d6"


def test_roll_explode_result_shape_for_multiple_dice():
    roller = DiceRoller()
    seed_dice(3)
    result = roller.roll_explode("2d6")
    assert isinstance(result, DiceResult)
    assert result.dice_sides == 6
    assert all(1 <= roll <= 6 for roll in result.rolls)
    assert result.total == sum(result.rolls) + result.modifier


def test_roll_explode_rejects_non_dice_expression():
    roller = DiceRoller()
    with pytest.raises(ValueError, match="not-a-dice"):
        roller.roll_explode("not-a-dice")


def test_roll_fate_result_shape():
    roller = DiceRoller()
    seed_dice(5)
    result = roller.roll_fate()
    assert result.dice_count == 4
    assert len(result.rolls) == 4
    assert all(roll in (-1, 0, 1) for roll in result.rolls)
    assert result.total == sum(result.rolls) + result.modifier


def test_roll_fate_custom_dice_count_and_modifier():
    roller = DiceRoller()
    seed_dice(5)
    result = roller.roll_fate(dice_count=6, modifier=2)
    assert result.dice_count == 6
    assert len(result.rolls) == 6
    assert result.modifier == 2
    assert result.total == sum(result.rolls) + 2


def test_roll_fate_non_positive_dice_count_defaults_to_four():
    roller = DiceRoller()
    seed_dice(5)
    result = roller.roll_fate(dice_count=0)
    assert result.dice_count == 4


def test_roll_repeat_returns_requested_number_of_results():
    roller = DiceRoller()
    seed_dice(1)
    results = roller.roll_repeat("1d6", 5)
    assert len(results) == 5
    assert all(isinstance(result, DiceResult) for result in results)
    assert all(1 <= result.total <= 6 for result in results)


@pytest.mark.parametrize("times", [0, -1, 21])
def test_roll_repeat_rejects_out_of_range_times(times):
    roller = DiceRoller()
    with pytest.raises(ValueError):
        roller.roll_repeat("1d6", times)


# ---------------------------------------------------------------------------
# SealDice-style notation normalization (DEFECT 1): "x"/"X"/"×" multiplication and
# bare "kN" keep-highest, as used by CharacterTemplate formulas
# (core/character_manager.py, e.g. "3d6x5", "(2d6+6)x5", "4d6k3").
# ---------------------------------------------------------------------------


def test_roll_expression_seal_dice_multiplication_3d6x5():
    seed_dice(1)
    result = DiceRoller().roll_expression("3d6x5")
    assert result.dice_sides == 6
    assert result.dice_count == 3
    assert all(1 <= roll <= 6 for roll in result.rolls)
    assert result.total == sum(result.rolls) * 5
    assert result.expression == "3d6x5"  # original (unnormalized) text preserved for display


def test_roll_expression_seal_dice_multiplication_parenthesized_2d6_plus_6_x5():
    seed_dice(1)
    result = DiceRoller().roll_expression("(2d6+6)x5")
    assert result.dice_sides == 6
    assert result.dice_count == 2
    assert result.total == (sum(result.rolls) + 6) * 5


@pytest.mark.parametrize("expression", ["3D6X5", "3d6×5", "3d6 x 5"])
def test_roll_expression_seal_dice_multiplication_accepts_uppercase_and_unicode_x(expression):
    seed_dice(1)
    upper_or_unicode = DiceRoller().roll_expression(expression)
    seed_dice(1)
    baseline = DiceRoller().roll_expression("3d6x5")
    assert upper_or_unicode.total == baseline.total
    assert upper_or_unicode.rolls == baseline.rolls


def test_roll_expression_bare_keep_matches_explicit_keep_highest_under_same_seed():
    """"4d6k3" (bare SealDice keep-3) must behave like "4d6kh3" (keep the highest 3 of
    4), not d20's own "kN" reading (keep dice whose face == N)."""
    seed_dice(123)
    bare = DiceRoller().roll_expression("4d6k3")
    seed_dice(123)
    explicit = DiceRoller().roll_expression("4d6kh3")

    assert bare.total == explicit.total
    assert bare.rolls == explicit.rolls
    assert bare.dice_count == 3
    assert bare.expression == "4d6k3"  # original (unnormalized) text preserved for display


@pytest.mark.parametrize("expression", ["2d20kh1", "4d6kl3", "1d20mi5", "1d20ma15", "3d6rr1", "2d6ro1"])
def test_roll_expression_leaves_valid_d20_keep_and_reroll_operators_unchanged(expression):
    """The normalizer must not touch expressions that are already valid `d20` grammar."""
    assert dice_engine._normalize_dice_expression(expression) == expression


def test_normalize_dice_expression_examples():
    assert dice_engine._normalize_dice_expression("3d6x5") == "3d6*5"
    assert dice_engine._normalize_dice_expression("(2d6+6)x5") == "(2d6+6)*5"
    assert dice_engine._normalize_dice_expression("4d6k3") == "4d6kh3"


# ---------------------------------------------------------------------------
# F3 (DoS): unbounded bonus/penalty tens dice are clamped
# ---------------------------------------------------------------------------


def test_tens_reroll_dice_are_clamped_against_unbounded_range():
    """A pathological modifier magnitude (e.g. from `.sc b100000000`) must not
    spin an unbounded `range()`; the number of extra tens dice is clamped, so
    the roll returns promptly with a sane d100 result."""
    seed_dice(1)
    out = DiceRoller()._roll_d100_tens_reroll(100_000_000)

    assert len(out["extra_tens"]) == dice_engine._MAX_BONUS_PENALTY_DICE  # clamped, not 100_000_000
    assert 1 <= out["final_roll"] <= 100

    seed_dice(1)
    penalized = DiceRoller()._roll_d100_tens_reroll(-100_000_000)
    assert 1 <= penalized["final_roll"] <= 100
