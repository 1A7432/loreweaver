"""Application wiring for offline-to-subscription hot switching and restart."""

from __future__ import annotations

import time

from agent.context import AgentCtx
from app import _app_services, _uses_demo_llm
from gateway.commands import CommandRouter
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import OpenAILLM
from infra.oauth_flows import SubscriptionToken
from infra.providers import MutableLLM


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
    assert not _uses_demo_llm(services)
    assert await services.llm.inner._token_provider() == "access-token"
    services.store.close()

    restarted = _app_services(settings(), embeddings=FakeEmbeddings(64))
    try:
        assert isinstance(restarted.llm, MutableLLM)
        assert isinstance(restarted.llm.inner, OpenAILLM)
        assert not _uses_demo_llm(restarted)
        assert restarted.settings.llm.provider == "supergrok"
        assert await restarted.llm.inner._token_provider() == "access-token"
    finally:
        restarted.store.close()
