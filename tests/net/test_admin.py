"""Tests for the keeper-gated admin surface over the WS wire (`net.admin`).

Like `tests/net/test_tui_server.py`, a real `TuiServer` is bound to an ephemeral
localhost port and driven by a real `websockets` client, so the v1.1 `admin_*`
frames are exercised end to end. The LLM is a `MutableLLM` wrapping an offline
`FakeLLM`, so `admin_set_model` genuinely hot-reconfigures (and the follow-up
`admin_config` reflects it) without any network — mirroring the `.model` tests.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import agent.forge as forge_module
import core.rulepacks as rulepacks_module
import core.skills as skills_module
import net.keystore as keystore_module
import net.room_backup as room_backup_module
from agent.services import build_services
from gateway.hub import RoomHub
from gateway.ops import get_enabled_skills, set_enabled_skills
from gateway.rooms import (
    get_keeper_binding,
    resolve_session_key,
    session_key_for_room,
    set_keeper_binding,
)
from gateway.session import SessionSource
from infra.config import LLMSettings, Settings, TuiSettings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.imagegen import IMAGEGEN_PRESETS
from infra.llm import FakeLLM, assistant_text
from infra.media_store import ALLOWED_MEDIA_MIMES, MediaError, MediaStore
from infra.providers import PRESETS, MutableLLM
from net.admin import AdminService
from net.keystore import Keystore
from net.room_backup import (
    chat_key_for_room,
    delete_room_data,
    export_room,
    import_room,
    reset_room_state,
    room_rows,
    room_vector_points,
)
from net.tui_server import TuiServer
from tests.net.test_tui_server import _connect_and_join, _recv, _start

# A minimal valid SKILL.md the forge's skill generator can author (mirrors
# `tests/agent/test_forge.py`'s fixture); its name doesn't collide with any built-in skill id.
_VALID_SKILL_MD = """---
name: Grim Survival Horror
description: >
  Enable for a campaign about grinding, resource-scarce survival horror: supplies run out,
  wounds linger, and every choice costs something.
allowed-tools: []
metadata:
  scope: room
  content-rating: mature
---

# Grim survival horror

Track scarcity relentlessly: ammunition, food, and light sources are real, finite resources.
"""

# A minimal valid rulepack YAML (mirrors `tests/agent/test_forge_rulepack.py`'s fixture); its
# id/names don't collide with either built-in system (coc7/dnd5e).
_VALID_RULEPACK_YAML = """
names: [pulp-adventure, pulp]
set_keys: [pulp]
defaults:
  力量: 10
  意志: 10
alias:
  力量: [STR, strength]
derived:
  生命值上限:
    half_of: 意志
"""

_GENERATED_MODULE_MD = """# The Salt Marsh Vanishing

## Player-facing premise
Fisherfolk have gone missing near the marsh town of Greyreed.

## KEEPER-ONLY
The ferryman is the culprit, bound to an old pact.
"""


def _scripted_module_analysis_json() -> str:
    """A minimal well-formed module-analysis JSON — the shape `agent.forge`'s module generator's
    `upload_document(doc_type="module")` call triggers analysis for (mirrors
    `tests/agent/test_forge_module.py`'s fixture)."""
    return json.dumps(
        {
            "npcs": [
                {
                    "name": "The Ferryman",
                    "description": "A quiet old man.",
                    "secret": "He is the culprit.",
                    "role": "antagonist",
                }
            ],
            "summary": "Investigators uncover the truth behind the marsh disappearances.",
        }
    )


def _services(data_dir: str = "./data"):
    """Baseline services with a real `MutableLLM` (offline stub inner client) so
    the admin set-model path reconfigures live, exactly like `.model set`."""
    settings = Settings(locale="en", data_dir=data_dir, llm=LLMSettings(provider="openai", chat_model="gpt-4o"))
    llm = MutableLLM(settings, builder=lambda s: FakeLLM(script=[]))
    return build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))


async def _send(ws, frame: dict) -> dict:
    await ws.send(json.dumps(frame))
    return await _recv(ws)


def _update_services(command: str):
    settings = Settings(
        locale="en",
        llm=LLMSettings(provider="openai", chat_model="gpt-4o"),
        tui=TuiSettings(update_command=command),
    )
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


async def test_admin_update_server_not_configured_is_rejected():
    services = _update_services("")  # feature off
    reply = await AdminService(services, Keystore()).dispatch(
        "keeper", "arkham", {"type": "admin_update_server"}, get_i18n("en")
    )
    assert reply["type"] == "admin_error" and reply["code"] == "not_configured"


async def test_admin_update_server_requires_keeper():
    services = _update_services("echo hi")
    reply = await AdminService(services, Keystore()).dispatch(
        "player", "arkham", {"type": "admin_update_server"}, get_i18n("en")
    )
    assert reply["type"] == "admin_error" and reply["code"] == "forbidden"


async def test_admin_update_server_failed_command_reports_output_and_does_not_restart():
    services = _update_services("echo boom; exit 1")
    with patch("net.updater.schedule_reexec") as reexec:
        reply = await AdminService(services, Keystore()).dispatch(
            "keeper", "arkham", {"type": "admin_update_server"}, get_i18n("en")
        )
    assert reply["type"] == "admin_update"
    assert reply["status"] == "failed"
    assert "boom" in reply["output"]
    reexec.assert_not_called()


async def test_admin_update_server_success_reports_restarting_and_schedules_reexec():
    services = _update_services("echo done")
    with patch("net.updater.schedule_reexec") as reexec:
        reply = await AdminService(services, Keystore()).dispatch(
            "keeper", "arkham", {"type": "admin_update_server"}, get_i18n("en")
        )
    assert reply["type"] == "admin_update"
    assert reply["status"] == "restarting"
    reexec.assert_called_once()


def test_welcome_frame_carries_version_and_keeper_gated_update_feature():
    from net.session import welcome_frame

    fields = {"room": "r", "id": "i", "name": "n", "role": "keeper", "locale": "en"}
    base = welcome_frame(fields)
    assert base["version"]  # resolve_version() returns a non-empty string
    assert "update" not in base["features"]  # no update command configured
    assert "update" in welcome_frame(fields, can_update=True)["features"]


async def test_run_update_command_captures_success_and_failure():
    from net.updater import run_update_command

    ok = await run_update_command("echo hello")
    assert ok.ok and "hello" in ok.output
    bad = await run_update_command("echo oops; exit 2")
    assert not bad.ok and "oops" in bad.output


async def test_admin_service_mints_room_scoped_single_use_chat_bind_token():
    services = _services()
    keystore = Keystore()
    admin = AdminService(services, keystore)

    reply = await admin.dispatch(
        "keeper",
        "arkham",
        {"type": "admin_mint_key", "purpose": "chat_bind", "expires_in": 60},
        get_i18n("en"),
    )

    minted = reply["minted"]
    assert minted["room"] == "arkham"
    assert minted["role"] == "keeper"
    assert minted["purpose"] == "chat_bind"
    assert minted["expires_at"] is not None
    assert keystore.get(minted["key"]) is None
    assert keystore.get(minted["key"], purpose="chat_bind") is not None

    await set_keeper_binding(services.store, "discord", "keeper-7", "arkham")
    listed = await admin.dispatch(
        "keeper",
        "arkham",
        {"type": "admin_list_keys"},
        get_i18n("en"),
    )
    binding = next(item for item in listed["keys"] if item["id"].startswith("chat:"))
    assert binding["key_masked"] == "discord:keeper-7"

    await admin.dispatch(
        "keeper",
        "arkham",
        {"type": "admin_delete_key", "id": binding["id"]},
        get_i18n("en"),
    )
    assert await get_keeper_binding(services.store, "discord", "keeper-7") is None


async def test_keeper_can_get_and_set_config_list_and_mint_keys():
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    foreign_key = keystore.add(room="dunwich", name="Foreign Keeper", role="keeper")
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
        assert await services.runtime_config.get() == {
            "provider": "deepseek",
            "chat_model": "deepseek-chat",
            "api_key": "",
            "base_url": "",
        }

        # an unknown provider is refused without mutating anything.
        bad = await _send(ws, {"type": "admin_set_model", "provider": "nope-9000"})
        assert bad["type"] == "admin_error"
        assert bad["code"] == "unknown_provider"
        assert bad["message"]
        assert services.settings.llm.provider == "deepseek"  # unchanged

        # list_keys masks key values and exposes ONLY the caller's bound room.
        listed = await _send(ws, {"type": "admin_list_keys"})
        assert listed["type"] == "admin_keys"
        assert len(listed["keys"]) == 1
        only = listed["keys"][0]
        assert only["room"] == "arkham" and only["role"] == "keeper"
        assert only["key_masked"] != keeper_key
        assert "..." in only["key_masked"]
        assert foreign_key not in json.dumps(listed)

        # Minting into a different room is forbidden; omission selects caller_room.
        cross_room = await _send(
            ws, {"type": "admin_mint_key", "room": "dunwich", "name": "Intruder"}
        )
        assert cross_room["type"] == "admin_error"
        assert cross_room["code"] == "forbidden"

        # mint_key returns the fresh key ONCE in cleartext + a refreshed masked list.
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


async def test_key_mutation_rechecks_room_after_external_move(tmp_path):
    services = _services(str(tmp_path))
    key_path = tmp_path / "keys.toml"
    keystore = Keystore.load(key_path)
    with keystore.persisted_mutation():
        keystore.add(room="arkham", name="Keeper", role="keeper")
        victim = keystore.add(room="arkham", name="Player", role="player")
    admin = AdminService(services, keystore)

    listed = await admin.dispatch(
        "keeper",
        "arkham",
        {"type": "admin_list_keys"},
        get_i18n("en"),
    )
    victim_id = next(item["id"] for item in listed["keys"] if item["name"] == "Player")

    external = Keystore.load(key_path)
    with external.persisted_mutation():
        assert external.update(victim, room="dunwich")

    updated = await admin.dispatch(
        "keeper",
        "arkham",
        {"type": "admin_update_key", "id": victim_id, "name": "Hijacked"},
        get_i18n("en"),
    )
    deleted = await admin.dispatch(
        "keeper",
        "arkham",
        {"type": "admin_delete_key", "id": victim_id},
        get_i18n("en"),
    )

    assert updated["type"] == deleted["type"] == "admin_error"
    assert updated["code"] == deleted["code"] == "forbidden"
    persisted = Keystore.load(key_path).get(victim)
    assert persisted is not None
    assert persisted.room == "dunwich"
    assert persisted.name == "Player"


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
            {"type": "admin_reset_room", "room": "arkham"},
            {"type": "admin_list_skills"},
            {"type": "admin_enable_skill", "id": "mature-mode", "on": True},
            {"type": "admin_list_rules"},
            {"type": "admin_generate", "kind": "skill", "description": "anything"},
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


async def test_admin_set_model_leaves_state_unchanged_when_provider_build_fails():
    """A failed candidate build happens before live or persisted state changes."""
    def _raising_builder(settings):
        if (settings.llm.provider or "").lower() == "anthropic":
            raise ValueError("anthropic SDK missing")
        return FakeLLM(script=[])

    settings = Settings(locale="en", llm=LLMSettings(provider="openai", chat_model="gpt-4o"))
    llm = MutableLLM(settings, builder=_raising_builder)
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))

    reply = await AdminService(services, Keystore()).dispatch(
        "keeper",
        "",  # caller_room — irrelevant for the non-room-scoped set_model op
        {"type": "admin_set_model", "provider": "anthropic"},
        get_i18n("en"),
    )

    assert reply["type"] == "admin_error"
    assert reply["code"] == "set_failed"
    assert services.settings.llm.provider == "openai"  # unchanged
    assert await services.runtime_config.get() == {}  # not persisted
    assert isinstance(services.llm.inner, FakeLLM)


async def test_admin_set_model_rechecks_authorization_after_waiting_for_lock():
    services = _services()
    authorized = True
    await services.config_lock.acquire()
    task = asyncio.create_task(
        AdminService(services, Keystore()).dispatch(
            "keeper",
            "arkham",
            {"type": "admin_set_model", "provider": "deepseek"},
            get_i18n("en"),
            reauthorize=lambda: authorized,
        )
    )
    await asyncio.sleep(0)
    authorized = False
    services.config_lock.release()

    reply = await task

    assert reply["type"] == "admin_error"
    assert reply["code"] == "forbidden"
    assert services.settings.llm.provider == "openai"
    assert await services.runtime_config.get() == {}


async def test_revoking_chat_binding_evicts_live_direct_member() -> None:
    services = _services()
    hub = RoomHub()
    admin = AdminService(services, Keystore(), hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="dm",
        chat_id="dm-7",
        user_id="keeper-7",
    )

    class DirectMember:
        id = "discord:dm-7"
        user_key = "discord:keeper-7"
        transport = "discord"
        name = "Keeper"

        def __init__(self) -> None:
            self.source = source

        async def deliver(self, _event) -> None:
            return None

    await set_keeper_binding(services.store, "discord", "keeper-7", "arkham")
    member = DirectMember()
    session_key = session_key_for_room("arkham")
    await hub.subscribe(session_key, member)
    listed = await admin.dispatch(
        "keeper", "arkham", {"type": "admin_list_keys"}, get_i18n("en")
    )
    binding_id = next(
        item["id"] for item in listed["keys"] if item["id"].startswith("chat:")
    )

    await admin.dispatch(
        "keeper",
        "arkham",
        {"type": "admin_delete_key", "id": binding_id},
        get_i18n("en"),
    )

    assert await get_keeper_binding(services.store, "discord", "keeper-7") is None
    assert member not in hub.members(session_key)
    assert await resolve_session_key(services.store, source) == source.chat_key()


async def test_admin_set_model_replaces_provider_scoped_credentials():
    import time

    from infra.oauth_flows import SubscriptionToken

    services = _services()
    admin = AdminService(services, Keystore())
    previous = {
        "provider": "deepseek",
        "chat_model": "deepseek-chat",
        "api_key": "sk-old-provider",
        "base_url": "https://old-provider.example/v1",
    }
    await services.runtime_config.replace(**previous)
    services.llm.apply(previous)
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )

    switched = await admin.dispatch(
        "keeper",
        "",
        {"type": "admin_set_model", "provider": "supergrok"},
        get_i18n("en"),
    )

    assert switched["type"] == "admin_config"
    assert switched["provider"] == "supergrok"
    assert await services.runtime_config.get() == {
        "provider": "supergrok",
        "chat_model": "grok-4.3",
        "api_key": "",
        "base_url": "",
    }
    assert services.settings.llm.api_key == ""
    assert services.settings.llm.base_url == ""

    await services.llm_credentials.remember(
        "chatgpt",
        api_key="sk-chatgpt-proxy",
        base_url="https://chatgpt-proxy.example/v1",
    )
    proxy = await admin.dispatch(
        "keeper",
        "",
        {"type": "admin_set_model", "provider": "chatgpt", "chat_model": "proxy-model"},
        get_i18n("en"),
    )

    assert proxy["type"] == "admin_config"
    assert await services.runtime_config.get() == {
        "provider": "chatgpt",
        "chat_model": "proxy-model",
        "api_key": "sk-chatgpt-proxy",
        "base_url": "https://chatgpt-proxy.example/v1",
    }


async def _seed_reset_room(services, chat_key):
    await services.store.set(user_key="", store_key=f"chat_history.{chat_key}", value='[{"role":"user"}]')
    await services.store.set(user_key="player-1", store_key=f"characters.{chat_key}.Ada", value='{"name":"Ada"}')
    await services.store.set(user_key="", store_key=f"module_player_pool.{chat_key}", value='{"summary":"x"}')
    await services.store.set(user_key="", store_key=f"coc_rule.{chat_key}", value="2")
    await services.store.set(user_key="", store_key="bound_room.discord:group:table", value=chat_key)
    await services.store.set(user_key="", store_key="chat_history.tui:group:dunwich", value="keep")
    await services.vector_db.vector_store.upsert(
        [("doc-1:0", [0.1] * 64, {"chat_key": chat_key, "document_id": "doc-1", "chunk_index": 0})]
    )


async def test_admin_reset_room_all_wipes_everything_but_settings_and_keys(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore.load(tmp_path / "keys.toml")
    with keystore.persisted_mutation():
        keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
        player_key = keystore.add(room="arkham", name="Ada", role="player")
        other_key = keystore.add(room="dunwich", name="Other", role="player")

    chat_key = chat_key_for_room("arkham")
    await _seed_reset_room(services, chat_key)

    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

        # A different room's keeper reset is refused before anything is touched.
        forbidden = await _send(ws, {"type": "admin_reset_room", "room": "dunwich"})
        assert forbidden["type"] == "admin_error" and forbidden["code"] == "forbidden"
        # An unknown scope is a bad request (validated before any wipe).
        bad = await _send(ws, {"type": "admin_reset_room", "room": "arkham", "scope": "bogus"})
        assert bad["type"] == "admin_error" and bad["code"] == "bad_request"

        # A successful reset also broadcasts a fresh reset-flagged state frame to the
        # connected keeper (so its panel + chat log refresh without reconnecting), which
        # arrives alongside the admin_room_op reply — drain both regardless of order.
        await ws.send(json.dumps({"type": "admin_reset_room", "room": "arkham", "scope": "all"}))
        reset = None
        state = None
        for _ in range(4):
            frame = await _recv(ws)
            if frame["type"] == "admin_room_op":
                reset = frame
                break
            if frame["type"] == "state":
                state = frame
        assert reset is not None
        assert reset["action"] == "reset"
        assert reset["room"] == "arkham"
        assert reset["scope"] == "all"
        assert reset["store_rows"] == 3  # chat_history + characters.Ada + module_player_pool
        assert reset["vector_points"] == 1
        assert reset["keys"] == 0  # reset never removes keys
        assert "path" not in reset  # no backup is written
        assert state is not None and state.get("reset") is True
    finally:
        await server.close()

    # Campaign state is gone...
    assert await services.store.get(user_key="", store_key=f"chat_history.{chat_key}") is None
    assert await services.store.get(user_key="player-1", store_key=f"characters.{chat_key}.Ada") is None
    assert await services.store.get(user_key="", store_key=f"module_player_pool.{chat_key}") is None
    assert await services.vector_db.vector_store.count(filter={"chat_key": chat_key}) == 0
    # ...but room settings, keys, channel binding, and the unrelated room all survive.
    assert await services.store.get(user_key="", store_key=f"coc_rule.{chat_key}") == "2"
    assert keystore.get(keeper_key) is not None
    assert keystore.get(player_key) is not None
    assert keystore.get(other_key) is not None
    assert await services.store.get(user_key="", store_key="bound_room.discord:group:table") == chat_key


async def test_admin_reset_room_story_scope_keeps_characters_module_and_vectors(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore.load(tmp_path / "keys.toml")
    with keystore.persisted_mutation():
        keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")

    chat_key = chat_key_for_room("arkham")
    await _seed_reset_room(services, chat_key)

    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        # Default scope ("story") when the field is omitted.
        await ws.send(json.dumps({"type": "admin_reset_room", "room": "arkham"}))
        reset = None
        for _ in range(4):
            frame = await _recv(ws)
            if frame["type"] == "admin_room_op":
                reset = frame
                break
        assert reset is not None
        assert reset["scope"] == "story"
        assert reset["store_rows"] == 1  # only chat_history
        assert reset["vector_points"] == 0  # module vectors untouched
    finally:
        await server.close()

    # Story gone, but the character, module and its vectors all survive.
    assert await services.store.get(user_key="", store_key=f"chat_history.{chat_key}") is None
    assert await services.store.get(user_key="player-1", store_key=f"characters.{chat_key}.Ada") is not None
    assert await services.store.get(user_key="", store_key=f"module_player_pool.{chat_key}") is not None
    assert await services.vector_db.vector_store.count(filter={"chat_key": chat_key}) == 1
    assert await services.store.get(user_key="", store_key="bound_room.discord:group:table") == chat_key
    assert await services.store.get(user_key="", store_key="chat_history.tui:group:dunwich") == "keep"


async def test_keeper_can_export_delete_and_import_room_data(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore.load(tmp_path / "keys.toml")
    with keystore.persisted_mutation():
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
    for base, value in {
        "skills_enabled": '["romance-relationships"]',
        "media_enabled": "1",
        "media_history": "[]",
        "audio_library": "[]",
        "audio_state": "{}",
        "relationships": '{"Ada":{"West":{"affection":5}}}',
        "usage_stats": '{"input_tokens":12}',
    }.items():
        await services.store.set(user_key="", store_key=f"{base}.{chat_key}", value=value)
    media_store = MediaStore(
        services.store,
        services.settings.data_dir,
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    media_record = await media_store.register_blob(
        room=chat_key,
        data=b"private handout",
        mime="image/png",
        name="clue.png",
        uploader="keeper",
    )
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
        assert exported["store_rows"] == 16
        assert exported["vector_points"] == 2
        assert exported["media_files"] == 1
        snapshot = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
        assert {item["key"] for item in snapshot["keys"]} == {keeper_key, player_key}
        assert snapshot["media"][0]["hash"] == media_record.hash
        if os.name == "posix":
            assert stat.S_IMODE(Path(backups).stat().st_mode) == 0o700
            assert stat.S_IMODE(Path(exported["path"]).stat().st_mode) == 0o600

        deleted = await _send(
            ws,
            {"type": "admin_delete_room_data", "room": "arkham", "backup": True, "path": "arkham-delete-backup.json"},
        )
        assert deleted["type"] == "admin_room_op"
        assert deleted["action"] == "delete"
        assert deleted["path"].startswith(backups) and deleted["path"].endswith("arkham-delete-backup.json")
        assert deleted["keys"] == 2
        assert deleted["store_rows"] == 16
        assert deleted["vector_points"] == 2
        assert deleted["media_files"] == 1
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
        for base in (
            "skills_enabled",
            "media_enabled",
            "media_history",
            "audio_library",
            "audio_state",
            "relationships",
            "usage_stats",
        ):
            assert await services.store.get(user_key="", store_key=f"{base}.{chat_key}") is None
        with pytest.raises(MediaError, match="media_not_found"):
            await media_store.read_bytes(chat_key, media_record.hash)

        # Revoking the room's keys invalidates the live Keeper connection immediately; it must
        # not retain stale admin authority merely because it authenticated before the delete.
        stale = await _send(ws, {"type": "admin_import_room", "path": Path(deleted["path"]).name})
        assert stale["type"] == "error"
        assert stale["code"] == "forbidden"
        await ws.close()

        # Restore through a newly minted, persisted out-of-band operations key. Importing INTO
        # another room is forbidden — see test_admin_room_ops_are_scoped_to_the_callers_room.
        with keystore.persisted_mutation():
            recovery_key = keystore.add(room="arkham", name="Recovery", role="keeper")
        ws, *_ = await _connect_and_join(url, recovery_key, "Recovery")
        if os.name == "posix":
            os.chmod(deleted["path"], 0o644)  # legacy backup permissions self-heal on import
        imported = await _send(ws, {"type": "admin_import_room", "path": Path(deleted["path"]).name})
        assert imported["type"] == "admin_room_op"
        assert imported["action"] == "import"
        assert imported["room"] == "arkham"
        assert imported["keys"] == 2
        assert imported["store_rows"] == 16
        assert imported["vector_points"] == 2
        assert imported["media_files"] == 1
        if os.name == "posix":
            assert stat.S_IMODE(Path(deleted["path"]).stat().st_mode) == 0o600
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
        restored_record, restored_data = await media_store.read_bytes(chat_key, media_record.hash)
        assert restored_record.name == "clue.png"
        assert restored_data == b"private handout"
        assert await services.store.get(user_key="", store_key=f"skills_enabled.{chat_key}") == '["romance-relationships"]'
        assert await services.store.get(user_key="", store_key=f"relationships.{chat_key}") == '{"Ada":{"West":{"affection":5}}}'

        await ws.close()
    finally:
        await server.close()


async def test_room_backup_paths_are_room_owned_and_default_names_are_unique(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    keystore.add(room="dunwich", name="Keeper", role="keeper")
    arkham_key = chat_key_for_room("arkham")
    dunwich_key = chat_key_for_room("dunwich")
    await services.store.set(store_key=f"chat_history.{arkham_key}", value="arkham-v1")
    await services.store.set(store_key=f"chat_history.{dunwich_key}", value="dunwich-v1")

    arkham = await export_room(services, keystore, "arkham", "shared.json")
    dunwich = await export_room(services, keystore, "dunwich", "shared.json")
    arkham_path = Path(arkham["path"])
    dunwich_path = Path(dunwich["path"])
    dunwich_bytes = dunwich_path.read_bytes()

    assert arkham_path.parent != dunwich_path.parent
    assert arkham_path.name == dunwich_path.name == "shared.json"

    # Replacing a named snapshot is confined to the exact room namespace.
    await services.store.set(store_key=f"chat_history.{arkham_key}", value="arkham-v2")
    replaced = await export_room(services, keystore, "arkham", "shared.json")
    assert Path(replaced["path"]) == arkham_path
    assert dunwich_path.read_bytes() == dunwich_bytes

    first_default = await export_room(services, keystore, "arkham")
    second_default = await export_room(services, keystore, "arkham")
    assert first_default["path"] != second_default["path"]

    # If Arkham's file is absent, an Arkham import must not discover Dunwich's same-name file.
    arkham_path.unlink()
    with pytest.raises(ValueError, match="not a room backup file"):
        await import_room(services, keystore, "shared.json", expected_room="arkham")
    assert dunwich_path.is_file()


@pytest.mark.skipif(os.name != "posix", reason="symlink semantics are platform-specific")
async def test_room_backup_rejects_import_symlinks_but_export_replaces_the_link(tmp_path):
    services = _services(str(tmp_path))
    room = "arkham"
    exported = await export_room(services, Keystore(), room, "original.json")
    room_dir = Path(exported["path"]).parent
    outside = tmp_path / "outside.json"
    outside.write_text("do not overwrite", encoding="utf-8")
    alias = room_dir / "alias.json"
    alias.symlink_to(outside)

    with pytest.raises(ValueError, match="not a room backup file"):
        await import_room(services, Keystore(), alias.name, expected_room=room)

    replaced = await export_room(services, Keystore(), room, alias.name)
    assert Path(replaced["path"]) == alias
    assert not alias.is_symlink()
    assert outside.read_text(encoding="utf-8") == "do not overwrite"


@pytest.mark.skipif(os.name != "posix", reason="symlink semantics are platform-specific")
async def test_room_backup_rejects_a_symlinked_room_directory(tmp_path):
    services = _services(str(tmp_path))
    room = "arkham"
    exported = await export_room(services, Keystore(), room, "snapshot.json")
    snapshot = Path(exported["path"])
    room_dir = snapshot.parent
    other_room = Path(
        (await export_room(services, Keystore(), "dunwich", "snapshot.json"))["path"]
    ).parent

    snapshot.unlink()
    room_dir.rmdir()
    room_dir.symlink_to(other_room, target_is_directory=True)

    with pytest.raises(ValueError, match="must not be a symlink"):
        await import_room(services, Keystore(), "snapshot.json", expected_room=room)
    with pytest.raises(ValueError, match="must not be a symlink"):
        await export_room(services, Keystore(), room, "snapshot.json")


async def test_dotted_child_room_prefix_fails_closed_for_export_delete_and_import(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="foo", name="Parent Keeper", role="keeper")
    parent_key = chat_key_for_room("foo")
    child_key = chat_key_for_room("foo.bar")
    parent_history = f"chat_history.{parent_key}"
    child_history = f"chat_history.{child_key}"
    child_character = f"characters.{child_key}.Bob"
    await services.store.set(store_key=parent_history, value="parent")

    # Produce a legitimate parent snapshot before the ambiguous child exists.
    exported = await export_room(services, keystore, "foo", "before-child.json")
    keystore.add(room="foo.bar", name="Child Keeper", role="keeper")
    await services.store.set(store_key=child_history, value="child")
    await services.store.set(store_key=child_character, value='{"name":"Bob"}')

    for operation in (
        lambda: export_room(services, keystore, "foo", "after-child.json"),
        lambda: delete_room_data(services, keystore, "foo"),
        lambda: import_room(
            services,
            keystore,
            Path(exported["path"]).name,
            expected_room="foo",
        ),
        # reset_room_state deletes by store-key prefix, so it must fail closed on the same
        # dotted-child ambiguity every other room op guards (else `.reset all` on "foo" would
        # silently wipe "foo.bar"'s rows — cross-room data loss with no backup). "all" is the
        # widest scope and therefore the strongest case.
        lambda: reset_room_state(services, parent_key, scope="all", keystore=keystore),
    ):
        with pytest.raises(ValueError, match="ambiguous dotted-prefix"):
            await operation()

    # Fail-closed means neither the child nor the parent was partially exposed/deleted/imported/reset.
    assert await services.store.get(store_key=parent_history) == "parent"
    assert await services.store.get(store_key=child_history) == "child"
    assert await services.store.get(store_key=child_character) == '{"name":"Bob"}'


async def test_reset_without_ambiguous_neighbor_still_wipes_and_a_prefix_named_sibling_survives(tmp_path):
    """The guard fails closed only on a TRUE dotted child; an ordinary sibling room whose id merely
    shares a leading substring (not a dotted prefix) is unaffected, and reset still works normally."""
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="foo", name="Keeper", role="keeper")
    keystore.add(room="foobar", name="Sibling Keeper", role="keeper")  # NOT a dotted child of "foo"
    parent_key = chat_key_for_room("foo")
    sibling_key = chat_key_for_room("foobar")
    await services.store.set(store_key=f"chat_history.{parent_key}", value="parent-story")
    await services.store.set(store_key=f"worldbook.{sibling_key}.e1", value='{"title":"sibling"}')

    result = await reset_room_state(services, parent_key, scope="all", keystore=keystore)

    assert int(result.get("store_rows") or 0) >= 1
    assert await services.store.get(store_key=f"chat_history.{parent_key}") is None  # parent wiped
    assert await services.store.get(store_key=f"worldbook.{sibling_key}.e1") is not None  # sibling intact


async def test_vector_conflicting_ownership_fails_export_and_delete_without_erasing_point(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    foreign_key = chat_key_for_room("dunwich")
    await services.vector_db.vector_store.upsert(
        [
            (
                "conflicted:0",
                [0.1] * 64,
                {
                    "chat_key": chat_key,
                    "namespace": foreign_key,
                    "document_id": "conflicted",
                },
            )
        ]
    )

    with pytest.raises(ValueError, match="conflicting room ownership"):
        await export_room(services, keystore, "arkham", "conflicted.json")
    with pytest.raises(ValueError, match="conflicting room ownership"):
        await delete_room_data(services, keystore, "arkham")

    points = await services.vector_db.vector_store.dump(filter={"chat_key": chat_key})
    assert [point["id"] for point in points] == ["conflicted:0"]


async def test_room_vector_restore_preserves_canonical_ids_and_future_upserts(tmp_path):
    services = _services(str(tmp_path))
    room = "arkham"
    chat_key = chat_key_for_room(room)
    await services.vector_db.store_document(
        "doc-1",
        "original.txt",
        "original clue",
        chat_key,
    )
    exported = await export_room(services, Keystore(), room, "vectors.json")

    # Importing over the live room is an upsert of the same deterministic point,
    # not a second namespaced alias.
    await import_room(
        services,
        Keystore(),
        Path(exported["path"]).name,
        expected_room=room,
    )
    points = await room_vector_points(services, chat_key)
    assert [point["id"] for point in points] == ["doc-1:0"]

    # Snapshots produced after the old buggy importer may themselves contain its
    # `:backup:` alias. Restore normalizes those from payload identity as well.
    source = Path(exported["path"])
    snapshot = json.loads(source.read_text(encoding="utf-8"))
    snapshot["vector_points"][0]["id"] = f"{chat_key}:backup:legacy"
    source.write_text(json.dumps(snapshot), encoding="utf-8")
    await delete_room_data(services, Keystore(), room)
    await import_room(services, Keystore(), source.name, expected_room=room)
    await services.vector_db.store_document(
        "doc-1",
        "updated.txt",
        "updated clue",
        chat_key,
    )

    points = await room_vector_points(services, chat_key)
    assert [point["id"] for point in points] == ["doc-1:0"]
    assert points[0]["payload"]["filename"] == "updated.txt"
    assert points[0]["payload"]["text"] == "updated clue"


async def test_room_import_rejects_a_vector_id_owned_by_another_room(tmp_path):
    services = _services(str(tmp_path))
    room = "arkham"
    chat_key = chat_key_for_room(room)
    foreign_key = chat_key_for_room("dunwich")
    await services.vector_db.store_document(
        "doc-1",
        "arkham.txt",
        "arkham clue",
        chat_key,
    )
    exported = await export_room(services, Keystore(), room, "collision.json")
    await services.vector_db.vector_store.delete(["doc-1:0"])
    await services.vector_db.vector_store.upsert(
        [
            (
                "doc-1:0",
                [0.9] * 64,
                {
                    "chat_key": foreign_key,
                    "document_id": "doc-1",
                    "chunk_index": 0,
                    "text": "foreign clue",
                },
            )
        ]
    )

    with pytest.raises(ValueError, match="vector id belongs to another room"):
        await import_room(
            services,
            Keystore(),
            Path(exported["path"]).name,
            expected_room=room,
        )

    [foreign] = await services.vector_db.vector_store.scroll()
    assert foreign.id == "doc-1:0"
    assert foreign.payload["chat_key"] == foreign_key
    assert await services.vector_db.vector_store.count(filter={"chat_key": chat_key}) == 0


@pytest.mark.parametrize(
    "case",
    [
        "document_foreign_namespace",
        "document_missing_chat_key",
        "worldbook_foreign_chat_key",
        "worldbook_missing_namespace",
        "nested_foreign_owner",
    ],
)
async def test_room_import_requires_every_vector_owner_field_to_match_target(tmp_path, case):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    foreign_key = chat_key_for_room("dunwich")
    exported = await export_room(services, keystore, "arkham", f"vector-{case}.json")
    source = Path(exported["path"])
    snapshot = json.loads(source.read_text(encoding="utf-8"))
    payloads = {
        "document_foreign_namespace": {
            "chat_key": chat_key,
            "namespace": foreign_key,
            "document_id": "doc",
        },
        "document_missing_chat_key": {"namespace": chat_key, "document_id": "doc"},
        "worldbook_foreign_chat_key": {
            "collection": "worldbook",
            "namespace": chat_key,
            "chat_key": foreign_key,
            "entry_id": "entry",
        },
        "worldbook_missing_namespace": {
            "collection": "worldbook",
            "chat_key": chat_key,
            "entry_id": "entry",
        },
        "nested_foreign_owner": {
            "chat_key": chat_key,
            "document_id": "doc",
            "metadata": {"namespace": foreign_key},
        },
    }
    snapshot["vector_points"] = [
        {"id": "forged:0", "vector": [0.2] * 64, "payload": payloads[case]}
    ]
    source.write_text(json.dumps(snapshot), encoding="utf-8")

    with pytest.raises(ValueError, match="vector owned by another room"):
        await import_room(services, keystore, source.name, expected_room="arkham")
    assert await services.vector_db.vector_store.count() == 0


async def test_import_rejects_foreign_bound_room_inside_the_same_store_transaction(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    foreign_key = chat_key_for_room("dunwich")
    history_key = f"chat_history.{chat_key}"
    binding_key = "bound_room.discord:group:table"
    await services.store.set(store_key=history_key, value="snapshot")
    await services.store.set(store_key=binding_key, value=chat_key)
    exported = await export_room(services, keystore, "arkham", "binding.json")

    await services.store.set(store_key=history_key, value="live")
    await services.store.set(store_key=binding_key, value=foreign_key)
    with pytest.raises(ValueError, match="bound room already belongs"):
        await import_room(
            services,
            keystore,
            Path(exported["path"]).name,
            expected_room="arkham",
        )

    # The conflict check precedes every upsert in the BEGIN IMMEDIATE transaction.
    assert await services.store.get(store_key=history_key) == "live"
    assert await services.store.get(store_key=binding_key) == foreign_key


async def test_import_rollback_preserves_a_concurrent_foreign_room_binding(tmp_path):
    services = _services(str(tmp_path))
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    foreign_key = chat_key_for_room("dunwich")
    history_key = f"chat_history.{chat_key}"
    binding_key = "bound_room.discord:group:table"
    await services.store.set(store_key=history_key, value="snapshot")
    await services.store.set(store_key=binding_key, value=chat_key)
    media_store = MediaStore(
        services.store,
        services.settings.data_dir,
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    await media_store.register_blob(
        room=chat_key,
        data=b"rollback trigger",
        mime="image/png",
        name="trigger.png",
        uploader="keeper",
    )
    exported = await export_room(services, keystore, "arkham", "binding-rollback.json")
    await services.store.set(store_key=history_key, value="live")

    async def _rebind_then_fail(_instance, **_kwargs):
        await services.store.set(store_key=binding_key, value=foreign_key)
        raise OSError("injected import failure after concurrent rebind")

    with patch.object(MediaStore, "validate_offer", new=_rebind_then_fail):
        with pytest.raises(OSError, match="concurrent rebind"):
            await import_room(
                services,
                keystore,
                Path(exported["path"]).name,
                expected_room="arkham",
            )

    assert await services.store.get(store_key=history_key) == "live"
    assert await services.store.get(store_key=binding_key) == foreign_key


async def test_room_export_refreshes_external_key_moves_before_snapshot(tmp_path):
    services = _services(str(tmp_path))
    key_path = tmp_path / "keys.toml"
    keystore = Keystore.load(key_path)
    with keystore.persisted_mutation():
        key = keystore.add(room="arkham", name="Keeper", role="keeper")

    external = Keystore.load(key_path)
    with external.persisted_mutation():
        assert external.update(key, room="dunwich")

    exported = await export_room(services, keystore, "arkham", "after-move.json")
    snapshot = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
    assert snapshot["keys"] == []


async def test_room_export_rejects_media_over_the_backup_budget_before_writing(tmp_path, monkeypatch):
    services = _services(str(tmp_path))
    room = "arkham"
    chat_key = chat_key_for_room(room)
    media_store = MediaStore(
        services.store,
        services.settings.data_dir,
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    await media_store.register_blob(
        room=chat_key,
        data=b"large-for-this-test",
        mime="image/png",
        name="clue.png",
        uploader="keeper",
    )
    monkeypatch.setattr(room_backup_module, "MAX_BACKUP_MEDIA_BYTES", 4)

    with pytest.raises(ValueError, match="media backup byte limit exceeded"):
        await export_room(services, Keystore(), room, "oversized.json")

    backup_root = Path(services.settings.data_dir) / "room_backups"
    assert not list(backup_root.rglob("oversized.json"))


async def test_room_import_enforces_the_image_policy_not_the_aggregate_audio_limit(tmp_path):
    services = _services(str(tmp_path))
    room = "arkham"
    chat_key = chat_key_for_room(room)
    media_store = MediaStore(
        services.store,
        services.settings.data_dir,
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    record = await media_store.register_blob(
        room=chat_key,
        data=b"image",
        mime="image/png",
        name="clue.png",
        uploader="keeper",
    )
    exported = await export_room(services, Keystore(), room, "image-policy.json")
    await delete_room_data(services, Keystore(), room)

    # Audio's much larger configured limit must not make this image acceptable.
    services.settings.tui.media_max_file_bytes = 4
    assert services.settings.tui.audio_max_file_bytes > 4
    with pytest.raises(ValueError, match="invalid media entry"):
        await import_room(services, Keystore(), Path(exported["path"]).name, expected_room=room)
    with pytest.raises(MediaError, match="media_not_found"):
        await media_store.read_bytes(chat_key, record.hash)


async def test_delete_room_rolls_back_every_component_after_late_media_failure(tmp_path):
    services = _services(str(tmp_path))
    key_path = tmp_path / "keys.toml"
    keystore = Keystore.load(key_path)
    with keystore.persisted_mutation():
        keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    store_key = f"chat_history.{chat_key}"
    await services.store.set(store_key=store_key, value="original")
    await services.vector_db.vector_store.upsert(
        [("original:0", [0.25] * 64, {"chat_key": chat_key, "document_id": "original"})]
    )
    media_store = MediaStore(
        services.store,
        services.settings.data_dir,
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    media_record = await media_store.register_blob(
        room=chat_key,
        data=b"original handout",
        mime="image/png",
        name="original.png",
        uploader="keeper",
    )
    original_delete = MediaStore.delete_room
    recovery_key = ""

    async def _delete_then_fail(instance, target_room):
        nonlocal recovery_key
        await original_delete(instance, target_room)
        # Simulate a separate operations process minting a recovery credential after
        # the delete's keystore leg. The later rollback must merge, not erase it.
        external = Keystore.load(key_path)
        with external.persisted_mutation():
            recovery_key = external.add(room="arkham", name="Recovery", role="keeper")
        raise OSError("injected post-delete failure")

    with patch.object(MediaStore, "delete_room", new=_delete_then_fail):
        failed = await AdminService(services, keystore).dispatch(
            "keeper",
            "arkham",
            {"type": "admin_delete_room_data", "room": "arkham", "backup": False},
            get_i18n("en"),
        )
    assert failed["type"] == "admin_error"
    assert failed["code"] == "op_failed"

    assert await services.store.get(store_key=store_key) == "original"
    restored_vectors = await room_vector_points(services, chat_key)
    assert [point["id"] for point in restored_vectors] == ["original:0"]
    persisted_keys = Keystore.load(key_path)
    assert persisted_keys.get(keeper_key) is not None
    assert persisted_keys.get(recovery_key) is not None
    restored_record, restored_data = await media_store.read_bytes(chat_key, media_record.hash)
    assert restored_record.name == "original.png"
    assert restored_data == b"original handout"


async def test_import_room_rolls_back_every_component_when_key_persistence_fails(tmp_path):
    services = _services(str(tmp_path))
    key_path = tmp_path / "keys.toml"
    keystore = Keystore.load(key_path)
    room = "arkham"
    chat_key = chat_key_for_room(room)
    store_key = f"chat_history.{chat_key}"
    with keystore.persisted_mutation():
        backup_key = keystore.add(room=room, name="Old Keeper", role="keeper")
    await services.store.set(store_key=store_key, value="backup")
    await services.vector_db.vector_store.upsert(
        [("backup:0", [0.1] * 64, {"chat_key": chat_key, "document_id": "backup"})]
    )
    media_store = MediaStore(
        services.store,
        services.settings.data_dir,
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    backup_media = await media_store.register_blob(
        room=chat_key,
        data=b"backup handout",
        mime="image/png",
        name="backup.png",
        uploader="keeper",
    )
    exported = await export_room(services, keystore, room, "rollback.json")
    await delete_room_data(services, keystore, room)

    with keystore.persisted_mutation():
        recovery_key = keystore.add(room=room, name="Recovery", role="keeper")
    await services.store.set(store_key=store_key, value="live")
    await services.vector_db.vector_store.upsert(
        [("live:0", [0.9] * 64, {"chat_key": chat_key, "document_id": "live"})]
    )
    live_media = await media_store.register_blob(
        room=chat_key,
        data=b"live handout",
        mime="image/png",
        name="live.png",
        uploader="recovery",
    )
    live_rows = await room_rows(services, chat_key)
    live_vectors = await room_vector_points(services, chat_key)

    original_writer = keystore_module.atomic_write_private
    failed = False

    def _fail_key_write_once(path, data, *, encoding="utf-8"):
        nonlocal failed
        if Path(path).resolve() == key_path.resolve() and not failed:
            failed = True
            raise OSError("injected keystore write failure")
        return original_writer(path, data, encoding=encoding)

    with patch.object(keystore_module, "atomic_write_private", new=_fail_key_write_once):
        failed_import = await AdminService(services, keystore).dispatch(
            "keeper",
            room,
            {"type": "admin_import_room", "path": Path(exported["path"]).name},
            get_i18n("en"),
        )
    assert failed_import["type"] == "admin_error"
    assert failed_import["code"] == "op_failed"

    def _normalized_rows(rows):
        return sorted((row["user_key"], row["store_key"], row["value"]) for row in rows)

    assert _normalized_rows(await room_rows(services, chat_key)) == _normalized_rows(live_rows)
    assert await room_vector_points(services, chat_key) == live_vectors
    assert keystore.get(recovery_key) is not None
    assert keystore.get(backup_key) is None
    records = await media_store.list_room_records(chat_key)
    assert [record.hash for record in records] == [live_media.hash]
    _, live_data = await media_store.read_bytes(chat_key, live_media.hash)
    assert live_data == b"live handout"
    with pytest.raises(MediaError, match="media_not_found"):
        await media_store.read_bytes(chat_key, backup_media.hash)


async def test_admin_room_ops_are_scoped_to_the_callers_room():
    """Security: a keeper key bound to room A cannot mutate/export/wipe/import room B — only its
    own room, including listing/minting/mutating access keys."""
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")  # caller is bound to arkham
    victim_key = keystore.add(room="dunwich", name="Other Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        listed = await _send(ws, {"type": "admin_list_keys"})
        assert {entry["room"] for entry in listed["keys"]} == {"arkham"}
        victim_id = hashlib.sha256(victim_key.encode("utf-8")).hexdigest()[:16]
        for request in (
            {"type": "admin_mint_key", "room": "dunwich", "role": "keeper"},
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


async def test_set_model_remembers_each_providers_key_and_reuses_it_on_switch_back():
    """The credential book: setting a key for a provider persists + remembers it; switching to
    another provider (with its own key) and then BACK reuses the first provider's saved key
    without re-supplying it — the multi-provider combo the model screen relies on."""
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

        # deepseek + its key: applied, persisted, remembered, and surfaced in saved_providers.
        first = await _send(
            ws,
            {"type": "admin_set_model", "provider": "deepseek", "chat_model": "deepseek-chat", "api_key": "sk-deep"},
        )
        assert first["type"] == "admin_config"
        assert first["provider"] == "deepseek"
        assert "deepseek" in first["saved_providers"]
        assert (await services.runtime_config.get())["api_key"] == "sk-deep"
        assert (await services.llm_credentials.get("deepseek"))["api_key"] == "sk-deep"

        # a different provider with its own key.
        await _send(ws, {"type": "admin_set_model", "provider": "openai", "api_key": "sk-open"})
        assert (await services.runtime_config.get())["api_key"] == "sk-open"
        assert (await services.llm_credentials.get("openai"))["api_key"] == "sk-open"

        # switch BACK to deepseek WITHOUT a key → the saved deepseek key is reused.
        back = await _send(ws, {"type": "admin_set_model", "provider": "deepseek"})
        assert back["provider"] == "deepseek"
        assert (await services.runtime_config.get())["api_key"] == "sk-deep"
        assert set(back["saved_providers"]) >= {"deepseek", "openai"}

        await ws.close()
    finally:
        await server.close()


async def test_preset_llm_endpoint_roundtrip_keeps_the_existing_key():
    """The config frame exposes a preset's effective URL even when the stored URL
    is empty. Sending that unchanged value back must not look like a trust-boundary
    move and silently clear the key."""
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    captured: list[LLMSettings] = []

    async def _capture(settings: LLMSettings):
        captured.append(settings)
        return []

    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        first = await _send(
            ws,
            {
                "type": "admin_set_model",
                "provider": "deepseek",
                "chat_model": "deepseek-chat",
                "api_key": "sk-preset",
            },
        )
        effective_url = PRESETS["deepseek"]
        assert first["base_url"] == effective_url
        assert services.settings.llm.base_url == ""

        with patch("net.admin.list_models", new=_capture):
            await _send(
                ws,
                {
                    "type": "admin_list_models",
                    "provider": "deepseek",
                    "base_url": effective_url,
                },
            )
        assert captured[-1].api_key == "sk-preset"

        saved = await _send(
            ws,
            {
                "type": "admin_set_model",
                "provider": "deepseek",
                "base_url": effective_url,
            },
        )
        assert saved["type"] == "admin_config"
        assert services.settings.llm.api_key == "sk-preset"
        assert await services.llm_credentials.get("deepseek") == {
            "api_key": "sk-preset",
            "base_url": effective_url,
        }

        await ws.close()
    finally:
        await server.close()


async def test_new_model_endpoint_never_receives_or_remembers_the_old_key():
    """A caller-selected URL is a new trust boundary: preview/save must not attach
    the key associated with the previous URL, including on a later keyless save."""
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    captured: list[LLMSettings] = []

    async def _capture(settings: LLMSettings):
        captured.append(settings)
        return []

    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        await _send(
            ws,
            {
                "type": "admin_set_model",
                "provider": "openai",
                "base_url": "https://old.example/v1",
                "api_key": "sk-old-endpoint",
            },
        )

        with patch("net.admin.list_models", new=_capture):
            await _send(
                ws,
                {
                    "type": "admin_list_models",
                    "provider": "openai",
                    "base_url": "https://new.example/v1",
                },
            )
        assert captured[-1].base_url == "https://new.example/v1"
        assert captured[-1].api_key == ""

        changed = await _send(
            ws,
            {
                "type": "admin_set_model",
                "provider": "openai",
                "base_url": "https://new.example/v1",
            },
        )
        assert changed["type"] == "admin_config"
        assert services.settings.llm.base_url == "https://new.example/v1"
        assert services.settings.llm.api_key == ""
        assert await services.llm_credentials.get("openai") == {
            "base_url": "https://new.example/v1"
        }

        # A later save with omitted fields must not resurrect the old saved key.
        await _send(ws, {"type": "admin_set_model", "provider": "openai"})
        assert services.settings.llm.api_key == ""

        # Supplying the replacement key on the same request is accepted and paired
        # only with that new endpoint.
        await _send(
            ws,
            {
                "type": "admin_set_model",
                "provider": "openai",
                "base_url": "https://third.example/v1",
                "api_key": "sk-third-endpoint",
            },
        )
        assert await services.llm_credentials.get("openai") == {
            "api_key": "sk-third-endpoint",
            "base_url": "https://third.example/v1",
        }

        # Presence matters: an explicitly empty key clears it while retaining the
        # unchanged endpoint (the TUI omits blank fields when it means "reuse").
        await _send(
            ws,
            {"type": "admin_set_model", "provider": "openai", "api_key": ""},
        )
        assert await services.llm_credentials.get("openai") == {
            "base_url": "https://third.example/v1"
        }

        await ws.close()
    finally:
        await server.close()


async def test_model_runtime_persistence_failure_reports_error_without_compensation():
    services = _services()
    original_inner = services.llm.inner

    with patch.object(
        services.runtime_config,
        "replace",
        new=AsyncMock(side_effect=OSError("database is read-only")),
    ):
        result = await AdminService(services, Keystore()).dispatch(
            "keeper",
            "arkham",
            {
                "type": "admin_set_model",
                "provider": "deepseek",
                "chat_model": "deepseek-chat",
                "api_key": "sk-new",
            },
            get_i18n("en"),
        )

    assert result["type"] == "admin_error"
    assert result["code"] == "set_failed"
    assert services.settings.llm.provider == "deepseek"
    assert services.settings.llm.chat_model == "deepseek-chat"
    assert services.llm.inner is not original_inner
    assert await services.runtime_config.get() == {}


async def test_model_credential_persistence_failure_keeps_applied_runtime():
    services = _services()
    with patch.object(
        services.llm_credentials,
        "replace_static",
        new=AsyncMock(side_effect=OSError("database is read-only")),
    ):
        result = await AdminService(services, Keystore()).dispatch(
            "keeper",
            "arkham",
            {
                "type": "admin_set_model",
                "provider": "deepseek",
                "chat_model": "deepseek-chat",
                "api_key": "sk-new",
            },
            get_i18n("en"),
        )

    assert result["type"] == "admin_error"
    assert result["code"] == "set_failed"
    assert services.settings.llm.provider == "deepseek"
    assert await services.runtime_config.get() == {
        "provider": "deepseek",
        "chat_model": "deepseek-chat",
        "api_key": "sk-new",
        "base_url": "",
    }
    assert await services.llm_credentials.get("deepseek") == {}


async def test_admin_set_imagegen_configures_runtime_and_masks_key():
    import time

    from infra.oauth_flows import SubscriptionToken

    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

        config = await _send(ws, {"type": "admin_get_config"})
        assert config["imagegen"]["configured"] is False
        assert config["imagegen"]["api_key_masked"] == ""

        updated = await _send(
            ws,
            {
                "type": "admin_set_imagegen",
                "provider": "openai",
                "base_url": "https://images.example/v1",
                "model": "image-model",
                "api_key": "sk-image-secret",
                "size": "512x512",
            },
        )

        assert updated["type"] == "admin_config"
        assert updated["imagegen"]["provider"] == "openai"
        assert updated["imagegen"]["model"] == "image-model"
        assert updated["imagegen"]["size"] == "512x512"
        assert updated["imagegen"]["configured"] is True
        assert updated["imagegen"]["api_key_masked"].endswith("cret")
        assert "sk-image-secret" not in json.dumps(updated)
        assert services.imagegen is not None
        assert (await services.imagegen_runtime_config.get())["api_key"] == "sk-image-secret"
        assert (await services.imagegen_credentials.get("openai"))["api_key"] == "sk-image-secret"

        with patch("net.admin.list_models", return_value=[]):
            listed = await _send(ws, {"type": "admin_list_models", "provider": "openai"})
        assert listed["type"] == "admin_models"
        assert listed["imagegen"]["configured"] is True

        # Switching to the OAuth-backed image provider replaces the whole
        # provider-scoped snapshot. Neither the previous OpenAI key/base_url nor
        # malicious values supplied on this frame may reach SuperGrok.
        await services.llm_credentials.save_subscription(
            "supergrok",
            SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
        )
        supergrok = await _send(
            ws,
            {
                "type": "admin_set_imagegen",
                "provider": "supergrok",
                "model": "grok-imagine-image",
                "api_key": "sk-must-be-ignored",
                "base_url": "https://must-not-receive-token.example/v1",
            },
        )
        assert supergrok["type"] == "admin_config"
        assert supergrok["imagegen"]["provider"] == "supergrok"
        assert services.settings.imagegen.api_key == ""
        assert services.settings.imagegen.base_url == ""
        assert await services.imagegen_runtime_config.get() == {
            "provider": "supergrok",
            "model": "grok-imagine-image",
            "size": "512x512",
            "api_key": "",
            "base_url": "",
        }

        await ws.close()
    finally:
        await server.close()


async def test_new_image_endpoint_never_reuses_or_remembers_the_old_key():
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        first = await _send(
            ws,
            {
                "type": "admin_set_imagegen",
                "provider": "openai",
                "model": "image-old",
                "base_url": "https://images-old.example/v1",
                "api_key": "sk-old-image-endpoint",
            },
        )
        assert first["type"] == "admin_config"

        changed = await _send(
            ws,
            {
                "type": "admin_set_imagegen",
                "provider": "openai",
                "model": "image-new",
                "base_url": "https://images-new.example/v1",
            },
        )
        assert changed["type"] == "admin_config"
        assert services.settings.imagegen.base_url == "https://images-new.example/v1"
        assert services.settings.imagegen.api_key == ""
        assert await services.imagegen_credentials.get("openai") == {
            "base_url": "https://images-new.example/v1"
        }

        # Omitted fields on the unchanged endpoint keep the safe, cleared state.
        await _send(
            ws,
            {"type": "admin_set_imagegen", "provider": "openai", "model": "image-newer"},
        )
        assert services.settings.imagegen.api_key == ""

        await ws.close()
    finally:
        await server.close()


async def test_preset_image_endpoint_roundtrip_keeps_the_existing_key():
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        first = await _send(
            ws,
            {
                "type": "admin_set_imagegen",
                "provider": "openai",
                "model": "gpt-image-1",
                "api_key": "sk-image-preset",
            },
        )
        effective_url = IMAGEGEN_PRESETS["openai"]["base_url"]
        assert first["imagegen"]["base_url"] == effective_url
        assert services.settings.imagegen.base_url == ""

        saved = await _send(
            ws,
            {
                "type": "admin_set_imagegen",
                "provider": "openai",
                "model": "gpt-image-1",
                "base_url": effective_url,
            },
        )
        assert saved["type"] == "admin_config"
        assert services.settings.imagegen.api_key == "sk-image-preset"
        assert await services.imagegen_credentials.get("openai") == {
            "api_key": "sk-image-preset",
            "base_url": effective_url,
        }

        await ws.close()
    finally:
        await server.close()


async def test_imagegen_build_failure_preserves_the_previous_live_state():
    services = _services()
    original_settings = services.settings.imagegen.model_copy(
        update={
            "provider": "openai",
            "model": "old-image-model",
            "api_key": "sk-old-image",
            "base_url": "https://old-images.example/v1",
        }
    )
    original_client = object()
    services.settings.imagegen = original_settings
    services.imagegen = original_client

    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        with patch("net.admin.build_imagegen", side_effect=RuntimeError("builder failed")):
            failed = await _send(
                ws,
                {
                    "type": "admin_set_imagegen",
                    "provider": "openai",
                    "model": "new-image-model",
                    "api_key": "sk-new-image",
                },
            )

        assert failed["type"] == "admin_error"
        assert failed["code"] == "set_failed"
        assert services.settings.imagegen is original_settings
        assert services.imagegen is original_client
        assert await services.imagegen_runtime_config.get() == {}

        await ws.close()
    finally:
        await server.close()


async def test_imagegen_runtime_persistence_failure_reports_error_without_compensation():
    services = _services()
    original_settings = services.settings.imagegen
    original_client = services.imagegen

    with patch.object(
        services.imagegen_runtime_config,
        "replace",
        new=AsyncMock(side_effect=OSError("database is read-only")),
    ):
        result = await AdminService(services, Keystore()).dispatch(
            "keeper",
            "arkham",
            {
                "type": "admin_set_imagegen",
                "provider": "openai",
                "model": "gpt-image-1",
                "api_key": "sk-image",
            },
            get_i18n("en"),
        )

    assert result["type"] == "admin_error"
    assert result["code"] == "set_failed"
    assert services.settings.imagegen is not original_settings
    assert services.settings.imagegen.provider == "openai"
    assert services.settings.imagegen.model == "gpt-image-1"
    assert services.imagegen is not original_client
    assert await services.imagegen_runtime_config.get() == {}


async def test_admin_list_models_returns_the_providers_live_catalog():
    """`admin_list_models` answers with the provider's model IDs (the live /models fetch is
    stubbed here so the test stays offline)."""
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)

    async def _fake_list_models(_llm):
        return ["alpha-1", "beta-2"]

    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")
        with patch("net.admin.list_models", new=_fake_list_models):
            reply = await _send(ws, {"type": "admin_list_models", "provider": "deepseek", "api_key": "sk-x"})
        assert reply["type"] == "admin_models"
        assert reply["provider"] == "deepseek"
        assert reply["models"] == ["alpha-1", "beta-2"]

        # an unknown provider is refused, not queried.
        bad = await _send(ws, {"type": "admin_list_models", "provider": "nope-9000"})
        assert bad["type"] == "admin_error"
        assert bad["code"] == "unknown_provider"

        await ws.close()
    finally:
        await server.close()


async def test_admin_list_rules_returns_the_built_in_systems():
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

        reply = await _send(ws, {"type": "admin_list_rules"})
        assert reply["type"] == "admin_rules"
        by_id = {system["id"]: system["built_in"] for system in reply["systems"]}
        assert by_id.get("coc7") is True
        assert by_id.get("dnd5e") is True

        await ws.close()
    finally:
        await server.close()


async def test_admin_list_skills_reflects_the_callers_room_and_enable_toggles_it():
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("arkham")
    await set_enabled_skills(services.store, chat_key, ["romance-relationships"])
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

        listed = await _send(ws, {"type": "admin_list_skills"})
        assert listed["type"] == "admin_skills"
        by_id = {skill["id"]: skill for skill in listed["skills"]}
        assert "mature-mode" in by_id and "romance-relationships" in by_id
        # enabled reflects THIS room's store flag, set above for romance-relationships only.
        assert by_id["romance-relationships"]["enabled"] is True
        assert by_id["mature-mode"]["enabled"] is False
        assert by_id["mature-mode"]["content_rating"] == "explicit"
        assert by_id["mature-mode"]["name"]
        assert by_id["mature-mode"]["description"]

        # toggling ON another skill leaves the first one enabled and a follow-up admin_skills
        # reflects both.
        enabled = await _send(ws, {"type": "admin_enable_skill", "id": "mature-mode", "on": True})
        assert enabled["type"] == "admin_skills"
        by_id = {skill["id"]: skill for skill in enabled["skills"]}
        assert by_id["mature-mode"]["enabled"] is True
        assert by_id["romance-relationships"]["enabled"] is True
        assert set(await get_enabled_skills(services.store, chat_key)) == {"romance-relationships", "mature-mode"}

        # toggling it back off removes it and nothing else.
        disabled = await _send(ws, {"type": "admin_enable_skill", "id": "mature-mode", "on": False})
        by_id = {skill["id"]: skill for skill in disabled["skills"]}
        assert by_id["mature-mode"]["enabled"] is False
        assert by_id["romance-relationships"]["enabled"] is True
        assert await get_enabled_skills(services.store, chat_key) == ["romance-relationships"]

        # an unknown skill id is refused, not silently ignored.
        bad = await _send(ws, {"type": "admin_enable_skill", "id": "no-such-skill", "on": True})
        assert bad["type"] == "admin_error"
        assert bad["code"] == "bad_request"

        await ws.close()
    finally:
        await server.close()


async def test_admin_generate_authors_and_installs_skill_rule_and_module(tmp_path):
    """`admin_generate` for each `kind` runs the matching `agent.forge` engine end to end (a real
    `TuiServer` + FakeLLM-scripted responses, mirroring `tests/agent/test_forge*.py`'s fixtures),
    and a bogus `kind`/a blank `description` are refused as `admin_error{bad_request}`."""
    skill_dir = tmp_path / "skills"
    rulepack_dir = tmp_path / "rulepacks"
    module_dir = tmp_path / "modules"
    for directory in (skill_dir, rulepack_dir, module_dir):
        directory.mkdir()

    original_skill_dir = skills_module._USER_SKILL_DIR
    original_rulepack_dir = rulepacks_module._USER_RULEPACK_DIR
    original_module_dir = forge_module._USER_MODULE_DIR
    skills_module._USER_SKILL_DIR = skill_dir
    rulepacks_module._USER_RULEPACK_DIR = rulepack_dir
    forge_module._USER_MODULE_DIR = module_dir
    skills_module.reload_skills()
    rulepacks_module.reload_rulepacks()
    try:
        script = [
            assistant_text(_VALID_SKILL_MD),
            assistant_text(_VALID_RULEPACK_YAML),
            assistant_text(_GENERATED_MODULE_MD),
            assistant_text(_scripted_module_analysis_json()),
        ]
        settings = Settings(
            locale="en", data_dir=str(tmp_path), llm=LLMSettings(provider="openai", chat_model="gpt-4o")
        )
        services = build_services(settings, llm=FakeLLM(script=script), embeddings=FakeEmbeddings(64))
        keystore = Keystore()
        keeper_key = keystore.add(room="arkham", name="Keeper", role="keeper")
        server = TuiServer(services, keystore, port=0)
        url = await _start(server)
        try:
            ws, *_ = await _connect_and_join(url, keeper_key, "Keeper")

            skill_reply = await _send(
                ws, {"type": "admin_generate", "kind": "skill", "description": "a grim survival horror campaign"}
            )
            assert skill_reply["type"] == "admin_generated"
            assert skill_reply["kind"] == "skill"
            assert skill_reply["ok"] is True
            assert skill_reply["id"] == "grim-survival-horror"
            assert skill_reply["name"] == "Grim Survival Horror"
            assert skill_reply["error"] == ""

            rule_reply = await _send(
                ws, {"type": "admin_generate", "kind": "rule", "description": "a pulp adventure system"}
            )
            assert rule_reply["type"] == "admin_generated"
            assert rule_reply["ok"] is True
            assert rule_reply["id"] == "pulp-adventure"

            module_reply = await _send(
                ws, {"type": "admin_generate", "kind": "module", "description": "a marsh mystery"}
            )
            assert module_reply["type"] == "admin_generated"
            assert module_reply["ok"] is True
            assert module_reply["name"] == "The Salt Marsh Vanishing"
            # `detail` carries the per-room install outcome — the only signal (beyond `ok`) that the
            # module actually reached the room's knowledge pool. Present + non-empty for a module.
            assert module_reply["detail"]
            # skill/rule generation has no per-room install step, so their `detail` is empty.
            assert skill_reply["detail"] == ""
            assert rule_reply["detail"] == ""

            bogus = await _send(ws, {"type": "admin_generate", "kind": "bogus", "description": "x"})
            assert bogus["type"] == "admin_error"
            assert bogus["code"] == "bad_request"

            blank = await _send(ws, {"type": "admin_generate", "kind": "skill", "description": "   "})
            assert blank["type"] == "admin_error"
            assert blank["code"] == "bad_request"

            await ws.close()
        finally:
            await server.close()
    finally:
        skills_module._USER_SKILL_DIR = original_skill_dir
        rulepacks_module._USER_RULEPACK_DIR = original_rulepack_dir
        forge_module._USER_MODULE_DIR = original_module_dir
        skills_module.reload_skills()
        rulepacks_module.reload_rulepacks()
