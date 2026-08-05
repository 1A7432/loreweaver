"""Native-bundle (`*.lorecard.json`, M14) import through the real `.import` tool paths:
the world import lands typed variable specs / secret lore / the pregen cast, and the
player path structurally strips all of that machinery (拆卡, iron rule #3)."""

from __future__ import annotations

import json

from agent.context import AgentCtx, LocalFs
from agent.kp_tools_charcard import CharcardTools
from agent.services import build_services
from core.modvars import ModvarManager
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

_CONCEPT = {
    "occupation": "Caretaker",
    "attribute_emphasis": ["INT", "POW"],
    "signature_skills": ["Spot Hidden"],
    "backstory": "Keeps the corridor building's ledgers.",
}


def _services():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text(json.dumps(_CONCEPT)))
    return build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))


def _bundle() -> dict:
    return {
        "format": "loreweaver.card",
        "format_version": 0,
        "name": "回廊公寓",
        "description": "A corridor building whose fifth floor exists only on rainy nights.",
        "personality": "",
        "scenario": "Find the missing tenant.",
        "first_mes": "Rain again.",
        "mes_example": "",
        "alternate_greetings": [],
        "creator_notes": "fixture",
        "tags": ["investigation"],
        "variables": [
            {
                "id": "suspicion",
                "kind": "number",
                "labels": {"en": "Suspicion", "zh": "怀疑度"},
                "default": 0,
                "minimum": 0,
                "maximum": 10,
                "visibility": "player",
            },
        ],
        "worldbook": [
            {
                "title": "五层的规则",
                "content": "五层只在雨夜出现。",
                "keys": ["五层", "雨夜"],
                "category": "lore",
                "secret": False,
                "constant": True,
                "priority": 10,
                "enabled": True,
                "condition": "",
                "secondary_keys": "",
                "selective_logic": "and_any",
                "probability": 100,
                "case_sensitive": False,
                "match_whole_words": False,
                "scan_depth": 4,
                "position": "after",
                "sticky": 0,
                "cooldown": 0,
                "delay": 0,
            },
            {
                "title": "管理员的秘密",
                "content": "管理员早已不是人类。",
                "keys": ["管理员"],
                "category": "lore",
                "secret": True,
                "constant": True,
                "priority": 10,
                "enabled": True,
                "condition": "",
                "secondary_keys": "",
                "selective_logic": "and_any",
                "probability": 100,
                "case_sensitive": False,
                "match_whole_words": False,
                "scan_depth": 4,
                "position": "after",
                "sticky": 0,
                "cooldown": 0,
                "delay": 0,
            },
        ],
        "extensions": {},
    }


def _write_bundle(tmp_path) -> LocalFs:
    (tmp_path / "corridor.lorecard.json").write_text(
        json.dumps(_bundle(), ensure_ascii=False), encoding="utf-8"
    )
    return LocalFs(str(tmp_path))


async def test_world_import_lands_specs_secret_lore_and_cast(tmp_path):
    services = _services()
    ctx = AgentCtx(chat_key="lorecard-world", user_id="keeper-1", locale="en", fs=_write_bundle(tmp_path))

    result = await CharcardTools(services).import_world_card(ctx, file_path="corridor.lorecard.json")

    assert "回廊公寓" in result
    # Typed specs became real modvar trackers (validated, clamped, player-visible).
    entries = await ModvarManager(services.store).player_entries("lorecard-world", "en")
    assert [entry["id"] for entry in entries] == ["suspicion"]
    assert entries[0] == {"id": "suspicion", "label": "Suspicion", "kind": "number", "value": 0, "min": 0, "max": 10}
    # Both lore entries landed; the secret one kept its keeper-only flag.
    lore = {entry.title: entry for entry in await services.worldbook.list("lorecard-world")}
    assert lore["五层的规则"].secret is False
    assert lore["管理员的秘密"].secret is True
    # The embedded persona joined the claimable pregen roster.
    from core.pregen_roster import PregenRoster

    roster = await PregenRoster(services.store).entries("lorecard-world")
    assert [entry["name"] for entry in roster] == ["回廊公寓"]


async def test_player_import_strips_native_bundle_machinery(tmp_path):
    services = _services()
    ctx = AgentCtx(chat_key="lorecard-pc", user_id="player-1", locale="en", fs=_write_bundle(tmp_path))

    result = await CharcardTools(services).import_character(
        ctx, file_path="corridor.lorecard.json", system="coc7", as_="pc"
    )

    assert result
    # No typed trackers land through a player import.
    assert await ModvarManager(services.store).player_entries("lorecard-pc", "en") == []
    # The persona's PUBLIC lore rides along (that is what a character's book is for);
    # the keeper-only entry is stripped by the split AND dropped by the import
    # chokepoint — its content must not exist anywhere in the player room, public
    # or otherwise (the pre-fix bug imported it with `secret` laundered to False).
    lore = await services.worldbook.list("lorecard-pc")
    assert [entry.title for entry in lore] == ["五层的规则"]
    assert all("管理员" not in entry.content for entry in lore)
