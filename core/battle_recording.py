"""Shared structured battle-record mappings for tools and deterministic commands.

M16 stage A: check records are written from the neutral `core.check_outcome`
contract — semantic flags (`success`/`critical`/`fumble`), the pack-vocabulary
`rank_id`, ladder `tier`, and the rendered `label` — never a system's private
rank code. System-shaped roll details (bonus/penalty tens dice, difficulty,
house-rule selector, ...) ride in from `RollDetail.modifiers` as plain data.
"""

from __future__ import annotations

from typing import Any

from core.battle_report import BattleReportManager
from core.check_outcome import CheckOutcome
from core.dice_engine import DiceResult


def dice_critical_fields(result: DiceResult) -> tuple[bool, str]:
    """Return the report's canonical critical flag and type for one raw roll."""
    if result.is_critical_success():
        return True, "success"
    if result.is_critical_failure():
        return True, "failure"
    return False, ""


def check_fields(outcome: CheckOutcome, *, label: str = "") -> dict[str, Any]:
    """Map one `CheckOutcome` to the canonical stored check-detail set.

    `label` is the display label rendered at record time (reports replay it
    verbatim — a historical record keeps the language it was played in).
    """
    fields: dict[str, Any] = {
        "success": outcome.rank.success,
        "rank_id": outcome.rank.id,
        "tier": outcome.rank.tier,
        "critical": outcome.rank.critical,
        "fumble": outcome.rank.fumble,
        **dict(outcome.rolled.modifiers),
    }
    if label:
        fields["label"] = label
    if outcome.margin is not None:
        fields["margin"] = outcome.margin
    return fields


async def record_dice_roll(
    battles: BattleReportManager,
    chat_key: str,
    user_id: str,
    char_name: str,
    expression: str,
    result: DiceResult,
    *,
    hidden: bool = False,
) -> None:
    """Persist one raw roll using the mapping shared by tools and commands.

    ``hidden`` flags a private/keeper roll (e.g. `.rh`) so it is recorded for
    the keeper's bookkeeping yet excluded from every player-facing report.
    """
    is_critical, critical_type = dice_critical_fields(result)
    await battles.add_dice_roll(
        chat_key,
        user_id,
        char_name,
        expression,
        result.total,
        is_critical,
        critical_type,
        hidden=hidden,
    )


async def record_check(
    battles: BattleReportManager,
    chat_key: str,
    user_id: str,
    char_name: str,
    skill: str,
    outcome: CheckOutcome,
    *,
    label: str = "",
    **extra: object,
) -> None:
    """Persist one graded check with its canonical outcome fields."""
    details = check_fields(outcome, label=label)
    details.update(extra)
    await battles.add_skill_check(
        chat_key,
        user_id,
        char_name,
        skill,
        int(outcome.target or 0),
        outcome.rolled.total,
        **details,
    )
