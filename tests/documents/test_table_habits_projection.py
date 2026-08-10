"""M20 E sentinel: the table's habit notes never reach the table.

Same family as `tests/documents/test_secrecy_sentinels.py`. Habit records describe the
PLAYERS — how much combat they have patience for, which of the Keeper's gambits fell flat,
what they skip. Showing that to the people it describes is a metagaming leak in one
direction and simply rude in the other, so the player-grade projection returns `None`
rather than a redacted view: a redaction would still tell them a file on them exists.

Every leak assertion carries a positive control, so a projection that returns nothing at
all cannot pass this file vacuously.
"""

from __future__ import annotations

import json

from core.documents import (
    KEEPER_VIEWER,
    PLAYER_VIEWER,
    Document,
    Viewer,
    document_type,
    project,
)
from core.table_habits import HABITS_DOC_TYPE, HABITS_ID, PROMOTION_THRESHOLD, index_lines, observe

SENTINEL = "THEY_WALK_OUT_OF_LONG_COMBATS"


def _doc(data: dict) -> Document:
    return Document(id=HABITS_ID, type=HABITS_DOC_TYPE, schema_version=1, data=data)


def _habits_doc() -> Document:
    return _doc(
        {
            "habits": [{"summary": SENTINEL, "detail": "Three sessions running.", "seen": 3}],
            "pending": [{"summary": "THEY_SKIP_SHOPPING_SCENES", "detail": "", "seen": 1}],
        }
    )


def test_a_player_sees_nothing_at_all():
    assert project(_habits_doc(), PLAYER_VIEWER) is None


def test_no_player_grade_viewer_of_any_shape_gets_a_view():
    """A player with a character, a spectator, an unknown role — the discriminator is
    `is_keeper`, so there is no viewer shape that quietly qualifies."""
    for viewer in (
        PLAYER_VIEWER,
        Viewer(role="player", member_id="u1"),
        Viewer(role="player", actor_id="npc:elias"),
        Viewer(role="spectator"),
        Viewer(role=""),
    ):
        assert project(_habits_doc(), viewer) is None, viewer


def test_the_keeper_positive_control_really_sees_it():
    """Without this, every assertion above would pass on a projection that returns None
    for everyone — including a type that was never registered."""
    view = project(_habits_doc(), KEEPER_VIEWER)

    assert view is not None
    assert SENTINEL in json.dumps(view, ensure_ascii=False)


def test_the_sentinel_never_appears_in_any_player_serialization():
    """Belt and braces on the whole document, not just the fields this test knows about:
    a future field cannot leak by being added."""
    assert SENTINEL not in json.dumps(project(_habits_doc(), PLAYER_VIEWER), ensure_ascii=False)


def test_the_type_is_registered_as_a_singleton_with_a_validator():
    registered = document_type(HABITS_DOC_TYPE)

    assert registered.singleton_id == HABITS_ID
    assert registered.validate_write(_doc({"habits": "not a list"}), None)
    assert registered.validate_write(_habits_doc(), None) == []


# ---------------------------------------------------------------------------
# The recurrence count, and where it lives
# ---------------------------------------------------------------------------


def test_a_candidate_needs_to_recur_before_it_becomes_a_habit():
    """THE reason `pending` exists. The Scribe has no cross-turn memory and whispers are
    read-and-clear, so the tally has to live in the document itself."""
    data: dict = {}
    for sighting in range(1, PROMOTION_THRESHOLD):
        data, promoted = observe(data, "they cut investigation short")
        assert not promoted, f"promoted after only {sighting} sighting(s)"
        assert index_lines(data) == [], "an unproven candidate must not reach the prompt index"

    data, promoted = observe(data, "they cut investigation short")

    assert promoted
    assert index_lines(data) == ["they cut investigation short"]
    assert data["pending"] == [], "a promoted candidate leaves the waiting room"


def test_an_established_habit_does_not_re_enter_the_waiting_room():
    data, _ = observe({"habits": [{"summary": "they like short fights", "detail": "", "seen": 3}]}, "they like short fights")

    assert data["pending"] == []
    assert len(data["habits"]) == 1, "a habit does not get louder by repetition"


def test_only_summaries_are_resident_never_the_details():
    """Index-only residency: a habits document allowed to grow into the prompt would be a
    fifth memory mechanism competing with the four that already work."""
    lines = index_lines(
        {"habits": [{"summary": "short fights", "detail": "A long paragraph the prompt must not carry.", "seen": 3}]}
    )

    assert lines == ["short fights"]
