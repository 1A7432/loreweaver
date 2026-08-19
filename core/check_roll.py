"""The one ROLL-and-GRADE step both check lanes share.

A player's typed check (`gateway.commands.checks`) and the Keeper's `skill_check` tool
(`agent.kp_tools_mechanics`) parse different inputs, render different text and publish
different events — but between those two ends they do the same three things: route the
favorable/unfavorable counts to the pack's declared roll modifiers, roll through the
resolver, grade the roll against the target. That middle used to be written out twice;
it lives here so the two lanes cannot drift on how a check is rolled and graded
(iron rule #1 — the dice and the grading are deterministic code, once).

Deliberately narrow: the lanes still decide WHAT the target and sheet modifier are (a
typed temporary value, an explicit DC, an NPC's stated number, the sheet's own value)
and they still own their events, records and wording. `graded_roll` is the step in
between, nothing more.
"""

from __future__ import annotations

from dataclasses import dataclass

from core.check_outcome import CheckOutcome, RollDetail
from core.resolution import CheckResolver, CheckSpec


def favor_modifiers(check: CheckSpec, bonus: int, penalty: int) -> tuple[dict[str, int], str]:
    """Net the favorable/unfavorable counts onto the pack's declared modifier NAMES.

    Returns ``(modifiers, applied)``: the mapping `roll_for_check` takes, and the name
    of the modifier that ended up applied (``""`` when the counts cancel or the pack
    declares none), for the lane that wants to say so. Opposing counts cancel: two
    bonus and one penalty is one bonus, never both.
    """
    net = int(bonus) - int(penalty)
    if net > 0 and check.favorable:
        return {check.favorable: net}, check.favorable
    if net < 0 and check.unfavorable:
        return {check.unfavorable: -net}, check.unfavorable
    return {}, ""


@dataclass(frozen=True)
class GradedRoll:
    """One rolled-and-graded check. ``outcome`` is ``None`` for an UNGRADED roll — a
    modifier-style system rolled with no target declared, which the lane shows as a
    bare number rather than a rank."""

    rolled: RollDetail
    total: int  # the roll plus the lane's sheet modifier — what the target was compared to
    target: int | None
    effective_target: int | None  # the difficulty-adjusted target, when one applied
    outcome: CheckOutcome | None


def graded_roll(
    dice,
    resolver: CheckResolver,
    *,
    modifiers: dict[str, int] | None,
    target: int | None,
    modifier: int = 0,
    variant: str | None = None,
    difficulty: str | None = None,
) -> GradedRoll:
    """Roll through ``resolver`` with ``modifiers`` and grade against ``target``.

    ``modifier`` is the lane's flat sheet modifier for roll-plus-modifier systems (the
    d20 family); roll-under systems pass 0. ``difficulty`` is a pack-declared difficulty
    id (the typed lane's `/hard`, `/extreme`); the tool lane passes none. A ``target`` of
    ``None`` rolls without grading.
    """
    rolled = dice.roll_for_check(resolver, modifiers=modifiers or None)
    total = rolled.total + int(modifier)
    if target is None:
        return GradedRoll(rolled=rolled, total=total, target=None, effective_target=None, outcome=None)
    outcome = resolver.interpret(rolled, target, variant=variant, difficulty=difficulty, modifier=modifier)
    return GradedRoll(
        rolled=rolled,
        total=total,
        target=target,
        effective_target=resolver.effective_target(target, difficulty=difficulty),
        outcome=outcome,
    )
