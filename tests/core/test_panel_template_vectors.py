"""The Python half of the panel template-instantiation conformance suite.

`tests/fixtures/panel_template_vectors.json` is consumed by BOTH this file and
`clients/tui/src/panelTemplates.vectors.test.ts`. Turning a panel's template blocks plus
one viewer's variables into resolved blocks happens in every client AND on the server
(the `.panel` text fallback), so "the reference client and the engine agree" is a promise
no amount of prose can keep — the vector table is the promise, and a row that moves
breaks both suites at once. Same shape as `test_visible_when_vectors.py`, which pinned
the condition grammar the same way; the reference client stays the oracle.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from core.panels import MAX_REPEAT_INSTANCES, resolve_panel_blocks

VECTORS = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "panel_template_vectors.json").read_text(encoding="utf-8")
)


def _comparable(value: Any) -> Any:
    """The shape both halves of the table can be compared in.

    JSON round-trip first, so nothing the resolver happened to build as a tuple compares
    unequal to the list it becomes on the wire. Then two normalizations that make the
    comparison say what we MEAN: an integral float is its int (JavaScript has one number
    type, so the oracle cannot tell `1` from `1.0` and neither should this), and a bool
    is tagged, because Python's `True == 1` would otherwise let a `stat` that lost its
    type pass here while failing in the TypeScript half.
    """

    def walk(node: Any) -> Any:
        if isinstance(node, bool):
            return ("bool", node)
        if isinstance(node, float) and node.is_integer():
            return int(node)
        if isinstance(node, dict):
            return {key: walk(item) for key, item in node.items()}
        if isinstance(node, list):
            return [walk(item) for item in node]
        return node

    return walk(json.loads(json.dumps(value, ensure_ascii=False)))


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["id"])
def test_vector_resolves_as_the_table_says(case: dict) -> None:
    resolved = resolve_panel_blocks(case["blocks"], case["variables"], case["locale"])
    assert _comparable(resolved) == _comparable(case["expect"]), case["why"]


def test_the_table_covers_the_contract() -> None:
    # A conformance table that quietly emptied itself would pass every case above.
    cases = VECTORS["cases"]
    assert len(cases) >= 30
    kinds = {
        block.get("kind")
        for case in cases
        for block in case["expect"]
    }
    # Every block kind a panel may resolve INTO is exercised by at least one row.
    assert kinds == {
        "divider",
        "meter",
        "stat",
        "badge",
        "text",
        "image",
        "choices",
        "letter",
        "clipping",
        "title_card",
        "map_pin",
    }
    # And both halves of fail-closed: rows that render nothing, rows that render a lot.
    assert any(not case["expect"] for case in cases)
    assert any(len(case["expect"]) == MAX_REPEAT_INSTANCES for case in cases)
