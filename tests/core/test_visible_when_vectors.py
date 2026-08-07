"""The Python half of the `visible_when` conformance suite (M19 item 7).

`tests/fixtures/visible_when_vectors.json` is consumed by BOTH this file and
`clients/protocol/src/condexpr.test.ts`. `visible_when` is evaluated CLIENT-side, so
"the reference implementation and every client agree" is a promise no amount of prose
can keep — the vector table is the promise, and a row that moves breaks both suites at
once. It is deliberately the first brick of the LWF conformance suite: a second
implementation of the format proves itself against files like this, not against docs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.condexpr import CondExprError, check_subset, compile_expression, evaluate_bool

VECTORS = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "visible_when_vectors.json").read_text(encoding="utf-8")
)


def _resolver(variables: dict):
    """The same resolution rule a client uses: a variable id looked up in the viewer's
    own `state.variables`, and `None` for anything absent."""
    return lambda path: variables.get(path)


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: f"{case['expr']} | {case['vars']}")
def test_vector_evaluates_as_the_table_says(case: dict) -> None:
    expected = case["expect"]
    if expected == "error":
        with pytest.raises(CondExprError):
            evaluate_bool(case["expr"], _resolver(case["vars"]))
        return
    assert evaluate_bool(case["expr"], _resolver(case["vars"])) is expected


def _panel_with(condition: str) -> str:
    return (
        "panels:\n"
        "  - id: gated\n"
        "    title: Gated\n"
        "    slot: sidebar\n"
        f"    blocks: [{{kind: text, text: hi, visible_when: {json.dumps(condition)}}}]\n"
    )


@pytest.mark.parametrize("case", VECTORS["rejected"], ids=lambda case: case["expr"])
def test_out_of_subset_expressions_are_refused_by_the_build(case: dict) -> None:
    """The contract is where an author meets it: a pack carrying one of these never
    builds. (Most fail the subset check specifically; a call to an unknown function
    fails the parse first — either way it does not ship.)"""
    from core.panels import parse_panels_text

    with pytest.raises(ValueError, match="visible_when"):
        parse_panels_text(_panel_with(case["expr"]))


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["expr"])
def test_every_accepted_vector_is_a_condition_a_pack_may_ship(case: dict) -> None:
    """The other direction: nothing in the accepted table is refused at build time —
    a portable expression an author cannot actually use would be a broken contract."""
    from core.panels import parse_panels_text

    (panel,) = parse_panels_text(_panel_with(case["expr"]))
    assert panel.blocks[0]["visible_when"] == case["expr"]


def test_the_table_covers_both_halves_of_the_contract() -> None:
    # A conformance table that quietly emptied itself would pass every case above.
    assert len(VECTORS["cases"]) >= 40
    assert len(VECTORS["rejected"]) >= 8
    assert any(case["expect"] == "error" for case in VECTORS["cases"])
    assert all(check_subset(case["expr"]) is None for case in VECTORS["cases"])
