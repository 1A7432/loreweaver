"""Tests for core.dice_engine and core.coc_rules.

- Critical-success/failure semantics are ported from nekro
  `tests/test_core_fixes.py::test_dice_result_d20_and_d100_critical_semantics`.
- COC success-rank vectors are the ones listed in `docs/specs/rules_coc.md` §Test
  vectors; per that doc's instructions they were derived by *running* the ported
  `result_check_base` (not hand-computed), and all matched the doc's own worked
  values exactly (no port-vs-doc disagreement to reconcile).
"""

import pytest

from core import dice_engine
from core.coc_rules import result_check_base
from core.dice_engine import DiceConfig, DiceResult, DiceRoller, coc_rank_label, seed_dice
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
# core.coc_rules.result_check_base — vectors from docs/specs/rules_coc.md
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rule", "d100", "skill", "difficulty", "expected_rank"),
    [
        # rule 0, skill 50
        (0, 1, 50, 1, 4),  # crit (d100 == 1)
        (0, 3, 50, 1, 3),  # extreme: 3 <= 50 // 5 == 10
        (0, 25, 50, 1, 2),  # hard: 25 <= 50 // 2 == 25
        (0, 50, 50, 1, 1),  # regular success: 50 <= 50
        (0, 51, 50, 1, -1),  # regular failure
        (0, 100, 50, 1, -2),  # fumble: d100 == 100 always fumbles under rule 0
        (0, 96, 50, 1, -1),  # skill >= 50 -> no 96-100 fumble band, plain failure
        # rule 0, skill 40 (fumble band widens to 96-100 because skill < 50)
        (0, 96, 40, 1, -2),
        (0, 95, 40, 1, -1),
        # rule 2 (domestic common), skill 70
        (2, 5, 70, 1, 4),  # 1-5 & success -> crit
        (2, 100, 70, 1, -2),
        (2, 96, 70, 1, -2),
        # rule 3 (strict), skill 30 — crit/fumble bands override the check result
        (3, 4, 30, 1, 4),
        (3, 97, 30, 1, -2),
        # dg (Delta Green, rule 11), skill 60
        (11, 1, 60, 1, 4),  # 1 always crits
        (11, 11, 60, 1, 4),  # success & units(1) == tens(1) -> crit
        (11, 99, 60, 1, -2),  # fail & units(9) == tens(9) -> fumble
        (11, 23, 60, 1, 1),  # success, units(3) != tens(2) -> regular success
        (11, 100, 60, 1, -2),  # 100 -> fumble
    ],
)
def test_result_check_base_matches_rules_coc_vectors(rule, d100, skill, difficulty, expected_rank):
    rank, _critical_threshold = result_check_base(rule, d100, skill, difficulty)
    assert rank == expected_rank


def test_result_check_base_success_is_rank_gte_one():
    for rank_expected_success, d100 in ((True, 50), (False, 51)):
        rank, _ = result_check_base(0, d100, 50, 1)
        assert (rank >= 1) is rank_expected_success


def test_coc_rank_label_localizes_by_rank_code():
    assert coc_rank_label(4) == "Critical Success"
    assert coc_rank_label(3) == "Extreme Success"
    assert coc_rank_label(2) == "Hard Success"
    assert coc_rank_label(1) == "Success"
    assert coc_rank_label(-1) == "Failure"
    assert coc_rank_label(-2) == "Fumble"
    assert coc_rank_label(4, I18n(locale="zh")) == "大成功"
    assert coc_rank_label(-2, I18n(locale="zh")) == "大失败"


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
    custom_config = DiceConfig(MAX_DICE_COUNT=5)
    roller = DiceRoller(config=custom_config)
    assert roller.config is custom_config
    assert roller.config.MAX_DICE_COUNT == 5


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
# CoC7 checks
# ---------------------------------------------------------------------------


def test_roll_coc_check_returns_required_shape_and_wires_result_check_base():
    roller = DiceRoller()
    seed_dice(1)
    result = roller.roll_coc_check(50)

    for key in ("roll", "skill_value", "rank", "level_code", "success", "difficulty"):
        assert key in result
    assert result["skill_value"] == 50
    assert result["difficulty"] == 1
    assert result["level_code"] == result["rank"]
    assert result["level"] == result["rank"]
    assert result["success"] == (result["rank"] >= 1)

    expected_rank, expected_crit = result_check_base(0, result["roll"], 50, 1)
    assert result["rank"] == expected_rank
    assert result["critical_threshold"] == expected_crit


def test_roll_coc_check_forwards_rule_and_difficulty():
    roller = DiceRoller()
    seed_dice(7)
    result = roller.roll_coc_check(30, rule=3, difficulty=2)
    assert result["rule"] == 3
    assert result["difficulty"] == 2
    expected_rank, _ = result_check_base(3, result["roll"], 30, 2)
    assert result["rank"] == expected_rank


def test_bonus_dice_keeps_the_lowest_tens_digit(monkeypatch):
    roller = DiceRoller()
    # roll=47 -> tens=4, ones=7; two extra tens dice roll 8 then 2 -> min(4, 8, 2) == 2
    queued = iter([47, 8, 2])
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: next(queued))

    bonus_penalty = roller._roll_bonus_penalty_d100(bonus=2, penalty=0)

    assert bonus_penalty == {
        "roll": 47,
        "final_roll": 27,
        "tens": 4,
        "ones": 7,
        "extra_tens": [8, 2],
        "final_tens": 2,
    }


def test_penalty_dice_keeps_the_highest_tens_digit(monkeypatch):
    roller = DiceRoller()
    queued = iter([47, 8, 2])
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: next(queued))

    bonus_penalty = roller._roll_bonus_penalty_d100(bonus=0, penalty=2)

    assert bonus_penalty == {
        "roll": 47,
        "final_roll": 87,
        "tens": 4,
        "ones": 7,
        "extra_tens": [8, 2],
        "final_tens": 8,
    }


def test_bonus_penalty_net_zero_cancels_out(monkeypatch):
    roller = DiceRoller()
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: 47)

    bonus_penalty = roller._roll_bonus_penalty_d100(bonus=1, penalty=1)

    assert bonus_penalty == {"roll": 47, "final_roll": 47, "tens": 4, "ones": 7, "extra_tens": [], "final_tens": 4}


def test_bonus_penalty_helper_handles_natural_hundred(monkeypatch):
    roller = DiceRoller()
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: 100)

    bonus_penalty = roller._roll_bonus_penalty_d100()

    assert bonus_penalty == {"roll": 100, "final_roll": 100, "tens": 0, "ones": 0, "extra_tens": [], "final_tens": 0}


def test_roll_coc_check_with_bonus_exposes_tens_dice_diagnostics():
    roller = DiceRoller()
    seed_dice(3)
    result = roller.roll_coc_check_with_bonus(50, bonus=1)

    for key in (
        "roll",
        "final_roll",
        "skill_value",
        "level",
        "level_code",
        "rank",
        "success",
        "bonus",
        "penalty",
        "tens",
        "ones",
        "extra_tens",
        "final_tens",
    ):
        assert key in result
    assert result["bonus"] == 1
    assert result["penalty"] == 0
    assert len(result["extra_tens"]) == 1

    expected_rank, _ = result_check_base(0, result["final_roll"], 50, 1)
    assert result["rank"] == expected_rank
    assert result["level"] == expected_rank


# ---------------------------------------------------------------------------
# World of Darkness pool
# ---------------------------------------------------------------------------


def test_roll_wod_pool_result_shape():
    roller = DiceRoller()
    seed_dice(1)
    result = roller.roll_wod_pool(5, difficulty=6)

    assert set(result) == {"successes", "rolls", "botch", "difficulty", "pool_size"}
    assert len(result["rolls"]) == 5
    assert result["successes"] == sum(1 for roll in result["rolls"] if roll >= 6)


def test_roll_wod_pool_zero_size_is_a_botch():
    roller = DiceRoller()
    assert roller.roll_wod_pool(0) == {"successes": 0, "rolls": [], "botch": True}


def test_roll_wod_pool_all_ones_is_a_botch(monkeypatch):
    roller = DiceRoller()
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: 1)

    result = roller.roll_wod_pool(3, difficulty=6)

    assert result["successes"] == 0
    assert result["botch"] is True


def test_roll_wod_pool_specialization_counts_natural_ten_twice(monkeypatch):
    roller = DiceRoller()
    monkeypatch.setattr(dice_engine.random, "randint", lambda _lo, _hi: 10)

    result = roller.roll_wod_pool(3, difficulty=6, specialization=True)

    assert result["successes"] == 6
    assert result["botch"] is False


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


def test_bonus_penalty_tens_dice_are_clamped_against_unbounded_range():
    """A pathological bonus/penalty magnitude (e.g. from `.sc b100000000`) must not
    spin an unbounded `range()`; the number of extra tens dice is clamped, so the
    check returns promptly with a sane d100 result and success rank."""
    seed_dice(1)
    out = DiceRoller().roll_coc_check_with_bonus(50, bonus=100_000_000)

    assert len(out["extra_tens"]) == dice_engine._MAX_BONUS_PENALTY_DICE  # clamped, not 100_000_000
    assert 1 <= out["roll"] <= 100
    assert -2 <= out["rank"] <= 4

    seed_dice(1)
    penalized = DiceRoller().roll_coc_check(50, penalty=100_000_000)
    assert 1 <= penalized["roll"] <= 100
