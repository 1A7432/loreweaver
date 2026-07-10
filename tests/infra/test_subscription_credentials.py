"""CredentialBook subscription fields + build_llm wiring (offline)."""

from __future__ import annotations

import asyncio
import time

import pytest

from infra.config import ImageGenSettings, LLMSettings, Settings
from infra.imagegen import OpenAICompatImageGen, build_imagegen
from infra.oauth_flows import XAI_API_BASE, OAuthError, SubscriptionToken
from infra.providers import build_llm, is_known_provider
from infra.runtime_config import CredentialBook
from infra.store import Store


async def test_credential_book_subscription_roundtrip_and_old_data():
    store = Store(":memory:")
    book = CredentialBook(store)

    # Old-style key-only entry still works.
    await book.remember("deepseek", api_key="sk-old", base_url="https://api.deepseek.com/v1")
    assert (await book.get("deepseek"))["api_key"] == "sk-old"

    token = SubscriptionToken(
        access_token="access-xyz",
        refresh_token="refresh-xyz",
        expires_at=time.time() + 3600,
        account_id="acc-1",
    )
    await book.save_subscription("chatgpt", token)
    loaded = await book.load_subscription("chatgpt")
    assert loaded is not None
    assert loaded.access_token == "access-xyz"
    assert loaded.account_id == "acc-1"
    # Alias shares canonical storage.
    assert await book.load_subscription("gpt-subscription") is not None

    providers = await book.providers()
    assert "chatgpt" in providers
    assert "deepseek" in providers

    await book.forget("chatgpt")
    assert await book.load_subscription("chatgpt") is None
    # deepseek untouched
    assert (await book.get("deepseek"))["api_key"] == "sk-old"


async def test_forget_subscription_preserves_independent_proxy_credentials():
    book = CredentialBook(Store(":memory:"))
    await book.save_subscription(
        "chatgpt",
        SubscriptionToken("access", "refresh", time.time() + 3600),
    )
    await book.remember(
        "chatgpt",
        api_key="sk-proxy",
        base_url="https://proxy.example/v1",
    )
    manager = book.subscription_manager_sync("chatgpt")
    assert manager is not None

    await book.forget_subscription("gpt-subscription")

    assert await book.load_subscription("chatgpt") is None
    assert await book.get("chatgpt") == {
        "api_key": "sk-proxy",
        "base_url": "https://proxy.example/v1",
    }
    with pytest.raises(OAuthError, match="subscription_login_required"):
        await manager.access_token()


async def test_save_subscription_drops_stale_static_key_and_proxy_url():
    book = CredentialBook(Store(":memory:"))
    await book.remember(
        "chatgpt",
        api_key="stale-static-key",
        base_url="https://stale-proxy.example/v1",
    )

    await book.save_subscription(
        "gpt-subscription",
        SubscriptionToken("access", "refresh", time.time() + 3600, "account"),
    )

    credential = await book.get("chatgpt")
    assert credential["access_token"] == "access"
    assert "api_key" not in credential
    assert "base_url" not in credential


async def test_credential_book_ignores_unknown_fields_on_load():
    store = Store(":memory:")
    # Manually write a blob with an unknown field.
    import json

    await store.set(
        user_key="",
        store_key="runtime_config.credentials",
        value=json.dumps({"openai": {"api_key": "sk-1", "mystery": "drop-me"}}),
    )
    book = CredentialBook(store)
    cred = await book.get("openai")
    assert cred == {"api_key": "sk-1"}
    assert "mystery" not in cred


def test_build_llm_chatgpt_without_login_raises(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", lambda **kw: None)
    with pytest.raises(ValueError, match="subscription_login_required"):
        build_llm(Settings(llm=LLMSettings(provider="chatgpt")))


def test_build_llm_chatgpt_proxy_still_works(monkeypatch):
    class _Fake:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    monkeypatch.setattr("infra.llm.AsyncOpenAI", _Fake)
    llm = build_llm(
        Settings(llm=LLMSettings(provider="chatgpt", api_key="sk", base_url="https://proxy.example/v1"))
    )
    from infra.llm import OpenAILLM

    assert isinstance(llm, OpenAILLM)
    assert llm._client.kwargs["base_url"] == "https://proxy.example/v1"


async def test_build_llm_chatgpt_and_supergrok_with_subscription(monkeypatch):
    store = Store(":memory:")
    book = CredentialBook(store)
    token = SubscriptionToken(
        access_token="at",
        refresh_token="rt",
        expires_at=time.time() + 3600,
        account_id="acc",
    )
    await book.save_subscription("chatgpt", token)
    await book.save_subscription("supergrok", SubscriptionToken("gat", "grt", time.time() + 3600))

    from infra.llm import OpenAILLM
    from infra.llm_chatgpt import ChatGPTSubscriptionLLM

    class _Fake:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.api_key = kwargs.get("api_key")

    monkeypatch.setattr("infra.llm.AsyncOpenAI", _Fake)

    chatgpt = build_llm(Settings(llm=LLMSettings(provider="chatgpt", chat_model="gpt-5.4")), credentials=book)
    assert isinstance(chatgpt, ChatGPTSubscriptionLLM)

    supergrok = build_llm(
        Settings(llm=LLMSettings(provider="supergrok", chat_model="grok-4.3")),
        credentials=book,
    )
    assert isinstance(supergrok, OpenAILLM)
    assert supergrok._token_provider is not None
    assert is_known_provider("supergrok")


async def test_supergrok_llm_and_imagegen_share_manager_and_logout_invalidates_both(monkeypatch):
    store = Store(":memory:")
    book = CredentialBook(store)
    await book.save_subscription(
        "supergrok",
        SubscriptionToken("access", "refresh", time.time() + 3600),
    )

    class _Fake:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.api_key = kwargs.get("api_key")

    monkeypatch.setattr("infra.llm.AsyncOpenAI", _Fake)
    llm = build_llm(
        Settings(
            llm=LLMSettings(
                provider="supergrok",
                base_url="https://stale-proxy.example/v1",
            )
        ),
        credentials=book,
    )
    imagegen = build_imagegen(
        Settings(
            imagegen=ImageGenSettings(
                provider="supergrok",
                base_url="https://stale-proxy.example/v1",
            )
        ),
        llm_credentials=book,
    )

    from infra.llm import OpenAILLM

    assert isinstance(llm, OpenAILLM)
    assert isinstance(imagegen, OpenAICompatImageGen)
    assert llm._settings.base_url == XAI_API_BASE
    assert imagegen._settings.base_url == XAI_API_BASE
    assert llm._token_provider is not None
    assert imagegen._token_provider is not None
    assert llm._token_provider.__self__ is imagegen._token_provider.__self__

    await book.forget("supergrok")

    with pytest.raises(OAuthError, match="subscription_login_required"):
        await llm._token_provider()
    with pytest.raises(OAuthError, match="subscription_login_required"):
        await imagegen._token_provider()


async def test_forget_during_refresh_prevents_token_writeback(monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()

    class _ControlledFlow:
        async def start(self):
            raise NotImplementedError

        async def poll(self, login):
            raise NotImplementedError

        async def refresh(self, token):
            started.set()
            await release.wait()
            return SubscriptionToken("resurrected", token.refresh_token, time.time() + 3600)

    monkeypatch.setattr("infra.oauth_flows.flow_for", lambda _provider: _ControlledFlow())
    book = CredentialBook(Store(":memory:"))
    await book.save_subscription(
        "supergrok",
        SubscriptionToken("expired", "refresh", time.time() - 3600),
    )
    manager = book.subscription_manager_sync("supergrok")
    assert manager is not None

    refresh_task = asyncio.create_task(manager.access_token())
    await started.wait()
    await book.forget("supergrok")
    release.set()

    with pytest.raises(OAuthError, match="subscription_login_required"):
        await refresh_task
    assert await book.load_subscription("supergrok") is None
    assert book.subscription_manager_sync("supergrok") is None
