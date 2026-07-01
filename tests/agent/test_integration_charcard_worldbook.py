"""Integration tests for the M11 (worldbook) + M12 (charcard) wiring into the shared services,
toolset, prompt builder, and command surface.

Everything runs offline through the real `build_services` graph with FakeLLM/FakeEmbeddings, so
these exercise the ACTUAL wiring (Services.worldbook, build_kp_toolset, build_system_prompt) rather
than the leaf modules in isolation.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx, LocalFs
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_charcard import CharcardTools
from agent.kp_tools_worldbook import WorldbookTools
from agent.npc import NpcManager
from agent.prompt_builder import build_system_prompt
from agent.services import build_services
from core.worldbook import LoreEntry
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

_CONCEPT = {
    "occupation": "Professor",
    "attribute_emphasis": ["INT", "EDU"],
    "signature_skills": ["Library Use", "Occult"],
    "backstory": "A scholar chasing forbidden marginalia.",
}


def _concept_llm() -> FakeLLM:
    """A FakeLLM that always answers the persona->concept call with the same concept JSON."""
    return FakeLLM(responder=lambda messages, tools: assistant_text(json.dumps(_CONCEPT)))


def _services():
    return build_services(Settings(), llm=_concept_llm(), embeddings=FakeEmbeddings(64))


def _card_dict() -> dict:
    return {
        "name": "Ada",
        "description": "A scholar of forbidden lore",
        "personality": "curious, driven",
        "tags": ["scholar", "brave"],
        "character_book": {"entries": [{"keys": ["arkham"], "content": "Arkham is a cursed town."}]},
    }


def _write_card(tmp_path) -> LocalFs:
    (tmp_path / "ada.json").write_text(json.dumps(_card_dict()), encoding="utf-8")
    return LocalFs(str(tmp_path))


async def test_import_character_as_pc_saves_active_sheet(tmp_path):
    services = _services()
    fs = _write_card(tmp_path)
    ctx = AgentCtx(chat_key="chat-pc", user_id="player-1", locale="en", fs=fs)

    result = await CharcardTools(services).import_character(ctx, file_path="ada.json", system="coc7", as_="pc")

    assert "Ada" in result
    # The sheet is saved AND set active for the acting user -> get_character (active) round-trips.
    sheet = await services.characters.get_character("player-1", "chat-pc")
    assert sheet.name == "Ada"
    assert sheet.system == "CoC"
    assert sheet.occupation == "Professor"


async def test_import_character_as_companion_creates_record_sheet_and_lore(tmp_path):
    services = _services()
    fs = _write_card(tmp_path)
    ctx = AgentCtx(chat_key="chat-comp", user_id="player-1", locale="en", fs=fs)

    result = await CharcardTools(services).import_character(
        ctx, file_path="ada.json", system="coc7", as_="companion", name="Beric"
    )
    assert "Beric" in result

    # A player_companion record exists, with the card persona carried over.
    companions = await NpcManager(services.store).list_companions("chat-comp")
    assert len(companions) == 1
    companion = companions[0]
    assert companion.role == "player_companion"
    assert companion.is_pc is True
    assert "scholar" in companion.persona

    # Its sheet is saved under companion:{id} (active for that virtual user_key).
    sheet = await services.characters.get_character(f"companion:{companion.id}", "chat-comp")
    assert sheet.name == "Beric"
    assert sheet.system == "CoC"

    # The card's character_book was folded into the world lore, findable via query_lore.
    lore = await WorldbookTools(services).query_lore(
        AgentCtx(chat_key="chat-comp", user_id="kp", locale="en"), query="arkham"
    )
    assert "Arkham is a cursed town." in lore


async def test_worldbook_tools_through_built_toolset():
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-wb", user_id="kp", locale="en")

    # query_lore is a keeper-only tool; add_lore/list_lore are not.
    assert toolset.is_keeper_only("query_lore") is True
    assert toolset.is_keeper_only("add_lore") is False

    added = await toolset.dispatch(
        "add_lore",
        ctx,
        {"title": "Lighthouse", "content": "The lighthouse lens is cracked.", "keys": "lighthouse"},
    )
    assert "Lighthouse" in added

    listed = await toolset.dispatch("list_lore", ctx, {})
    assert "Lighthouse" in listed

    queried = await toolset.dispatch("query_lore", ctx, {"query": "lighthouse"})
    assert "The lighthouse lens is cracked." in queried


async def test_build_system_prompt_includes_keeper_secret_world_lore():
    services = _services()
    chat_key = "chat-prompt"
    sentinel = "SENTINEL_CULT_BENEATH_THE_LIGHTHOUSE"
    # constant=True so it is injected regardless of the (empty) recent context; secret=True is fine
    # for the KP system prompt (role="keeper").
    await services.worldbook.add(
        chat_key,
        LoreEntry(id="", title="Cult", content=f"{sentinel} — the cult meets at midnight.", secret=True, constant=True),
    )

    prompt = await build_system_prompt(AgentCtx(chat_key=chat_key, user_id="u1", locale="en"), services)

    i18n = services.i18n.with_locale("en")
    assert i18n.t("worldbook.section.title") in prompt
    assert sentinel in prompt
