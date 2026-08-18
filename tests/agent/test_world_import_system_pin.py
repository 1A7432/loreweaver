"""World-import system pin (owner verdict 2026-08-17, module-rulepack-activation):

a keeper's `.import … world` of a card that lives in an installed pack shipping
exactly ONE rulepack pins that system as the room's default — the module's cast
and later `.genchar` land on the system the author shipped, not whatever the
room happened to be running. An explicit `system` argument wins; two bundled
rulepacks is an ambiguity the pin refuses to guess about.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import core.rulepacks as rulepacks_module
from agent.context import AgentCtx, LocalFs
from agent.kp_tools_charcard import CharcardTools
from agent.kp_tools_subsystems import room_rulepack
from agent.services import build_services
from core.pregen_roster import pregen_entries
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

RULEPACK_YAML = "names: [harbour-tides]\ndefaults:\n  力量: 40\n  潮汐学: 25\n"
# A second bundled system: the module's REAL character system, the one that declares a
# make-character word of its own — beside it `harbour-tides` reads as a subsystem patch.
CREATOR_YAML = "names: [harbour-crew]\ndefaults:\n  力量: 40\ncommands:\n  crew: {action: make_char}\n"

CARD = {
    "name": "Harbour Pilot",
    "personality": "Weathered, patient, tide-wise.",
    "description": "Knows every shoal in the reach.",
}


@pytest.fixture
def user_rulepack_dir(tmp_path):
    original = rulepacks_module._USER_RULEPACK_DIR
    directory = tmp_path / "user-rulepacks"
    directory.mkdir()
    (directory / "harbour-tides.yaml").write_text(RULEPACK_YAML, encoding="utf-8")
    (directory / "harbour-crew.yaml").write_text(CREATOR_YAML, encoding="utf-8")
    (directory / "harbour-crew-too.yaml").write_text(
        CREATOR_YAML.replace("harbour-crew", "harbour-crew-too").replace("crew:", "crewtoo:"), encoding="utf-8"
    )
    rulepacks_module._USER_RULEPACK_DIR = directory
    rulepacks_module._discover_registry.cache_clear()
    rulepacks_module._alias_resolver.cache_clear()
    try:
        yield directory
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original
        rulepacks_module._discover_registry.cache_clear()
        rulepacks_module._alias_resolver.cache_clear()


def _install_world_card(data_dir: Path, *, rulepacks: list[str]) -> str:
    home = data_dir / "packs" / "harbour@1.0.0"
    (home / "cards").mkdir(parents=True)
    (home / "cards" / "world.json").write_text(json.dumps(CARD, ensure_ascii=False), encoding="utf-8")
    manifest_lines = [
        "manifest: 2",
        "id: harbour",
        "name: Harbour",
        'version: "1.0.0"',
        "contents:",
        "  cards: [cards/world.json]",
    ]
    if rulepacks:
        manifest_lines.append(f"  rulepacks: [{', '.join(rulepacks)}]")
    (home / "pack.yaml").write_text("\n".join(manifest_lines) + "\n", encoding="utf-8")
    return str(home / "cards" / "world.json")


def _services(tmp_path):
    return build_services(
        Settings(data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(16)
    )


def _keeper_ctx(tmp_path, chat_key: str) -> AgentCtx:
    return AgentCtx(
        chat_key=chat_key,
        user_id="k1",
        platform="cli",
        locale="en",
        fs=LocalFs(str(tmp_path), extra_bases=(str(tmp_path / "data"),)),
    )


async def test_sole_rulepack_pack_pins_the_room_system(tmp_path, user_rulepack_dir):
    services = _services(tmp_path)
    card_path = _install_world_card(tmp_path / "data", rulepacks=["rulepacks/harbour-tides.yaml"])
    ctx = _keeper_ctx(tmp_path, "pin-room")

    reply = await CharcardTools(services).import_world_card(ctx, file_path=card_path)

    assert "harbour-tides" in reply  # the pinned-system notice names the system
    assert await services.store.state_get("pin-room", "room_system") == "harbour-tides"
    roster = await pregen_entries(services.documents, "pin-room")
    assert roster and roster[0]["system"] == "harbour-tides"
    # No character claimed yet: the room's rulepack now follows the pin.
    pack = await room_rulepack(services, ctx)
    assert pack.system == "harbour-tides"


async def test_two_bundled_rulepacks_do_not_pin(tmp_path, user_rulepack_dir):
    """Two declared, one of them not discoverable: undecidable — no pin."""
    services = _services(tmp_path)
    card_path = _install_world_card(
        tmp_path / "data", rulepacks=["rulepacks/harbour-tides.yaml", "rulepacks/other.yaml"]
    )
    ctx = _keeper_ctx(tmp_path, "ambiguous-room")

    await CharcardTools(services).import_world_card(ctx, file_path=card_path)

    assert await services.store.state_get("ambiguous-room", "room_system") is None


async def test_among_several_rulepacks_the_one_that_creates_characters_is_the_pin(tmp_path, user_rulepack_dir):
    """Owner suggestion 2026-08-18: a module commonly ships its real system beside a
    subsystem-only patch (a hazard table, a wager mechanic). When exactly one bundled
    rulepack declares a make-character word of its own, that is the pack's character
    system — pinned on world import, so `.genchar` and every click-import land on it."""
    services = _services(tmp_path)
    card_path = _install_world_card(
        tmp_path / "data", rulepacks=["rulepacks/harbour-tides.yaml", "rulepacks/harbour-crew.yaml"]
    )
    ctx = _keeper_ctx(tmp_path, "crew-room")

    reply = await CharcardTools(services).import_world_card(ctx, file_path=card_path)

    assert "harbour-crew" in reply
    assert await services.store.state_get("crew-room", "room_system") == "harbour-crew"
    assert (await room_rulepack(services, ctx)).system == "harbour-crew"


async def test_two_character_systems_in_one_pack_stay_ambiguous(tmp_path, user_rulepack_dir):
    services = _services(tmp_path)
    card_path = _install_world_card(
        tmp_path / "data", rulepacks=["rulepacks/harbour-crew.yaml", "rulepacks/harbour-crew-too.yaml"]
    )
    ctx = _keeper_ctx(tmp_path, "two-crews-room")

    await CharcardTools(services).import_world_card(ctx, file_path=card_path)

    assert await services.store.state_get("two-crews-room", "room_system") is None


async def test_a_pack_s_character_card_imports_into_the_pack_s_character_system(tmp_path, user_rulepack_dir):
    """The click path (`.import <ref> pc`, no system named): a card that ships in a pack
    with a character system is built on THAT — even before any world import pinned the
    room — rather than on whatever the room happened to be running."""
    services = _services(tmp_path)
    card_path = _install_world_card(
        tmp_path / "data", rulepacks=["rulepacks/harbour-tides.yaml", "rulepacks/harbour-crew.yaml"]
    )
    ctx = _keeper_ctx(tmp_path, "click-room")

    await CharcardTools(services).import_character(ctx, file_path=card_path, as_="pc")

    sheet = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    assert sheet.system == "harbour-crew"
    # …and it did NOT pin the room: that stays the keeper's world import's job.
    assert await services.store.state_get("click-room", "room_system") is None


async def test_explicit_system_argument_wins_and_does_not_pin(tmp_path, user_rulepack_dir):
    services = _services(tmp_path)
    card_path = _install_world_card(tmp_path / "data", rulepacks=["rulepacks/harbour-tides.yaml"])
    ctx = _keeper_ctx(tmp_path, "explicit-room")

    await CharcardTools(services).import_world_card(ctx, file_path=card_path, system="coc7")

    assert await services.store.state_get("explicit-room", "room_system") is None
    roster = await pregen_entries(services.documents, "explicit-room")
    assert roster and roster[0]["system"] == "coc7"


async def test_a_failed_import_never_pins(tmp_path, user_rulepack_dir):
    """The pin lands only AFTER the import succeeds: a corrupt card must not leave
    the room retargeted onto a module that never landed (`.genchar` would follow
    a ghost)."""
    services = _services(tmp_path)
    card_path = _install_world_card(tmp_path / "data", rulepacks=["rulepacks/harbour-tides.yaml"])
    Path(card_path).write_text("{not json", encoding="utf-8")
    ctx = _keeper_ctx(tmp_path, "corrupt-room")

    reply = await CharcardTools(services).import_world_card(ctx, file_path=card_path)

    assert "harbour-tides" not in reply  # no pinned notice on a failed import
    assert await services.store.state_get("corrupt-room", "room_system") is None


async def test_undiscoverable_sole_rulepack_never_pins_a_dead_id(tmp_path):
    """The pack declares one rulepack but discovery cannot load it (not installed):
    pinning would strand the room on a system nothing can build."""
    services = _services(tmp_path)
    card_path = _install_world_card(tmp_path / "data", rulepacks=["rulepacks/ghost-system.yaml"])
    ctx = _keeper_ctx(tmp_path, "ghost-room")

    await CharcardTools(services).import_world_card(ctx, file_path=card_path)

    assert await services.store.state_get("ghost-room", "room_system") is None
