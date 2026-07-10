"""Tests for infra.runtime_config (RuntimeConfig persistence + apply_overrides)
and the infra.providers.MutableLLM runtime-swappable wrapper. All offline:
RuntimeConfig round-trips through an in-memory/temp-file Store and MutableLLM is
driven with a stub builder so no provider client is ever constructed."""

from __future__ import annotations

import asyncio

import pytest

from infra.config import ImageGenSettings, LLMSettings, Settings
from infra.imagegen import apply_imagegen_overrides
from infra.providers import MutableLLM
from infra.runtime_config import ImageGenRuntimeConfig, RuntimeConfig, apply_overrides
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


def test_apply_overrides_explicit_empty_clears_base_credentials():
    base = _settings(api_key="env-key", base_url="https://env.example/v1")

    out = apply_overrides(base, {"api_key": "", "base_url": ""})

    assert out.llm.api_key == ""
    assert out.llm.base_url == ""
    assert base.llm.api_key == "env-key"


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


async def test_runtime_config_replace_persists_complete_snapshot_with_empty_fields():
    store = Store(":memory:")
    rc = RuntimeConfig(store)
    await rc.set(provider="openai", api_key="old", base_url="https://old.example/v1")

    replaced = await rc.replace(provider="chatgpt", api_key="", base_url="")

    assert replaced == {"provider": "chatgpt", "api_key": "", "base_url": ""}
    assert await RuntimeConfig(store).get() == replaced
    # Legacy merge semantics remain: empty values are ignored and old fields stay.
    assert await rc.set(chat_model="", npc_model="npc-x") == {
        **replaced,
        "npc_model": "npc-x",
    }
    with pytest.raises(ValueError):
        await rc.replace(temperature="0.5")


async def test_imagegen_runtime_replace_and_overlay_preserve_explicit_empty_fields():
    store = Store(":memory:")
    rc = ImageGenRuntimeConfig(store)
    await rc.set(provider="openai", api_key="old", base_url="https://old.example/v1")

    replaced = await rc.replace(provider="supergrok", api_key="", base_url="")

    assert replaced == {"provider": "supergrok", "api_key": "", "base_url": ""}
    assert await ImageGenRuntimeConfig(store).get() == replaced
    base = Settings(
        imagegen=ImageGenSettings(
            provider="openai",
            api_key="env-key",
            base_url="https://env.example/v1",
        )
    )
    out = apply_imagegen_overrides(base, replaced)
    assert out.imagegen.provider == "supergrok"
    assert out.imagegen.api_key == ""
    assert out.imagegen.base_url == ""


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
