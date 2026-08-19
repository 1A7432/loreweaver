"""core.check_roll — the roll-and-grade step both check lanes share."""

from __future__ import annotations

from core.check_roll import favor_modifiers, graded_roll
from core.dice_engine import DiceRoller, seed_dice
from core.rulepacks import load_rulepack


def test_favor_modifiers_nets_the_counts_onto_the_packs_declared_names():
    check = load_rulepack("coc7").resolver.check
    assert favor_modifiers(check, 2, 0) == ({check.favorable: 2}, check.favorable)
    assert favor_modifiers(check, 0, 1) == ({check.unfavorable: 1}, check.unfavorable)
    assert favor_modifiers(check, 2, 1) == ({check.favorable: 1}, check.favorable)  # opposing counts cancel
    assert favor_modifiers(check, 1, 1) == ({}, "")


def test_graded_roll_grades_against_the_target_and_reports_the_effective_one():
    pack = load_rulepack("coc7")
    dice = DiceRoller()
    seed_dice(7)
    graded = graded_roll(dice, pack.resolver, modifiers={}, target=60, difficulty="hard")
    assert graded.target == 60 and graded.effective_target == 30  # coc7 hard = half
    assert graded.outcome is not None and graded.outcome.target == 60  # the raw target rides the outcome
    assert graded.outcome.rank.success is (graded.rolled.total <= 30)  # graded against the EFFECTIVE one
    assert graded.total == graded.rolled.total  # roll-under: no flat modifier


def test_graded_roll_without_a_target_is_ungraded():
    pack = load_rulepack("dnd5e")
    dice = DiceRoller()
    seed_dice(3)
    graded = graded_roll(dice, pack.resolver, modifiers={}, target=None, modifier=4)
    assert graded.outcome is None and graded.effective_target is None
    assert graded.total == graded.rolled.total + 4
