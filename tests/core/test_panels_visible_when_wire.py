"""Sentinel: a `visible_when` gate must survive the trip to the wire.

`visible_when` exists to HIDE a block until a condition holds, so a gate that is
accepted at build time and then dropped from the manifest fails OPEN — the author's
day-46 clue board ships to every player from turn 1, with no error to notice. The
build-time half is covered by `test_visible_when_vectors.py`; this file pins the wire
half of the same promise for every block shape a gate may sit on, `repeat` included.
"""

from __future__ import annotations

from core.panels import parse_panels_text, wire_panel

GATED_REPEAT_YAML = """\
panels:
  - id: clue-board
    title: {en: Clue Board, zh: 线索板}
    slot: sidebar
    blocks:
      - visible_when: "day >= 46"
        repeat:
          prefix: "clue_"
          block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}
      - {kind: text, text: {en: The survey is open., zh: 巡视开始了。}, visible_when: "day >= 46"}
"""

INNER_GATE_YAML = """\
panels:
  - id: clue-board
    title: {en: Clue Board, zh: 线索板}
    slot: sidebar
    blocks:
      - repeat:
          prefix: "clue_"
          block: {kind: badge, label: {$leaf: label}, visible_when: "day >= 46"}
"""

UNGATED_REPEAT_YAML = """\
panels:
  - id: clue-board
    title: {en: Clue Board, zh: 线索板}
    slot: sidebar
    blocks:
      - repeat:
          prefix: "clue_"
          block: {kind: badge, label: {$leaf: label}}
"""


def test_repeat_level_gate_reaches_the_wire() -> None:
    """The sentinel: an author gating a WHOLE repeat must not have the gate silently
    dropped between `parse_panels_text` (which validates and keeps it) and the
    manifest every player receives."""
    (panel,) = parse_panels_text(GATED_REPEAT_YAML)
    assert panel.blocks[0]["visible_when"] == "day >= 46"  # the build kept it...

    blocks = wire_panel("wenfu", panel, {})["blocks"]
    assert blocks[0]["visible_when"] == "day >= 46"  # ...and so does the wire.
    # Positive control: the repeat itself still rides intact, and the ordinary block's
    # own gate (the path that always worked) is untouched — so this cannot pass by the
    # panel having quietly lost its blocks.
    assert blocks[0]["repeat"] == {
        "prefix": "clue_",
        "block": {"kind": "stat", "label": {"$leaf": "label"}, "value": {"$leaf": "value"}},
    }
    assert blocks[1] == {
        "kind": "text",
        "text": {"en": "The survey is open.", "zh": "巡视开始了。"},
        "visible_when": "day >= 46",
    }


def test_inner_template_gate_still_reaches_the_wire() -> None:
    """Positive control for the other half of the documented contract: a gate on the
    repeat's INNER template (the case that already worked) keeps working."""
    (panel,) = parse_panels_text(INNER_GATE_YAML)
    blocks = wire_panel("wenfu", panel, {})["blocks"]
    assert blocks[0]["repeat"]["block"]["visible_when"] == "day >= 46"


def test_ungated_repeat_carries_no_condition() -> None:
    """The negative control: nothing invents a gate where the author wrote none —
    an always-on repeat must not acquire a `visible_when` key."""
    (panel,) = parse_panels_text(UNGATED_REPEAT_YAML)
    blocks = wire_panel("wenfu", panel, {})["blocks"]
    assert blocks[0] == {
        "repeat": {"prefix": "clue_", "block": {"kind": "badge", "label": {"$leaf": "label"}}}
    }
