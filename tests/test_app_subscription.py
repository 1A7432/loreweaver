"""Application wiring for offline-to-configured-LLM switching and restart."""

from __future__ import annotations

import time

from agent.context import AgentCtx
from app import _app_services, _uses_demo_llm
from gateway.commands import CommandRouter
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.llm import OpenAILLM
from infra.oauth_flows import SubscriptionToken
from infra.providers import MutableLLM
from net.admin import handle_admin_frame
from net.keystore import Keystore


class _OfflineProviderLLM:
    """Provider-shaped test client: records config and never opens a network client."""

    def __init__(self, settings) -> None:
        self.provider_settings = settings

    async def chat(self, *_args, **_kwargs):
        raise AssertionError("provider chat must not run in this wiring test")


async def test_app_model_screen_switches_demo_to_api_provider_and_restores_on_restart(
    tmp_path,
    monkeypatch,
):
    """The real TUI admin frame must replace Demo immediately and survive reboot."""
    db_path = str(tmp_path / "loreweaver.db")
    data_dir = str(tmp_path / "data")

    def settings() -> Settings:
        return Settings(
            _env_file=None,
            data_dir=data_dir,
            db_path=db_path,
            llm=LLMSettings(provider="openai", api_key="", chat_model="gpt-4o"),
        )

    # build_llm resolves this symbol at call time. Replacing it proves the test
    # cannot make a real provider request (or even construct an SDK client).
    monkeypatch.setattr("infra.providers.OpenAILLM", _OfflineProviderLLM)

    services = _app_services(settings(), embeddings=FakeEmbeddings(64))
    assert isinstance(services.llm, MutableLLM)
    assert services.llm.using_fallback is True
    assert _uses_demo_llm(services)

    response = await handle_admin_frame(
        services,
        Keystore(),
        "keeper",
        "arkham",
        {
            "type": "admin_set_model",
            "provider": "deepseek",
            "chat_model": "deepseek-chat",
            "api_key": "sk-offline-test",
        },
        get_i18n("en"),
    )

    assert response["type"] == "admin_config"
    assert response["provider"] == "deepseek"
    assert response["using_demo"] is False
    assert isinstance(services.llm.inner, _OfflineProviderLLM)
    assert services.llm.inner.provider_settings.provider == "deepseek"
    assert services.llm.inner.provider_settings.chat_model == "deepseek-chat"
    assert services.llm.inner.provider_settings.api_key == "sk-offline-test"
    assert services.llm.using_fallback is False
    assert not _uses_demo_llm(services)
    assert await services.runtime_config.get() == {
        "provider": "deepseek",
        "chat_model": "deepseek-chat",
        "api_key": "sk-offline-test",
        "base_url": "",
    }
    services.store.close()

    restarted = _app_services(settings(), embeddings=FakeEmbeddings(64))
    try:
        assert isinstance(restarted.llm, MutableLLM)
        assert isinstance(restarted.llm.inner, _OfflineProviderLLM)
        assert restarted.llm.using_fallback is False
        assert not _uses_demo_llm(restarted)
        assert restarted.settings.llm.provider == "deepseek"
        assert restarted.settings.llm.chat_model == "deepseek-chat"
        assert restarted.llm.inner.provider_settings.api_key == "sk-offline-test"
    finally:
        restarted.store.close()


async def test_app_demo_hot_switches_to_subscription_and_restores_on_restart(tmp_path):
    db_path = str(tmp_path / "loreweaver.db")
    data_dir = str(tmp_path / "data")

    def settings() -> Settings:
        return Settings(
            _env_file=None,
            data_dir=data_dir,
            db_path=db_path,
            llm=LLMSettings(provider="openai", api_key="", chat_model="gpt-4o"),
        )

    services = _app_services(settings(), embeddings=FakeEmbeddings(64))
    assert isinstance(services.llm, MutableLLM)
    assert services.llm.using_fallback is True
    assert _uses_demo_llm(services)

    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-token", "refresh-token", time.time() + 3600),
    )
    reply = await CommandRouter(services).dispatch(
        AgentCtx(chat_key="cli:dm:keeper", user_id="keeper", locale="en"),
        ".model set supergrok grok-4.3",
    )

    assert reply is not None and "supergrok" in reply
    assert isinstance(services.llm.inner, OpenAILLM)
    assert services.llm.using_fallback is False
    assert not _uses_demo_llm(services)
    assert await services.llm.inner._token_provider() == "access-token"
    services.store.close()

    restarted = _app_services(settings(), embeddings=FakeEmbeddings(64))
    try:
        assert isinstance(restarted.llm, MutableLLM)
        assert isinstance(restarted.llm.inner, OpenAILLM)
        assert restarted.llm.using_fallback is False
        assert not _uses_demo_llm(restarted)
        assert restarted.settings.llm.provider == "supergrok"
        assert await restarted.llm.inner._token_provider() == "access-token"
    finally:
        restarted.store.close()
