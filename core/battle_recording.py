"""Shared structured battle-record mappings for tools and deterministic commands."""

from __future__ import annotations

from typing import Any

from core.battle_report import BattleReportManager
from core.dice_engine import DiceResult


def dice_critical_fields(result: DiceResult) -> tuple[bool, str]:
    """Return the report's canonical critical flag and type for one raw roll."""
    if result.is_critical_success():
        return True, "success"
    if result.is_critical_failure():
        return True, "failure"
    return False, ""


def coc_check_fields(outcome: dict[str, Any]) -> dict[str, Any]:
    """Map either CoC roller result shape to one canonical report detail set."""
    final_roll = int(outcome.get("final_roll", outcome["roll"]))
    base_roll = int(outcome.get("raw_roll", outcome.get("roll", final_roll)))
    rank = int(outcome["rank"])
    fields: dict[str, Any] = {
        "success": bool(outcome["success"]),
        "rank": rank,
        "is_critical": rank in {4, -2},
        "bonus": int(outcome.get("bonus", 0) or 0),
        "penalty": int(outcome.get("penalty", 0) or 0),
        "raw_roll": final_roll,
        "base_roll": base_roll,
        "difficulty": int(outcome.get("difficulty", 1) or 1),
        "rule": int(outcome.get("rule", 0) or 0),
    }
    if "extra_tens" in outcome:
        fields["extra_tens"] = list(outcome.get("extra_tens") or [])
    if outcome.get("final_tens") is not None:
        fields["final_tens"] = int(outcome["final_tens"])
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


async def record_coc_skill_check(
    battles: BattleReportManager,
    chat_key: str,
    user_id: str,
    char_name: str,
    skill: str,
    target: int,
    outcome: dict[str, Any],
    **extra: object,
) -> None:
    """Persist one CoC check with canonical outcome, raw-roll, and candidate metadata."""
    details = coc_check_fields(outcome)
    details.update(extra)
    final_roll = int(outcome.get("final_roll", outcome["roll"]))
    await battles.add_skill_check(
        chat_key,
        user_id,
        char_name,
        skill,
        target,
        final_roll,
        **details,
    )
