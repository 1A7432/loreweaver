"""Tests for the keeper-gated admin surface over the WS wire (`net.admin`).

Like `tests/net/test_tui_server.py`, a real `TuiServer` is bound to an ephemeral
localhost port and driven by a real `websockets` client, so the v1.1 `admin_*`
frames are exercised end to end. The LLM is a `MutableLLM` wrapping an offline
`FakeLLM`, so `admin_set_model` genuinely hot-reconfigures (and the follow-up
`admin_config` reflects it) without any network — mirroring the `.model` tests.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent.services import build_services
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from infra.providers import MutableLLM
from net.keystore import Keystore
from net.room_backup import chat_key_for_room
from net.tui_server import TuiServer
from tests.net.test_tui_server import _connect_and_join, _recv, _start


def _services(data_dir: str = "./data"):
    """Baseline services with a real `MutableLLM` (offline stub inner client) so
    the admin set-model path reconfigures live, exactly like `.model set`."""
    settings = Settings(locale="en", data_dir=data_dir, llm=LLMSettings(provider="openai", chat_model="gpt-4o"))
    llm = MutableLLM(settings, builder=lambda s: FakeLLM(script=[]))
    return build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))


async def _send(ws, frame: dict) -> dict:
    await ws.send(json.dumps(frame))
    return await _recv(ws)


async def test_keeper_can_get_and_set_config_list_and_mint_keys():
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

        # get_config: describe() + provider catalog + no override yet.
        config = await _send(ws, {"type": "admin_get_config"})
        assert config["type"] == "admin_config"
        assert config["provider"] == "openai"
        assert config["chat_model"] == "gpt-4o"
        assert config["override_active"] is False
        assert "deepseek" in config["providers"] and "anthropic" in config["providers"]
        assert "gpt-subscription" in config["providers"] and "chatgpt" in config["providers"]
        assert "api_key_masked" in config

        # set_model: validated, persisted, and hot-applied to the live MutableLLM.
        updated = await _send(
            ws, {"type": "admin_set_model", "provider": "deepseek", "chat_model": "deepseek-chat"}
        )
        assert updated["type"] == "admin_config"
        assert updated["provider"] == "deepseek"
        assert updated["chat_model"] == "deepseek-chat"
        assert updated["override_active"] is True
        # live reconfigure mutated the shared settings, and it persisted.
        assert services.settings.llm.provider == "deepseek"
        assert await services.runtime_config.get() == {"provider": "deepseek", "chat_model": "deepseek-chat"}

        # an unknown provider is refused without mutating anything.
        bad = await _send(ws, {"type": "admin_set_model", "provider": "nope-9000"})
        assert bad["type"] == "admin_error"
        assert bad["code"] == "unknown_provider"
        assert bad["message"]
        assert services.settings.llm.provider == "deepseek"  # unchanged

        # list_keys masks every key value.
        listed = await _send(ws, {"type": "admin_list_keys"})
        assert listed["type"] == "admin_keys"
        assert len(listed["keys"]) == 1
        only = listed["keys"][0]
        assert only["room"] == "arkham" and only["role"] == "keeper"
        assert only["key_masked"] != keeper_key
        assert "..." in only["key_masked"]

        # mint_key returns the fresh key ONCE in cleartext + a refreshed masked list. Minting
        # stays deployment-global (the operator can seed any room); MUTATING a key is scoped
        # to the caller's own room (cross-room mutation is covered in its own test below).
        minted = await _send(
            ws, {"type": "admin_mint_key", "room": "arkham", "name": "Player One", "role": "player"}
        )
        assert minted["type"] == "admin_keys"
        assert minted["minted"]["room"] == "arkham"
        assert minted["minted"]["role"] == "player"
        new_key = minted["minted"]["key"]
        assert new_key and new_key != keeper_key
        # the new key really landed in the keystore, and the list now has both.
        assert keystore.get(new_key) is not None
        assert len(minted["keys"]) == 2
        assert all("..." in entry["key_masked"] or entry["key_masked"] == "" for entry in minted["keys"])
        assert all(entry.get("id") for entry in minted["keys"])

        # update + delete a key in the keeper's OWN room (arkham) — allowed.
        new_id = next(entry["id"] for entry in minted["keys"] if entry["name"] == "Player One")
        updated_key = await _send(
            ws, {"type": "admin_update_key", "id": new_id, "name": "Co-Keeper", "role": "keeper"}
        )
        assert updated_key["type"] == "admin_keys"
        changed = next(entry for entry in updated_key["keys"] if entry["id"] == new_id)
        assert changed["name"] == "Co-Keeper"
        assert changed["role"] == "keeper"
        assert keystore.get(new_key).role == "keeper"

        deleted_key = await _send(ws, {"type": "admin_delete_key", "id": new_id})
        assert deleted_key["type"] == "admin_keys"
        assert keystore.get(new_key) is None
        assert all(entry["id"] != new_id for entry in deleted_key["keys"])

        missing = await _send(ws, {"type": "admin_delete_key", "id": "missing"})
        assert missing["type"] == "admin_error"
        assert missing["code"] == "not_found"

        await ws.close()
    finally:
        await server.close()


async def test_player_role_connection_is_refused_every_admin_action():
    services = _services()
    keystore = Keystore()
    player_key = keystore.add(room="arkham", name="Player", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, player_key, "Player")

        for request in (
            {"type": "admin_get_config"},
            {"type": "admin_set_model", "provider": "deepseek"},
            {"type": "admin_list_keys"},
            {"type": "admin_mint_key", "room": "secret", "role": "keeper"},
            {"type": "admin_update_key", "id": "anything", "role": "keeper"},
            {"type": "admin_delete_key", "id": "anything"},
            {"type": "admin_delete_room", "room": "arkham"},
            {"type": "admin_export_room", "room": "arkham"},
            {"type": "admin_import_room", "path": "backup.json"},
            {"type": "admin_delete_room_data", "room": "arkham"},
        ):
            reply = await _send(ws, request)
            assert reply["type"] == "admin_error"
            assert reply["code"] == "forbidden"
            assert reply["message"]

        # nothing leaked or mutated: no override persisted, no key minted.
        assert services.settings.llm.provider == "openai"
        assert await services.runtime_config.get() == {}
        assert len(keystore) == 1

        await ws.close()
    finally:
        await server.close()


async def test_admin_set_model_rolls_back_and_persists_nothing_when_the_provider_fails_to_build():
    """F2: like `.model set`, `admin_set_model` reconfigures the live LLM BEFORE
    persisting. A provider whose build fails leaves the old config active, persists
    nothing, and returns a localized `set_failed` error instead of crashing."""
    from infra.i18n import get_i18n
    from net.admin import handle_admin_frame

    def _raising_builder(settings):
        if (settings.llm.provider or "").lower() == "anthropic":
            raise ValueError("anthropic SDK missing")
        return FakeLLM(script=[])

    settings = Settings(locale="en", llm=LLMSettings(provider="openai", chat_model="gpt-4o"))
    llm = MutableLLM(settings, builder=_raising_builder)
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))

    reply = await handle_admin_frame(
        services,
        Keystore(),
        "keeper",
        "",  # caller_room — irrelevant for the non-room-scoped set_model op
        {"type": "admin_set_model", "provider": "anthropic"},
        get_i18n("en"),
    )

    assert reply["type"] == "admin_error"
    assert reply["code"] == "set_failed"
    assert services.settings.llm.provider == "openai"  # unchanged
    assert await services.runtime_config.get() == {}  # not persisted
    assert isinstance(services.llm.inner, FakeLLM)  # live LLM rolled back


async def test_keeper_can_export_delete_and_import_room_data(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    player_key = keystore.add(room="arkham", name="Ada", role="player")
    other_key = keystore.add(room="dunwich", name="Other", role="player")

    chat_key = chat_key_for_room("arkham")
    await services.store.set(user_key="", store_key=f"chat_history.{chat_key}", value='[{"role":"user"}]')
    await services.store.set(user_key="player-1", store_key=f"active_character.{chat_key}", value="Ada")
    await services.store.set(user_key="player-1", store_key=f"characters_list.{chat_key}", value='["Ada"]')
    await services.store.set(user_key="player-1", store_key=f"characters.{chat_key}.Ada", value='{"name":"Ada"}')
    await services.store.set(user_key="", store_key=f"npc_list.{chat_key}", value='["n1"]')
    await services.store.set(user_key="", store_key=f"npc.{chat_key}.n1", value='{"name":"Dr. West"}')
    await services.store.set(user_key="", store_key=f"worldbook_index.{chat_key}", value='["l1"]')
    await services.store.set(user_key="", store_key=f"worldbook.{chat_key}.l1", value='{"title":"Kingsport"}')
    await services.store.set(user_key="", store_key="bound_room.discord:group:table", value=chat_key)
    await services.store.set(user_key="", store_key="chat_history.tui:group:dunwich", value="keep")
    await services.vector_db.vector_store.upsert(
        [
            ("doc-1:0", [0.1] * 64, {"chat_key": chat_key, "document_id": "doc-1", "chunk_index": 0}),
            (
                f"{chat_key}:l1",
                [0.2] * 64,
                {"collection": "worldbook", "namespace": chat_key, "entry_id": "l1"},
            ),
        ]
    )

    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

        # Export writes a snapshot; a client-supplied `path` is CONFINED to data_dir/room_backups
        # (only the filename is honored — never an arbitrary-location write). The traversal guard
        # itself is covered by test_admin_export_confines_the_path_to_the_backups_directory.
        backups = str((Path(services.settings.data_dir) / "room_backups").resolve())
        exported = await _send(ws, {"type": "admin_export_room", "room": "arkham", "path": "arkham-export.json"})
        assert exported["type"] == "admin_room_op"
        assert exported["action"] == "export"
        assert exported["room"] == "arkham"
        assert exported["path"].startswith(backups) and exported["path"].endswith("arkham-export.json")
        assert exported["keys"] == 2
        assert exported["store_rows"] == 9
        assert exported["vector_points"] == 2
        snapshot = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
        assert {item["key"] for item in snapshot["keys"]} == {keeper_key, player_key}

        deleted = await _send(
            ws,
            {"type": "admin_delete_room_data", "room": "arkham", "backup": True, "path": "arkham-delete-backup.json"},
        )
        assert deleted["type"] == "admin_room_op"
        assert deleted["action"] == "delete"
        assert deleted["path"].startswith(backups) and deleted["path"].endswith("arkham-delete-backup.json")
        assert deleted["keys"] == 2
        assert deleted["store_rows"] == 9
        assert deleted["vector_points"] == 2
        assert Path(deleted["path"]).is_file()
        assert keystore.get(keeper_key) is None
        assert keystore.get(player_key) is None
        assert keystore.get(other_key) is not None  # a DIFFERENT room's key is untouched
        assert await services.store.get(user_key="", store_key=f"chat_history.{chat_key}") is None
        assert await services.store.get(user_key="player-1", store_key=f"active_character.{chat_key}") is None
        assert await services.store.get(user_key="player-1", store_key=f"characters_list.{chat_key}") is None
        assert await services.store.get(user_key="player-1", store_key=f"characters.{chat_key}.Ada") is None
        assert await services.store.get(user_key="", store_key=f"npc.{chat_key}.n1") is None
        assert await services.store.get(user_key="", store_key="bound_room.discord:group:table") is None
        assert await services.store.get(user_key="", store_key="chat_history.tui:group:dunwich") == "keep"
        assert await services.vector_db.vector_store.count(filter={"chat_key": chat_key}) == 0
        assert await services.vector_db.vector_store.count(filter={"collection": "worldbook", "namespace": chat_key}) == 0

        # Restore the keeper's OWN room from its backup (same-room; the file is named, not pathed).
        # Importing INTO another room is forbidden — see test_admin_room_ops_are_scoped_to_the_callers_room.
        imported = await _send(ws, {"type": "admin_import_room", "path": Path(deleted["path"]).name})
        assert imported["type"] == "admin_room_op"
        assert imported["action"] == "import"
        assert imported["room"] == "arkham"
        assert imported["keys"] == 2
        assert imported["store_rows"] == 9
        assert imported["vector_points"] == 2
        assert keystore.get(keeper_key).room == "arkham"
        assert keystore.get(player_key).room == "arkham"
        assert await services.store.get(user_key="", store_key=f"chat_history.{chat_key}") == '[{"role":"user"}]'
        assert await services.store.get(user_key="player-1", store_key=f"active_character.{chat_key}") == "Ada"
        assert await services.store.get(user_key="player-1", store_key=f"characters_list.{chat_key}") == '["Ada"]'
        assert await services.store.get(user_key="player-1", store_key=f"characters.{chat_key}.Ada") == '{"name":"Ada"}'
        assert await services.store.get(user_key="", store_key=f"npc.{chat_key}.n1") == '{"name":"Dr. West"}'
        assert await services.store.get(user_key="", store_key="bound_room.discord:group:table") == chat_key
        assert await services.vector_db.vector_store.count(filter={"chat_key": chat_key}) == 1
        assert await services.vector_db.vector_store.count(filter={"collection": "worldbook", "namespace": chat_key}) == 1

        await ws.close()
    finally:
        await server.close()


async def test_admin_room_ops_are_scoped_to_the_callers_room():
    """Security: a keeper key bound to room A cannot mutate/export/wipe/import room B — only its
    own room. (Minting/listing stay deployment-global; the destructive/room-content ops scope.)"""
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")  # caller is bound to arkham
    victim_key = keystore.add(room="dunwich", name="Other Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        victim_id = next(
            e["id"] for e in (await _send(ws, {"type": "admin_list_keys"}))["keys"] if e["room"] == "dunwich"
        )
        for request in (
            {"type": "admin_update_key", "id": victim_id, "role": "player"},
            {"type": "admin_delete_key", "id": victim_id},
            {"type": "admin_delete_room", "room": "dunwich"},
            {"type": "admin_export_room", "room": "dunwich"},
            {"type": "admin_delete_room_data", "room": "dunwich"},
            {"type": "admin_import_room", "path": "x.json", "room": "dunwich"},
        ):
            reply = await _send(ws, request)
            assert reply["type"] == "admin_error", request
            assert reply["code"] == "forbidden", request
        # The other room's key was never touched.
        assert keystore.get(victim_key) is not None
        assert keystore.get(victim_key).role == "keeper"
        assert keystore.get(victim_key).room == "dunwich"

        await ws.close()
    finally:
        await server.close()


async def test_admin_export_confines_the_path_to_the_backups_directory(tmp_path):
    """Security: a client-supplied export `path` cannot escape data_dir/room_backups — an
    absolute/traversal path is reduced to a bare filename inside the backups directory."""
    services = _services(str(tmp_path))
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    await services.store.set(user_key="", store_key=f"chat_history.{chat_key_for_room('arkham')}", value="[]")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        exported = await _send(
            ws, {"type": "admin_export_room", "room": "arkham", "path": "/etc/loreweaver-evil.json"}
        )
        assert exported["type"] == "admin_room_op"
        base = str((Path(services.settings.data_dir) / "room_backups").resolve())
        assert exported["path"].startswith(base)  # confined under the backups dir
        assert exported["path"].endswith("loreweaver-evil.json")  # only the filename survived
        assert not Path("/etc/loreweaver-evil.json").exists()  # nothing written outside

        await ws.close()
    finally:
        await server.close()
