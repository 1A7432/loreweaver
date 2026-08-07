"""M18 oracle: chronicle document projections — keeper annotations never cross `project()`.

Written FIRST (red) per the milestone's oracle-first discipline, in the same
sentinel family as `tests/documents/test_secrecy_sentinels.py`:

1. `chronicle` entries — the narrative record is table-public, but the keeper's
   spoiler annotations (what players MISSED, which secret consequences are now
   armed) live in the ``keeper`` field and must never reach a player-grade view.
2. `campaign_summary` — the rolling "story so far" backs the player-facing
   `.recap`; its keeper margin (``keeper`` field) must never cross.
3. `thread` — the open-loops tracker holds planted foreshadowing and armed
   consequences: keeper-only, whole-document (fail-closed, like `note`).

Each leak assertion comes with a positive control so a projection that returns
nothing cannot pass vacuously.
"""

from __future__ import annotations

import json

import pytest

from core.chronicle import (
    CAMPAIGN_SUMMARY_DOC_TYPE,
    CAMPAIGN_SUMMARY_ID,
    CHRONICLE_DOC_TYPE,
    THREAD_DOC_TYPE,
)
from core.documents import (
    KEEPER_VIEWER,
    PLAYER_VIEWER,
    Document,
    DocumentStore,
    DocumentValidationError,
    actor_viewer,
    project,
)
from infra.store import Store

# A keeper-side spoiler that must never appear in any player-grade rendering.
SENTINEL = "THE SUNKEN BELL MUST NEVER RING"

ROOM = "chronicle-room"


def _doc(doc_type: str, doc_id: str, data: dict) -> Document:
    return Document(id=doc_id, type=doc_type, schema_version=1, data=data)


def _dump(view: dict | None) -> str:
    return json.dumps(view, ensure_ascii=False) if view is not None else ""


# -- 1. chronicle entries -----------------------------------------------------


def _chronicle_doc() -> Document:
    return _doc(
        CHRONICLE_DOC_TYPE,
        "c00012",
        {
            "text": "The party rang the chapel bell and the drowned choir answered.",
            "keeper": f"Players MISSED the second bell pull; {SENTINEL} is now armed.",
            "turn": 12,
            "pcs": ["Martha"],
            "scene": "chapel",
            "folded": False,
            "tokens": 40,
        },
    )


def test_chronicle_keeper_annotations_never_project_to_players() -> None:
    doc = _chronicle_doc()

    player = _dump(project(doc, PLAYER_VIEWER))
    assert SENTINEL not in player, "keeper annotations must never reach players"
    assert "keeper" not in player, "the annotation field NAME itself stays out of the player view"
    assert "folded" not in player and "tokens" not in player, "engine bookkeeping is not player content"
    assert "drowned choir" in player, "positive control: the public narrative record survives"
    assert '"turn": 12' in player and "Martha" in player, "turn index and PC tags are table talk"

    actor = _dump(project(doc, actor_viewer("npc_elias")))
    assert SENTINEL not in actor, "sub-actor viewers are player-grade"

    keeper = _dump(project(doc, KEEPER_VIEWER))
    assert SENTINEL in keeper, "the keeper keeps the full record, annotations included"


# -- 2. campaign summary ------------------------------------------------------


def _summary_doc() -> Document:
    return _doc(
        CAMPAIGN_SUMMARY_DOC_TYPE,
        CAMPAIGN_SUMMARY_ID,
        {
            "text": "Previously: the party reached the drowned chapel and freed the bell ringer.",
            "keeper": f"Secret consequence armed: {SENTINEL}.",
            "through_turn": 40,
            "fold_count": 3,
        },
    )


def test_campaign_summary_keeper_margin_never_projects_to_players() -> None:
    doc = _summary_doc()

    player = project(doc, PLAYER_VIEWER)
    assert player is not None, "the recap is player-facing by design"
    assert SENTINEL not in _dump(player)
    assert "keeper" not in _dump(player)
    assert "fold_count" not in _dump(player), "fold bookkeeping is not player content"
    assert "freed the bell ringer" in player["text"], "positive control: the story-so-far survives"
    assert player["through_turn"] == 40

    keeper = _dump(project(doc, KEEPER_VIEWER))
    assert SENTINEL in keeper


# -- 3. threads (open loops) ---------------------------------------------------


def test_threads_are_keeper_only_documents() -> None:
    doc = _doc(
        THREAD_DOC_TYPE,
        "t-deadbeef",
        {"label": "The armed bell", "status": "open", "notes": SENTINEL},
    )

    assert project(doc, PLAYER_VIEWER) is None, "open loops may be planted foreshadowing: fail closed"
    assert project(doc, actor_viewer("npc_elias")) is None
    assert SENTINEL in _dump(project(doc, KEEPER_VIEWER))


# -- write-time validation ------------------------------------------------------


@pytest.fixture()
def docs() -> DocumentStore:
    return DocumentStore(Store(":memory:"))


async def test_thread_write_validation_rejects_a_bad_status(docs: DocumentStore) -> None:
    with pytest.raises(DocumentValidationError):
        await docs.put(ROOM, THREAD_DOC_TYPE, "t-1", {"label": "The armed bell", "status": "bogus", "notes": ""})
    with pytest.raises(DocumentValidationError):
        await docs.put(ROOM, THREAD_DOC_TYPE, "t-2", {"label": "", "status": "open", "notes": ""})

    good = await docs.put(ROOM, THREAD_DOC_TYPE, "t-3", {"label": "The armed bell", "status": "resolved", "notes": ""})
    assert good.data["status"] == "resolved"


async def test_chronicle_write_validation_requires_a_past_turn_and_text(docs: DocumentStore) -> None:
    with pytest.raises(DocumentValidationError):
        await docs.put(ROOM, CHRONICLE_DOC_TYPE, "c-1", {"text": "", "turn": 3})
    with pytest.raises(DocumentValidationError):
        await docs.put(ROOM, CHRONICLE_DOC_TYPE, "c-2", {"text": "something happened", "turn": -1})
    with pytest.raises(DocumentValidationError):
        await docs.put(ROOM, CHRONICLE_DOC_TYPE, "c-3", {"text": "something happened", "turn": "three"})

    good = await docs.put(ROOM, CHRONICLE_DOC_TYPE, "c-4", {"text": "something happened", "turn": 3})
    assert good.data["turn"] == 3
