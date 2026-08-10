"""ORACLE: the end-of-turn check table cannot blow the per-turn model-call budget.

Same family as `tests/agent/test_turn_call_budget.py`, and it exists for a reason the
other one does not have: the table is **rulepack-declarable**. Content packs are data
written by other people, and one of them asking for `max_rounds: 40` must be a clamp, not
an outage. The engine clamps; this pins that it does.

The number the budget note in AGENTS.md is written against is the OLD pair of correctives:
`_CORRECTIVE_MAX_ROUNDS` 2 + `_STATE_CORRECTIVE_MAX_ROUNDS` 3 = 5 chat calls per turn. The
runner inherits that ceiling exactly, so the milestone changes the shape of the corrective
lane without changing its cost.
"""

from __future__ import annotations

from agent.turn_checks import (
    CONDITIONS,
    DEFAULT_TURN_CHECKS,
    MAX_ROUNDS_PER_CHECK,
    MAX_ROUNDS_PER_TURN,
    turn_checks_for,
)
from core.rulepacks import RulePack

# What the old pair of hand-written correctives could spend. AGENTS.md's ~155 model calls
# per player turn is computed from it — moving this means moving that note and
# `tests/agent/test_turn_call_budget.py` in the same commit.
LEGACY_CORRECTIVE_ROUNDS = 5


def test_the_global_ceiling_matches_what_the_budget_note_assumes():
    assert MAX_ROUNDS_PER_TURN == LEGACY_CORRECTIVE_ROUNDS


def test_the_engine_default_table_fits_inside_the_ceiling():
    assert sum(check.max_rounds for check in DEFAULT_TURN_CHECKS) <= MAX_ROUNDS_PER_TURN


def test_every_default_check_names_a_condition_that_exists():
    for check in DEFAULT_TURN_CHECKS:
        assert check.condition in CONDITIONS, check.condition
        assert check.instruction_key, f"{check.id} has no instruction"


def _pack_with(rows) -> RulePack:
    return RulePack(
        system="greedy",
        defaults={},
        alias={},
        st_show={},
        set_keys=[],
        creation_constraints={},
        alias_to_canonical={},
        derived_formulas={},
        turn_checks=tuple(rows),
    )


def test_a_greedy_pack_is_clamped_per_check():
    table = turn_checks_for(_pack_with([{"when": condition, "max_rounds": 99} for condition in CONDITIONS]))

    assert table, "the pack's rows survive — they are clamped, not dropped"
    for check in table:
        assert check.max_rounds <= MAX_ROUNDS_PER_CHECK


def test_a_greedy_pack_cannot_outspend_the_turn_ceiling():
    """Per-check clamping alone is not enough: enough rows still add up. The runner's own
    total counter is what closes it, so assert the two facts together — a pack CAN declare
    a table whose caps sum past the ceiling, and the ceiling still holds."""
    table = turn_checks_for(_pack_with([{"when": condition, "max_rounds": 3} for condition in CONDITIONS] * 4))

    assert sum(check.max_rounds for check in table) > MAX_ROUNDS_PER_TURN, "the sum really can exceed it"
    assert MAX_ROUNDS_PER_TURN == LEGACY_CORRECTIVE_ROUNDS, (
        "and the runner stops at this many calls regardless — see "
        "tests/agent/test_turn_checks.py::test_the_gate_is_bounded_and_keeps_the_best_reply_it_got"
    )
