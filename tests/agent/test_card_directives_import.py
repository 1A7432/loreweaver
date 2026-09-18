"""The world-card directives fold through the real import tools and the prompt builder:
a keeper world import folds the card's `system_prompt` / `post_history_instructions` on
the preset's two bands; a PC or companion import of the SAME card strips them and says
so; a room with no world import never sees the header."""

from __future__ import annotations

import json

from agent.context import AgentCtx, LocalFs
from agent.kp_tools_charcard import CharcardTools
from agent.prompt_builder import build_system_prompt_parts
from agent.services import build_services
from core.documents import KEEPER_VIEWER, PLAYER_VIEWER
from core.module_brief import BRIEF_DOC_TYPE, brief_id
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

_CONCEPT = {
    "occupation": "Caretaker",
    "attribute_emphasis": ["INT", "POW"],
    "signature_skills": ["Spot Hidden"],
    "backstory": "Keeps the corridor building's ledgers.",
}
HEAD = "Run {{char}} as a slow-burn mystery; never name the landlord. {{original}}"
POST = "[Keep replies short. The die says {{roll:1d1}}. <% setvar('x', 1) %>]"
HEADER_EN = "Imported world-card directives"


def _services():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text(json.dumps(_CONCEPT)))
    return build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))


def _card() -> dict:
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "Corridor",
            "description": "A corridor building.",
            "personality": "patient",
            "scenario": "Find the tenant.",
            "first_mes": "Rain again.",
            "system_prompt": HEAD,
            "post_history_instructions": POST,
            "tags": ["investigation"],
            "character_book": {"entries": []},
        },
    }


def _write_card(tmp_path) -> LocalFs:
    (tmp_path / "corridor.json").write_text(json.dumps(_card(), ensure_ascii=False), encoding="utf-8")
    return LocalFs(str(tmp_path))


async def test_world_import_folds_directives_on_the_preset_bands(tmp_path):
    services = _services()
    room = "directives-world"
    ctx = AgentCtx(chat_key=room, user_id="keeper-1", locale="en", fs=_write_card(tmp_path))
    tools = CharcardTools(services)

    result = await tools.import_world_card(ctx, file_path="corridor.json")
    assert "Author directives folded" in result

    view = await services.documents.get_view(room, BRIEF_DOC_TYPE, brief_id("Corridor"), KEEPER_VIEWER)
    assert view["directives_head"] == "Run Corridor as a slow-burn mystery; never name the landlord."
    assert "<%" not in view["directives_post"] and "{{roll:1d1}}" in view["directives_post"]
    assert await services.documents.get_view(room, BRIEF_DOC_TYPE, brief_id("Corridor"), PLAYER_VIEWER) is None

    parts = await build_system_prompt_parts(AgentCtx(chat_key=room, user_id="keeper-1", locale="en"), services)
    # Head band: stable head, verbatim (`{{char}}` was bound at import).
    assert "Run Corridor as a slow-burn mystery" in parts.stable
    assert "Run Corridor" not in parts.volatile
    # Post-history band: volatile tail, with the per-turn macro pass on real dice.
    assert "Keep replies short" in parts.volatile and "Keep replies short" not in parts.stable
    assert "The die says 1." in parts.volatile
    assert parts.stable.count(HEADER_EN) == 1 and parts.volatile.count(HEADER_EN) == 1

    # The module_brief tool shows the keeper what now rides the prompt.
    text = await tools.module_brief(ctx)
    assert "Author directives" in text and "slow-burn" in text


async def test_pc_and_companion_imports_strip_directives_and_say_so(tmp_path):
    services = _services()
    room = "directives-pc"
    fs = _write_card(tmp_path)
    tools = CharcardTools(services)

    pc = await tools.import_character(
        AgentCtx(chat_key=room, user_id="player-1", locale="en", fs=fs), file_path="corridor.json", as_="pc"
    )
    assert "2 author directive(s)" in pc
    companion = await tools.import_character(
        AgentCtx(chat_key=room, user_id="keeper-1", locale="en", fs=fs),
        file_path="corridor.json",
        as_="companion",
        name="Corridor Guide",
    )
    assert "2 author directive(s)" in companion

    assert await services.documents.list(room, BRIEF_DOC_TYPE) == []
    parts = await build_system_prompt_parts(AgentCtx(chat_key=room, user_id="keeper-1", locale="en"), services)
    whole = parts.stable + parts.volatile
    assert HEADER_EN not in whole and "slow-burn" not in whole and "Keep replies short" not in whole


async def test_a_free_room_never_gets_the_header():
    parts = await build_system_prompt_parts(AgentCtx(chat_key="free-room", user_id="keeper-1", locale="en"), _services())
    assert HEADER_EN not in parts.stable + parts.volatile


async def test_preview_names_the_directive_count(tmp_path):
    text = await CharcardTools(_services()).preview_card(
        AgentCtx(chat_key="preview", user_id="keeper-1", locale="en", fs=_write_card(tmp_path)),
        file_path="corridor.json",
    )
    assert "Author directives: 2" in text
