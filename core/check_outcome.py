"""The neutral check-outcome contract every rules consumer reads (M16 stage A).

``Rank``/``RollDetail``/``CheckOutcome`` are the ONLY shapes ``agent/`` and
``gateway/`` may consume for graded check results. ``Rank.id`` is pack
vocabulary (``"extreme"``, ``"strong_hit"``, ...) and strictly presentational;
the semantic booleans and ``tier`` are the only fields a consumer may branch
on (``tests/architecture/test_rules_decoupling.py`` enforces this). Opposed
checks compare ``tier`` first, then ``margin`` — never rank ids.

``label_key`` names how the rank renders: while the legacy resolution code is
alive (stage A) it is an ``infra.i18n`` key; once packs carry their own
``labels:`` tables (stage C) it becomes the pack-relative rank id and the
engine i18n keys are deleted.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Rank:
    """One rung of a rule system's success ladder."""

    id: str
    tier: int
    label_key: str
    success: bool = False
    critical: bool = False
    fumble: bool = False


@dataclass(frozen=True)
class RollDetail:
    """What the engine actually rolled: expression, kept natural faces, total.

    ``modifiers`` carries the named, system-declared roll transforms that were
    applied (bonus/penalty tens dice, advantage candidates, flat modifiers,
    difficulty selectors, ...) as plain data for records and wire frames.
    ``successes``/``ones`` are populated only for success-counting pool rolls.
    """

    expression: str
    dice: tuple[int, ...]
    total: int
    modifiers: Mapping[str, Any] = field(default_factory=dict)
    successes: int | None = None
    ones: int | None = None


@dataclass(frozen=True)
class CheckOutcome:
    """One resolved check: the roll, the target, the graded rank, the margin.

    ``margin`` is the signed distance from the target in the system's own
    metric (positive = on the success side); ``None`` when the system has no
    meaningful margin for this check.
    """

    rolled: RollDetail
    target: int | None
    rank: Rank
    margin: int | None = None


def outcome_wire(outcome: CheckOutcome, label: str) -> dict[str, Any]:
    """The protocol-2.0 ``dice.outcome`` object for one graded check.

    ``label`` is the display label rendered in the room's locale; clients
    color by the semantic flags/``tier`` and print ``label`` verbatim.
    """
    wire: dict[str, Any] = {
        "id": outcome.rank.id,
        "label": label,
        "success": outcome.rank.success,
        "critical": outcome.rank.critical,
        "fumble": outcome.rank.fumble,
        "tier": outcome.rank.tier,
    }
    if outcome.margin is not None:
        wire["margin"] = outcome.margin
    return wire
