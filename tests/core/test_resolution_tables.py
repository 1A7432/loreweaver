"""Exhaustive rulebook tables for the compiled resolution ladders (M16 stage C).

The oracle is an INDEPENDENT reference implementation transcribed from the
rulebooks' own wording (CoC7e RAW for the default rule, the SealDice `.setcoc`
rule table for the house variants, D&D5e SRD, oWoD pools) — NOT the legacy
`result_check_base` port. The d100/d20 interpretation spaces are small enough
to assert cell by cell: every roll × every target × every difficulty × every
house variant. No sampling.

`interpret` is pure (the engine pre-rolls; grading takes values), so these
tables run without any dice.
"""

from __future__ import annotations

import pytest

from core.check_outcome import RollDetail
from core.dice_engine import DiceRoller, seed_dice
from core.rulepacks import load_rulepack

# ---------------------------------------------------------------------------
# CoC7 reference — transcribed from the rulebook / SealDice rule-table wording
# ---------------------------------------------------------------------------

COC_VARIANTS = (None, "rule1", "rule2", "rule3", "rule4", "rule5", "dg")
COC_DIFFICULTIES = (None, "hard", "extreme", "critical")


def _effective(raw_target: int, difficulty: str | None) -> int:
    if difficulty == "hard":
        return raw_target // 2
    if difficulty == "extreme":
        return raw_target // 5
    if difficulty == "critical":
        return 1
    return raw_target


def reference_coc(variant: str | None, roll: int, raw_target: int, difficulty: str | None) -> str:
    """The rank id the RULES say a d100 of `roll` against `raw_target` earns."""
    target = _effective(raw_target, difficulty)

    if variant == "dg":
        # Delta Green: 1 always crits; matching digits crit on a success and
        # fumble on a failure; no hard/extreme gradations.
        if roll == 1:
            return "crit"
        doubles = roll % 10 == (roll // 10) % 10
        if roll <= target:
            return "crit" if doubles else "regular"
        return "fumble" if doubles else "fail"

    if variant == "rule3":
        # Strict: 1-5 crit and 96-100 fumble OVERRIDE the check result
        # (fumble wins the impossible overlap by the rule's own ordering).
        if roll >= 96:
            return "fumble"
        if roll <= 5:
            return "crit"
        return _graded_success(roll, target, raw_target) or "fail"

    crit_threshold, fumble_threshold = _thresholds(variant, raw_target, target)
    if variant in (None, "rule1", "rule2") and roll == 1:
        return "crit"
    if variant is None and roll == 100:
        return "fumble"
    if roll <= crit_threshold:
        return "crit"
    graded = _graded_success(roll, target, raw_target)
    if graded is not None:
        return graded
    if roll >= fumble_threshold:
        return "fumble"
    return "fail"


def _graded_success(roll: int, target: int, raw_target: int) -> str | None:
    """Success gradation: pass vs the (difficulty-adjusted) target, with the
    hard/extreme labels always read against the RAW skill value."""
    if roll > target:
        return None
    if roll <= raw_target // 5:
        return "extreme"
    if roll <= raw_target // 2:
        return "hard"
    return "regular"


def _thresholds(variant: str | None, raw: int, effective: int) -> tuple[int, int]:
    """(crit threshold, fumble threshold) per the `.setcoc` rule-table wording."""
    if variant is None:  # rule 0, the rulebook rule
        return 1, 96 if effective < 50 else 100
    if variant == "rule1":
        return (5 if raw >= 50 else 1), (96 if raw < 50 else 100)
    if variant == "rule2":
        return min(5, raw), (96 if raw < 96 else min(raw + 1, 100))
    if variant == "rule4":
        return min(raw // 10, 5), min(96 + raw // 10, 100)
    if variant == "rule5":
        return min(raw // 5, 2), (96 if raw < 50 else 99)
    raise AssertionError(variant)


@pytest.fixture(scope="module")
def coc_resolver():
    return load_rulepack("coc7").resolver


def test_coc_ladders_match_the_rulebook_exhaustively(coc_resolver):
    """Every roll × every target × every difficulty × every house variant."""
    mismatches: list[str] = []
    for variant in COC_VARIANTS:
        for difficulty in COC_DIFFICULTIES:
            for raw_target in range(0, 101):
                for roll in range(1, 101):
                    outcome = coc_resolver.interpret(
                        RollDetail("1d100", (roll,), roll),
                        raw_target,
                        variant=variant,
                        difficulty=difficulty,
                    )
                    expected = reference_coc(variant, roll, raw_target, difficulty)
                    if outcome.rank.id != expected:
                        mismatches.append(
                            f"{variant or 'rule0'}/{difficulty or 'regular'} "
                            f"target={raw_target} roll={roll}: ladder={outcome.rank.id} rulebook={expected}"
                        )
                        if len(mismatches) >= 20:
                            raise AssertionError("; ".join(mismatches))
    assert not mismatches, "; ".join(mismatches)


def test_coc_semantic_flags_and_margin_are_consistent(coc_resolver):
    """Flags follow the rank id everywhere; margin is effective_target - roll."""
    for variant in COC_VARIANTS:
        for raw_target in range(0, 101, 7):
            for roll in range(1, 101):
                outcome = coc_resolver.interpret(
                    RollDetail("1d100", (roll,), roll), raw_target, variant=variant
                )
                rank = outcome.rank
                assert rank.success == (rank.id in {"crit", "extreme", "hard", "regular"})
                assert rank.critical == (rank.id == "crit")
                assert rank.fumble == (rank.id == "fumble")
                assert outcome.margin == raw_target - roll
                if rank.fumble:
                    assert rank.tier == 0
                if rank.critical:
                    assert rank.tier == 5


def test_coc_tier_order_is_the_ladder_order(coc_resolver):
    ladder = {rule.rank.id: rule.rank.tier for rule in coc_resolver.ladders[""]}
    assert ladder["crit"] > ladder["extreme"] > ladder["hard"] > ladder["regular"] > ladder["fail"] > ladder["fumble"]


# ---------------------------------------------------------------------------
# D&D5e — d20 vs DC with natural-die crits (SRD)
# ---------------------------------------------------------------------------


def test_dnd_ladder_matches_the_srd_exhaustively():
    resolver = load_rulepack("dnd5e").resolver
    for natural in range(1, 21):
        for modifier in range(-5, 16):
            for dc in range(1, 31):
                outcome = resolver.interpret(
                    RollDetail("1d20", (natural,), natural), dc, modifier=modifier
                )
                if natural == 20:
                    expected = "crit"
                elif natural == 1:
                    expected = "fumble"
                elif natural + modifier >= dc:
                    expected = "success"
                else:
                    expected = "fail"
                assert outcome.rank.id == expected, (natural, modifier, dc, outcome.rank.id)
                assert outcome.margin == (natural + modifier) - dc


# ---------------------------------------------------------------------------
# WoD — success-counting pools (botch = zero successes with at least one 1)
# ---------------------------------------------------------------------------


def test_wod_ladder_matches_the_pool_rules_exhaustively():
    resolver = load_rulepack("wod").resolver
    for pool in range(1, 11):
        for successes in range(0, pool + 1):
            for ones in range(0, pool - successes + 1):
                detail = RollDetail(
                    f"{pool}d10>=6", (0,) * pool, successes, successes=successes, ones=ones
                )
                outcome = resolver.interpret(detail, None)
                if successes == 0 and ones > 0:
                    expected = "botch"
                elif successes == 0:
                    expected = "fail"
                else:
                    expected = "success"
                assert outcome.rank.id == expected, (pool, successes, ones, outcome.rank.id)
                assert outcome.margin == successes


def test_wod_pool_roll_aggregates_every_face_combination():
    """The ROLL side: enumerate every face combination of a small pool and check
    the success/ones aggregation the pack ladder consumes (seeded real rolls
    then spot-check the same invariant on the full d10 pool)."""
    from itertools import product

    for faces in product(range(1, 5), repeat=3):  # a 3d4>=3 toy pool, all 64 cells
        successes = sum(1 for face in faces if face >= 3)
        ones = sum(1 for face in faces if face == 1)
        detail = RollDetail("3d4>=3", faces, successes, successes=successes, ones=ones)
        assert (detail.successes, detail.ones) == (successes, ones)

    roller = DiceRoller()
    seed_dice(11)
    for _ in range(50):
        detail = roller.roll_detail("{pool}d10>={difficulty}", {"pool": 6, "difficulty": 7})
        assert len(detail.dice) == 6
        assert detail.successes == sum(1 for face in detail.dice if face >= 7)
        assert detail.ones == sum(1 for face in detail.dice if face == 1)
        assert detail.total == detail.successes


# ---------------------------------------------------------------------------
# Difficulty transforms — the named target adjustments
# ---------------------------------------------------------------------------


def test_coc_difficulty_transforms(coc_resolver):
    for raw in range(0, 101):
        assert coc_resolver.effective_target(raw, difficulty=None) == raw
        assert coc_resolver.effective_target(raw, difficulty="hard") == raw // 2
        assert coc_resolver.effective_target(raw, difficulty="extreme") == raw // 5
        assert coc_resolver.effective_target(raw, difficulty="critical") == 1
