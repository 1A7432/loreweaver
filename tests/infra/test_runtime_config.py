"""Tests for infra.runtime_config (RuntimeConfig persistence + apply_overrides)
and the infra.providers.MutableLLM runtime-swappable wrapper. All offline:
RuntimeConfig round-trips through an in-memory/temp-file Store and MutableLLM is
driven with a stub builder so no provider client is ever constructed."""

from __future__ import annotations

import asyncio

import pytest

from infra.config import LLMSettings, Settings
from infra.providers import MutableLLM
from infra.runtime_config import RuntimeConfig, apply_overrides
from infra.store import Store


def _settings(**llm) -> Settings:
    return Settings(llm=LLMSettings(**llm))


# ---------------------------------------------------------------------------
# apply_overrides — pure overlay
# ---------------------------------------------------------------------------


def test_apply_overrides_overlays_only_known_nonempty_fields_and_is_pure():
    base = _settings(provider="openai", chat_model="gpt-4o", api_key="env-key")

    out = apply_overrides(
        base,
        {"provider": "deepseek", "chat_model": "deepseek-chat", "bogus": "x", "base_url": ""},
    )

    assert out.llm.provider == "deepseek"
    assert out.llm.chat_model == "deepseek-chat"
    assert out.llm.api_key == "env-key"  # untouched (no override supplied)
    assert not hasattr(out.llm, "bogus")  # unknown key ignored
    # base is unchanged (pure)
    assert base.llm.provider == "openai"
    assert base.llm.chat_model == "gpt-4o"


def test_apply_overrides_empty_returns_independent_copy():
    base = _settings(provider="openai")

    out = apply_overrides(base, {})

    assert out is not base
    assert out.llm is not base.llm
    assert out.llm.provider == "openai"


# ---------------------------------------------------------------------------
# RuntimeConfig — Store round-trips
# ---------------------------------------------------------------------------


async def test_runtime_config_set_get_clear_roundtrip():
    store = Store(":memory:")
    rc = RuntimeConfig(store)
    assert await rc.get() == {}

    merged = await rc.set(provider="anthropic", chat_model="claude-x")
    assert merged == {"provider": "anthropic", "chat_model": "claude-x"}

    # a fresh instance over the same store observes the persisted value
    assert await RuntimeConfig(store).get() == {"provider": "anthropic", "chat_model": "claude-x"}

    # set merges rather than replaces
    await rc.set(api_key="sk-1")
    assert await rc.get() == {"provider": "anthropic", "chat_model": "claude-x", "api_key": "sk-1"}

    await rc.clear()
    assert await rc.get() == {}
    assert await RuntimeConfig(store).get() == {}


async def test_runtime_config_set_skips_empty_and_rejects_unknown_field():
    rc = RuntimeConfig(Store(":memory:"))

    assert await rc.set(provider="openai", chat_model="") == {"provider": "openai"}

    with pytest.raises(ValueError):
        await rc.set(temperature="0.5")  # not an OVERRIDE_FIELDS key


def test_runtime_config_load_sync_reads_persisted_file(tmp_path):
    db = tmp_path / "rc.db"
    store = Store(str(db))
    asyncio.run(RuntimeConfig(store).set(provider="deepseek", chat_model="deepseek-chat"))
    store.close()

    fresh = RuntimeConfig(Store(str(db)))
    assert fresh.load_sync() == {"provider": "deepseek", "chat_model": "deepseek-chat"}


def test_runtime_config_load_sync_is_empty_for_memory_and_missing_file(tmp_path):
    assert RuntimeConfig(Store(":memory:")).load_sync() == {}
    assert RuntimeConfig(Store(str(tmp_path / "absent.db"))).load_sync() == {}


# ---------------------------------------------------------------------------
# MutableLLM — runtime swap seen by all consumers (shared Settings mutated)
# ---------------------------------------------------------------------------


class _StubLLM:
    """A no-network LLMClient stand-in that records the settings it was built from."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def chat(self, *args, **kwargs):  # pragma: no cover - never invoked here
        raise AssertionError("chat should not be called in these tests")


def test_mutable_llm_reconfigure_swaps_inner_and_mutates_shared_settings():
    settings = _settings(provider="openai", chat_model="gpt-4o", api_key="sk-secretkey-123456")
    built: list[_StubLLM] = []

    def builder(s: Settings) -> _StubLLM:
        stub = _StubLLM(s)
        built.append(stub)
        return stub

    llm = MutableLLM(settings, builder=builder)
    first = llm.inner
    assert first is built[-1]

    llm.apply({"provider": "deepseek", "chat_model": "deepseek-chat"})

    assert llm.inner is not first  # inner client rebuilt
    # the SHARED settings object was mutated in place (module_init / actors see it)
    assert settings.llm.provider == "deepseek"
    assert settings.llm.chat_model == "deepseek-chat"

    info = llm.describe()
    assert info["provider"] == "deepseek"
    assert info["chat_model"] == "deepseek-chat"
    assert info["api_key"].startswith("sk-s") and info["api_key"].endswith("3456")
    assert "secretkey" not in info["api_key"]  # masked


def test_mutable_llm_apply_empty_reverts_to_pristine_baseline():
    settings = _settings(provider="openai", chat_model="gpt-4o")
    llm = MutableLLM(settings, builder=_StubLLM)

    llm.apply({"provider": "anthropic", "chat_model": "claude-x"})
    assert settings.llm.provider == "anthropic"

    llm.apply({})  # reset -> back to the env baseline captured at construction
    assert settings.llm.provider == "openai"
    assert settings.llm.chat_model == "gpt-4o"
