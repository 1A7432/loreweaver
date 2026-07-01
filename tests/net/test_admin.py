"""Tests for the keeper-gated admin surface over the WS wire (`net.admin`).

Like `tests/net/test_tui_server.py`, a real `TuiServer` is bound to an ephemeral
localhost port and driven by a real `websockets` client, so the v1.1 `admin_*`
frames are exercised end to end. The LLM is a `MutableLLM` wrapping an offline
`FakeLLM`, so `admin_set_model` genuinely hot-reconfigures (and the follow-up
`admin_config` reflects it) without any network — mirroring the `.model` tests.
"""

from __future__ import annotations

import json

from agent.services import build_services
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from infra.providers import MutableLLM
from net.keystore import Keystore
from net.tui_server import TuiServer
from tests.net.test_tui_server import _connect_and_join, _recv, _start


def _services():
    """Baseline services with a real `MutableLLM` (offline stub inner client) so
    the admin set-model path reconfigures live, exactly like `.model set`."""
    settings = Settings(locale="en", llm=LLMSettings(provider="openai", chat_model="gpt-4o"))
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

        # mint_key returns the fresh key ONCE in cleartext + a refreshed masked list.
        minted = await _send(
            ws, {"type": "admin_mint_key", "room": "dunwich", "name": "Player One", "role": "player"}
        )
        assert minted["type"] == "admin_keys"
        assert minted["minted"]["room"] == "dunwich"
        assert minted["minted"]["role"] == "player"
        new_key = minted["minted"]["key"]
        assert new_key and new_key != keeper_key
        # the new key really landed in the keystore, and the list now has both.
        assert keystore.get(new_key) is not None
        assert len(minted["keys"]) == 2
        assert all("..." in entry["key_masked"] or entry["key_masked"] == "" for entry in minted["keys"])

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
        {"type": "admin_set_model", "provider": "anthropic"},
        get_i18n("en"),
    )

    assert reply["type"] == "admin_error"
    assert reply["code"] == "set_failed"
    assert services.settings.llm.provider == "openai"  # unchanged
    assert await services.runtime_config.get() == {}  # not persisted
    assert isinstance(services.llm.inner, FakeLLM)  # live LLM rolled back
