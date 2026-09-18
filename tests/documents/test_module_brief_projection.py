"""Sentinel: a world card's prose brief never reaches a player.

Same family as `tests/documents/test_secrecy_sentinels.py`. The brief is the module's
own pitch — scenario text and authored openings routinely carry setup the players must
DISCOVER in play, so the player-grade projection returns `None` rather than a redacted
view. Every leak assertion carries a positive control, so a projection that returns
nothing at all cannot pass vacuously.
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
from core.module_brief import BRIEF_DOC_TYPE, brief_id, build_brief, validate_brief_write

SENTINEL = "THE_LANDLORD_WAS_NEVER_HUMAN"


def _brief_doc() -> Document:
    return Document(
        id="corridor",
        type=BRIEF_DOC_TYPE,
        schema_version=1,
        data={
            "name": "回廊公寓",
            "description": "A corridor building.",
            "scenario": SENTINEL,
            "opening": "Rain again.",
            "openings": ["The rain never came."],
            "tags": ["investigation"],
        },
    )


def test_a_player_sees_nothing_at_all():
    assert project(_brief_doc(), PLAYER_VIEWER) is None


def test_no_player_grade_viewer_of_any_shape_gets_a_view():
    for viewer in (
        PLAYER_VIEWER,
        Viewer(role="player", member_id="u1"),
        Viewer(role="player", actor_id="npc:elias"),
        Viewer(role="spectator"),
        Viewer(role=""),
    ):
        view = project(_brief_doc(), viewer)
        assert view is None, viewer
        assert SENTINEL not in json.dumps(view)


def test_the_keeper_positive_control_really_sees_it():
    view = project(_brief_doc(), KEEPER_VIEWER)
    assert view is not None and view["scenario"] == SENTINEL
    assert document_type(BRIEF_DOC_TYPE).singleton_id is None  # one brief PER imported card


def test_build_brief_copies_prose_and_skips_proseless_cards():
    class _Card:
        name = "Manor"
        description = "  a manor  "
        personality = ""
        scenario = ""
        first_mes = ""
        mes_example = ""
        creator_notes = ""
        tags = ["x"]

    brief = build_brief(_Card(), ("alt one", ""))
    assert brief is not None
    assert brief["description"] == "a manor" and brief["openings"] == ["alt one"]
    assert validate_brief_write(_brief_doc(), None) == []

    class _Empty:
        name = "Blank"
        description = ""
        personality = ""
        scenario = ""
        first_mes = ""
        mes_example = ""
        creator_notes = ""
        tags = []

    assert build_brief(_Empty()) is None


def test_brief_id_is_stable_and_bounded():
    assert brief_id("回廊公寓") == brief_id("回廊公寓")
    assert brief_id("The  Manor!") == "the-manor"
    assert brief_id("") == "card"
    assert len(brief_id("x" * 300)) <= 64


# --- the card's standing directives ride the same brief, keeper-only -----------------

DIRECTIVE_SENTINEL = "ONLY_THE_KEEPER_READS_THIS_DIRECTIVE"


def _brief_with_directives() -> Document:
    return Document(
        id="rules",
        type=BRIEF_DOC_TYPE,
        schema_version=1,
        data={
            "name": "Rules",
            "directives_head": DIRECTIVE_SENTINEL,
            "directives_post": DIRECTIVE_SENTINEL + "_POST",
        },
    )


def test_directives_never_reach_a_player_grade_view():
    doc = _brief_with_directives()
    for viewer in (PLAYER_VIEWER, Viewer(role="player", member_id="u1"), Viewer(role="spectator")):
        view = project(doc, viewer)
        assert view is None, viewer
        assert DIRECTIVE_SENTINEL not in json.dumps(view)
    keeper = project(doc, KEEPER_VIEWER)
    assert keeper is not None and keeper["directives_head"] == DIRECTIVE_SENTINEL
    assert validate_brief_write(doc, None) == []


def test_directive_fields_are_bounded_like_every_brief_field():
    doc = _brief_with_directives()
    doc.data["directives_post"] = "x" * 9_000
    assert any("directives_post" in problem for problem in validate_brief_write(doc, None))
