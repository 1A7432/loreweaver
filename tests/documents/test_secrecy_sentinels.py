"""M17 oracle: the five red-line secrecy sentinels, ported to the document layer.

Secrecy fails SILENTLY — it leaks without erroring — so these projection tests
were written FIRST (red against the trivial stub projection) and the store
conversion only started once each type's real projection turned them green.

Each test constructs a document carrying a sentinel secret and asserts the
sentinel never crosses `project()` toward a player-grade viewer, with positive
controls proving the projection still carries what it must (a filter that
returns nothing would pass a leak assertion vacuously).

The five mechanisms, same sentinels as the pre-M17 red-line tests:
1. worldbook secret entries          — KEEPER_SECRET_SENTINEL
2. NPC actor isolation               — THE LIGHTHOUSE KEEPER IS THE MURDERER / Elias Crane
3. MVU fail-closed wire filter       — the 真凶 subtree
4. knowledge-pool split              — THE LIGHTHOUSE KEEPER IS THE MURDERER
5. modvar keeper-visibility          — the true_culprit tracker
"""

from __future__ import annotations

import json

from core.documents import (
    KEEPER_VIEWER,
    PLAYER_VIEWER,
    Document,
    actor_viewer,
    project,
)

SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"


def _doc(doc_type: str, doc_id: str, data: dict) -> Document:
    return Document(id=doc_id, type=doc_type, schema_version=1, data=data)


def _dump(view: dict | None) -> str:
    return json.dumps(view, ensure_ascii=False) if view is not None else ""


# -- 1. worldbook secret entries --------------------------------------------


def test_secret_lore_entry_never_projects_to_players() -> None:
    secret = _doc(
        "lore",
        "wb_secret",
        {"title": "The truth", "content": f"KEEPER_SECRET_SENTINEL: {SENTINEL}", "secret": True},
    )
    public = _doc("lore", "wb_public", {"title": "The town", "content": "A quiet harbor town.", "secret": False})

    assert project(secret, PLAYER_VIEWER) is None, "secret lore entry must be invisible to players"
    assert "KEEPER_SECRET_SENTINEL" not in _dump(project(secret, actor_viewer("npc_1")))

    keeper_view = project(secret, KEEPER_VIEWER)
    assert keeper_view is not None and SENTINEL in keeper_view["content"]
    player_public = project(public, PLAYER_VIEWER)
    assert player_public is not None and player_public["content"] == "A quiet harbor town."


# -- 2. NPC actor isolation --------------------------------------------------


def _martha() -> Document:
    return _doc(
        "npc",
        "npc_martha",
        {
            "name": "Martha",
            "persona": "A wary innkeeper.",
            "public_description": "The innkeeper of the Gull & Anchor.",
            "secret_agenda": f"Protect the secret: {SENTINEL}",
            "knowledge": ["The cellar floods at high tide."],
            "location": "the inn",
            "status": "",
        },
    )


def _elias() -> Document:
    return _doc(
        "npc",
        "npc_elias",
        {
            "name": "Elias Crane",
            "persona": "The lighthouse keeper.",
            "public_description": "Keeper of the northern light.",
            "secret_agenda": SENTINEL,
            "knowledge": [f"Elias Crane knows: {SENTINEL}"],
            "location": "the lighthouse",
            "status": "",
        },
    )


def test_npc_projection_isolates_secrets_per_actor() -> None:
    martha, elias = _martha(), _elias()

    own_view = project(martha, actor_viewer("npc_martha"))
    assert own_view is not None
    assert "The cellar floods at high tide." in _dump(own_view), "an actor keeps its OWN knowledge"

    cross_view = _dump(project(elias, actor_viewer("npc_martha")))
    assert SENTINEL not in cross_view, "another NPC's secrets must never reach a different actor"
    assert "secret_agenda" not in cross_view and "knowledge" not in cross_view

    player_view = _dump(project(elias, PLAYER_VIEWER))
    assert SENTINEL not in player_view, "NPC secrets must never reach a player-grade viewer"
    assert "Keeper of the northern light." in player_view, "the public description IS player-visible"

    keeper_view = _dump(project(elias, KEEPER_VIEWER))
    assert SENTINEL in keeper_view, "the keeper runs the mystery and sees everything"


# -- 3. MVU fail-closed wire filter ------------------------------------------


def _mvu_doc(exposed: list[str]) -> Document:
    return _doc(
        "mvu_tree",
        "mvu",
        {
            "tree": {
                "理": {"好感度": [30, "affection"]},
                "真凶": {"身份": [SENTINEL, "the culprit"]},
            },
            "exposed": exposed,
        },
    )


def test_mvu_projection_is_fail_closed_until_exposed() -> None:
    hidden = project(_mvu_doc([]), PLAYER_VIEWER)
    assert SENTINEL not in _dump(hidden), "an unexposed MVU tree ships to NOBODY's panel"
    assert "真凶" not in _dump(hidden)

    partial = project(_mvu_doc(["理"]), PLAYER_VIEWER)
    partial_dump = _dump(partial)
    assert "好感度" in partial_dump, "exposed subtree leaves ride the player view"
    assert SENTINEL not in partial_dump and "真凶" not in partial_dump, "siblings stay hidden"

    keeper = _dump(project(_mvu_doc([]), KEEPER_VIEWER))
    assert SENTINEL in keeper, "the keeper watches the module's internals live"


# -- 4. knowledge-pool split -------------------------------------------------


def _pool_doc() -> Document:
    return _doc(
        "module_pool",
        "module",
        {
            "keeper": {
                "truths": [SENTINEL],
                "npcs": [{"name": "Elias Crane", "secret": SENTINEL}],
                "scenes": [{"name": "The pier", "keeper_notes": f"note: {SENTINEL}"}],
            },
            "player": {
                "npcs": [{"name": "Elias Crane", "description": "Keeper of the northern light."}],
                "scenes": [{"name": "The pier"}],
            },
        },
    )


def test_knowledge_pool_projection_serves_only_the_player_half() -> None:
    doc = _pool_doc()
    player_view = _dump(project(doc, PLAYER_VIEWER))
    assert SENTINEL not in player_view, "red line: the sentinel must never reach the player-visible pool"
    assert "keeper_notes" not in player_view and "truths" not in player_view
    assert "The pier" in player_view, "the player half still serves scene names"

    keeper_view = _dump(project(doc, KEEPER_VIEWER))
    assert SENTINEL in keeper_view


# -- 5. modvar keeper-visibility ---------------------------------------------


def _modvars_doc() -> Document:
    return _doc(
        "modvars",
        "modvars",
        {
            "specs": {
                "town_fear": {
                    "id": "town_fear",
                    "kind": "number",
                    "visibility": "player",
                    "labels": {"en": "Town fear"},
                    "default": 0,
                },
                "true_culprit": {
                    "id": "true_culprit",
                    "kind": "text",
                    "visibility": "keeper",
                    "labels": {"en": "True culprit"},
                    "default": "",
                },
            },
            "values": {"town_fear": 2, "true_culprit": SENTINEL},
        },
    )


def test_keeper_only_modvars_never_project_to_players() -> None:
    doc = _modvars_doc()
    player_view = _dump(project(doc, PLAYER_VIEWER))
    assert "true_culprit" not in player_view, "keeper-only variables must not appear in ANY player field"
    assert SENTINEL not in player_view
    assert "town_fear" in player_view, "player-visible variables still project"

    keeper_view = _dump(project(doc, KEEPER_VIEWER))
    assert "true_culprit" in keeper_view and SENTINEL in keeper_view
