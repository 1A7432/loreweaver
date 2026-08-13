"""Ownership sentinels for sheet documents (audit finding F01).

M17 moved character sheets into the room-wide `documents` table keyed by the
character NAME, with `data.owner` recording the controlling uid. The name is
therefore the identity: without an owner check ANY member could overwrite or
delete ANY other member's sheet by naming it (`.rename` / `.nn`, the
`delete_character` KP tool), and two players typing the bare make-char word
would collide on the pack's default name with no attacker at all.

Every test here asserts the HAZARD never crosses the boundary — the victim's
stored document survives byte-identical — and pairs it with a POSITIVE CONTROL
so the sentinel cannot pass vacuously: owners must still be able to rename,
delete and (the common path — every stat edit re-saves) overwrite their own
sheets.
"""

from __future__ import annotations

import json

import pytest

from agent.context import AgentCtx
from agent.kp_tools_mechanics import CharacterTools
from agent.services import build_services
from core.character_manager import (
    CharacterManager,
    CharacterNameTakenError,
    CharacterSheet,
)
from core.documents import DocumentStore
from core.pregen_roster import pregen_add, pregen_claim, pregen_release
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.llm import FakeLLM
from infra.store import Store

pytestmark = pytest.mark.asyncio


def _services():
    return build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


async def _snapshot(manager: CharacterManager, chat_key: str, name: str) -> str:
    """A stable serialization of the stored sheet document (data + meta)."""
    doc = await manager.documents.get(chat_key, "sheet", name)
    assert doc is not None, f"sheet document {name!r} vanished"
    return json.dumps(
        {"data": doc.data, "meta": doc.meta}, sort_keys=True, ensure_ascii=False
    )


def _veteran(name: str = "Alice") -> CharacterSheet:
    sheet = CharacterSheet(name, "CoC")
    sheet.attributes["STR"] = 65
    sheet.notes = "twenty sessions of notes"
    return sheet


async def test_cross_owner_save_is_refused_and_the_victim_sheet_survives():
    store = Store(":memory:")
    manager = CharacterManager(store)
    chat = "tui:group:arkham"

    await manager.save_character("uidA", chat, _veteran())
    before = await _snapshot(manager, chat, "Alice")

    intruder = CharacterSheet("Alice", "CoC")
    with pytest.raises(CharacterNameTakenError):
        await manager.save_character("uidB", chat, intruder)

    # HAZARD: A's stored sheet must be untouched, down to the bytes.
    assert await _snapshot(manager, chat, "Alice") == before
    assert [entry["name"] for entry in await manager.list_characters("uidA", chat)] == ["Alice"]
    assert await manager.list_characters("uidB", chat) == []
    # The refused write also never re-pointed B's active-character slot at A's sheet.
    assert await store.state_get(chat, "active_character.uidB") is None

    # POSITIVE CONTROL: the owner re-saving the SAME name is the common path
    # (`save_character` runs on every stat edit) and must still work.
    played = await manager.get_character("uidA", chat, "Alice")
    played.attributes["STR"] = 70
    await manager.save_character("uidA", chat, played)
    assert (await manager.get_character("uidA", chat, "Alice")).attributes["STR"] == 70
    assert await store.state_get(chat, "active_character.uidA") == "Alice"


async def test_cross_owner_delete_is_refused_and_owner_delete_still_works():
    store = Store(":memory:")
    manager = CharacterManager(store)
    chat = "tui:group:arkham"

    await manager.save_character("uidA", chat, _veteran())
    before = await _snapshot(manager, chat, "Alice")

    # HAZARD: someone else's delete is a no-op.
    assert await manager.delete_character("uidB", chat, "Alice") is False
    assert await _snapshot(manager, chat, "Alice") == before
    assert [member["name"] for member in await manager.get_party_roster(chat)] == ["Alice"]

    # POSITIVE CONTROL: the owner can still delete their own sheet.
    assert await manager.delete_character("uidA", chat, "Alice") is True
    assert await manager.documents.get(chat, "sheet", "Alice") is None
    assert await manager.get_party_roster(chat) == []


async def test_rename_onto_another_players_character_is_refused():
    services = _services()
    router = CommandRouter(services)
    chat = "cli:dm:rename-ownership"
    i18n = get_i18n("en")

    await services.characters.save_character("uidA", chat, _veteran())
    before = await _snapshot(services.characters, chat, "Alice")

    ctx_b = AgentCtx(chat_key=chat, user_id="uidB", locale="en")
    await services.characters.save_character("uidB", chat, CharacterSheet("Bob", "CoC"))

    reply = await router.dispatch(ctx_b, ".nn Alice")

    assert reply == i18n.t("commands.rename.name_taken", name="Alice")
    # HAZARD: A's sheet survives byte-identical, and B did not acquire it.
    assert await _snapshot(services.characters, chat, "Alice") == before
    assert [entry["name"] for entry in await services.characters.list_characters("uidA", chat)] == ["Alice"]
    assert [entry["name"] for entry in await services.characters.list_characters("uidB", chat)] == ["Bob"]

    # POSITIVE CONTROL: renaming your OWN sheet to a free name still works.
    ok = await router.dispatch(ctx_b, ".nn Bobby")
    assert ok == i18n.t("commands.rename.changed", old="Bob", new="Bobby")
    assert [entry["name"] for entry in await services.characters.list_characters("uidB", chat)] == ["Bobby"]


async def test_two_players_bare_make_char_word_do_not_collide_on_the_default_name():
    services = _services()
    router = CommandRouter(services)
    chat = "cli:dm:default-name-collision"
    i18n = get_i18n("en")
    default_name = i18n.t("commands.character.default_name")

    ctx_a = AgentCtx(chat_key=chat, user_id="uidA", locale="en")
    ctx_b = AgentCtx(chat_key=chat, user_id="uidB", locale="en")

    first = await router.dispatch(ctx_a, ".coc")
    assert first is not None and default_name in first
    before = await _snapshot(services.characters, chat, default_name)

    second = await router.dispatch(ctx_b, ".coc")

    # HAZARD: the second bare make-char must not destroy the first player's sheet.
    assert second == i18n.t("commands.character.name_taken", name=default_name, command="coc")
    assert await _snapshot(services.characters, chat, default_name) == before
    assert [entry["name"] for entry in await services.characters.list_characters("uidA", chat)] == [default_name]
    assert await services.characters.list_characters("uidB", chat) == []

    # POSITIVE CONTROL: B naming their character explicitly still works.
    named = await router.dispatch(ctx_b, ".coc Beatrice")
    assert named is not None and "Beatrice" in named
    assert [entry["name"] for entry in await services.characters.list_characters("uidB", chat)] == ["Beatrice"]


async def test_kp_delete_character_tool_refuses_another_players_sheet():
    services = _services()
    tools = CharacterTools(services)
    chat = "cli:dm:kp-delete-ownership"
    i18n = services.i18n.with_locale("en")

    await services.characters.save_character("uidA", chat, _veteran())
    before = await _snapshot(services.characters, chat, "Alice")

    ctx_b = AgentCtx(chat_key=chat, user_id="uidB", locale="en")
    await tools.create_character(ctx_b, name="Bob", system="coc7", auto_generate=False)

    refused = await tools.delete_character(ctx_b, name="Alice")

    # HAZARD: the model cannot delete a sheet the acting player does not own.
    assert refused == i18n.t("kp_tools.character.delete.not_yours", name="Alice")
    assert await _snapshot(services.characters, chat, "Alice") == before

    # POSITIVE CONTROL: deleting your OWN character still works.
    deleted = await tools.delete_character(ctx_b, name="Bob")
    assert deleted == i18n.t("kp_tools.character.delete.success", name="Bob")
    assert await services.characters.documents.get(chat, "sheet", "Bob") is None


async def test_pregen_claim_and_release_still_work_across_players():
    """POSITIVE CONTROL for the one legitimate cross-uid lifecycle: a pregen
    claim materializes a copy under the claimer, and a release deletes it so the
    next player can claim the same NAME."""
    store = Store(":memory:")
    characters = CharacterManager(store)
    documents = DocumentStore(store)
    chat = "room-cast"

    await pregen_add(documents, chat, CharacterSheet("Carol", "CoC"), source="card:module")

    assert (await pregen_claim(documents, chat, "Carol", "p1", characters))[0] == "ok"
    assert (await characters.get_character("p1", chat)).name == "Carol"

    assert await pregen_release(documents, chat, "Carol", "p1", characters) == "ok"
    assert await characters.documents.get(chat, "sheet", "Carol") is None

    assert (await pregen_claim(documents, chat, "Carol", "p2", characters))[0] == "ok"
    assert [entry["name"] for entry in await characters.list_characters("p2", chat)] == ["Carol"]


async def test_pregen_claim_colliding_with_another_players_own_sheet_reports_cleanly():
    """A module's cast member may share a name with a sheet some player created
    independently. The ownership check rightly refuses the overwrite (the claim
    materializes a copy under the claimer, but the room-wide NAME is the identity and
    it is taken) — and the refusal must come back as a status like every other claim
    outcome, not as an exception the command lane degrades into a bare server error."""
    store = Store(":memory:")
    characters = CharacterManager(store)
    documents = DocumentStore(store)
    chat = "room-name-clash"

    await characters.save_character("p1", chat, CharacterSheet("Carol", "CoC"))
    await pregen_add(documents, chat, CharacterSheet("Carol", "CoC"), source="card:module")

    status, sheet = await pregen_claim(documents, chat, "Carol", "p2", characters)

    assert (status, sheet) == ("name_conflict", None)
    # The victim's own sheet is untouched, and nothing was claimed on the roster.
    assert (await characters.get_character("p1", chat)).name == "Carol"


async def test_pc_claim_name_conflict_returns_the_localized_notice():
    """End to end through the command lane: the player who typed `.pc claim` gets the
    actionable localized message, not the generic server-error every transport falls
    back to for an uncaught exception."""
    services = build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    chat = "room-name-clash-cmd"
    await services.characters.save_character("p1", chat, CharacterSheet("Carol", "CoC"))
    await pregen_add(services.documents, chat, CharacterSheet("Carol", "CoC"), source="card:module")
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key=chat, user_id="p2", platform="cli", locale="en")

    reply = await router.dispatch_reply(ctx, ".pc claim Carol")

    assert reply.text == get_i18n("en").t("pregen.commands.claim_name_conflict", name="Carol")
