"""M19 ORACLE: the Stage Director's context is player-scoped BY CONSTRUCTION.

The Director (`agent.stage_director`) writes straight onto the players' screens —
pictures, letters, act cards, audio. It is therefore the newest member of the
knowledge-scoped actor family (NPC/companion precedent, iron rule #3): its whole
context is the PROJECTED player-visible stream plus the module's presentation kit.
It structurally cannot leak what it never receives.

Secrecy fails SILENTLY — nothing errors when a secret crosses — so these tests were
written FIRST, red, against no implementation at all, exactly like the M17 projection
sentinels. Two complementary gates:

1. **Behavioural** — plant the five keeper-side secrets in a real room, run one beat,
   and inspect the EXACT messages the model was handed. Positive controls prove the
   Director still receives what it needs (a filter returning nothing would pass every
   leak assertion vacuously).
2. **Structural** — the module may not even NAME the keeper viewer or a keeper-only
   document id. A behavioural test only covers the paths it exercises; this one covers
   the file.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

from agent.context import AgentCtx
from agent.services import build_services
from core.documents import KEEPER_VIEWER, MODULE_POOL_ID
from core.modvars import define_modvar, set_modvar
from core.mvu_compat import save_mvu
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
from tests.fixtures.presentation_pack import install_kit_pack

REPO_ROOT = Path(__file__).resolve().parents[2]
DIRECTOR_SOURCE = REPO_ROOT / "agent" / "stage_director.py"

CHAT = "director-isolation"

# The five keeper-side mechanisms, each with its own sentinel string.
POOL_SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"
MODVAR_SENTINEL = "Elias Crane"
MVU_SENTINEL = "沈氏献妻"
LORE_SENTINEL = "KEEPER_SECRET_SENTINEL"
NOTE_SENTINEL = "the seventh lantern is never lit"

# What the Director legitimately sees — the positive controls.
PLAYER_LINE = "The tide pulls back and nine lanterns stand along the quay."
PLAYER_ACTION = "I count the lanterns."
PLAYER_MODVAR_LABEL = "祭典日"


async def _seeded_services(tmp_path):
    """A room carrying every keeper-side secret AND real player-visible content."""
    captured: list[list[dict]] = []

    def responder(messages, tools):
        captured.append([dict(message) for message in messages])
        return assistant_text(json.dumps({"blocks": [], "audio": [], "image": None, "prepare": []}))

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(64))
    # The Director is kit-gated: a module opts in by shipping a presentation kit.
    await install_kit_pack(services, CHAT, tmp_path)

    # 1. keeper knowledge pool (player half is legitimately visible)
    await services.documents.put(
        CHAT,
        "module_pool",
        MODULE_POOL_ID,
        {
            "keeper": {"truths": [POOL_SENTINEL], "timeline": ["night three: the drowning"]},
            "player": {"hooks": ["The festival needs one more guest."]},
        },
    )
    # 2. keeper-only tracker beside a player-visible one
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "true_culprit", "kind": "text", "labels": {"en": MODVAR_SENTINEL}, "visibility": "keeper", "default": MODVAR_SENTINEL},
    )
    await define_modvar(
        services.documents,
        CHAT,
        {"id": PLAYER_MODVAR_LABEL, "kind": "number", "labels": {"zh": PLAYER_MODVAR_LABEL}, "default": 1, "minimum": 1, "maximum": 3},
    )
    await set_modvar(services.documents, CHAT, "true_culprit", MODVAR_SENTINEL)
    # 3. an MVU tree with NOTHING exposed — every leaf is keeper-only until `.var expose`
    await save_mvu(services.documents, CHAT, {"内部": {"真凶": MVU_SENTINEL}})
    # 4. a secret lore entry
    await services.documents.put(
        CHAT, "lore", "wb_truth", {"title": "The truth", "content": f"{LORE_SENTINEL}: {POOL_SENTINEL}", "secret": True}
    )
    # 5. a keeper note
    await services.documents.put(CHAT, "note", "kp_1", {"text": NOTE_SENTINEL})
    return services, captured


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="tui:player", locale="zh")


async def test_director_context_never_carries_keeper_material(tmp_path) -> None:
    from agent.stage_director import run_director

    services, captured = await _seeded_services(tmp_path)
    services.settings.director.enabled = True

    await run_director(services, _ctx(), PLAYER_ACTION, PLAYER_LINE, beat="scene_change")

    assert captured, "the director must actually have been asked something"
    prompt = json.dumps(captured, ensure_ascii=False)

    for sentinel, mechanism in (
        (POOL_SENTINEL, "keeper knowledge pool"),
        (MODVAR_SENTINEL, "keeper-only tracker"),
        (MVU_SENTINEL, "un-exposed MVU leaf"),
        (LORE_SENTINEL, "secret lore entry"),
        (NOTE_SENTINEL, "keeper note"),
    ):
        assert sentinel not in prompt, f"the director's context leaked the {mechanism}"

    # Positive controls — without these the assertions above would be vacuous.
    assert PLAYER_LINE in prompt, "the director must see the narration it is staging"
    assert PLAYER_ACTION in prompt, "the director must see what the player did"
    assert PLAYER_MODVAR_LABEL in prompt, "player-visible trackers are legitimate context"


async def test_a_keeper_grade_projection_would_have_carried_them(tmp_path) -> None:
    """The control on the control: prove the sentinels ARE reachable keeper-side, so
    the test above is measuring isolation rather than an empty room."""
    services, _captured = await _seeded_services(tmp_path)

    pool = await services.documents.get_view(CHAT, "module_pool", MODULE_POOL_ID, KEEPER_VIEWER)
    assert POOL_SENTINEL in json.dumps(pool, ensure_ascii=False)


def test_the_director_module_never_names_a_keeper_surface() -> None:
    """A behavioural test only covers the paths it walks. This covers the FILE: the
    Director may not import the keeper viewer, the keeper pool id, or the keeper note
    type — the moment it can ask for keeper-grade data, isolation stops being
    structural and becomes a habit."""
    source = DIRECTOR_SOURCE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.update(f"{node.module}.{alias.name}" for alias in node.names)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    forbidden_imports = {"core.documents.KEEPER_VIEWER", "core.documents.MODULE_POOL_ID"}
    assert not (imported & forbidden_imports), f"agent/stage_director.py imports {sorted(imported & forbidden_imports)}"

    for token in ("KEEPER_VIEWER", "MODULE_POOL_ID", "keeper_pool", '"note"', "'note'"):
        assert token not in source, f"agent/stage_director.py names the keeper surface {token!r}"

    # And it must positively use the player projection — "names no keeper symbol"
    # would also be true of a module that reads nothing at all.
    assert "PLAYER_VIEWER" in source, "the director must read state through the PLAYER projection"
