import asyncio
import json
import re
from types import SimpleNamespace

import pytest

from agent.context import AgentCtx
from agent.services import build_services
from core.character_manager import CharacterSheet
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.ops import get_enabled_skills
from gateway.rooms import (
    clear_keeper_binding,
    get_binding,
    get_keeper_binding,
    resolve_session_key,
    session_key_for_room,
    set_keeper_binding,
)
from gateway.session import SessionSource
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
from infra.providers import MutableLLM
from infra.runtime_config import CREDENTIALS_KEY, DEFAULT_KEY


def _services():
    return build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _baseline_settings() -> Settings:
    """A hermetic baseline (explicit init wins over any local `.env`) so the
    `.model` tests assert against known provider/model values."""
    return Settings(llm=LLMSettings(provider="openai", chat_model="gpt-4o"))


def _baseline_services():
    """Baseline services with an injected FakeLLM (non-swappable) for read-only checks."""
    return build_services(_baseline_settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _mutable_services():
    """Services wired with a real `MutableLLM` (offline stub inner client) so the
    `.model` command's live-reconfigure path is exercised without any network."""
    settings = _baseline_settings()
    llm = MutableLLM(settings, builder=lambda s: FakeLLM(script=[]))
    return build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))


def _total(text: str) -> int:
    matches = re.findall(r"=\s*(-?\d+)(?:\D*$|\n)", text)
    if matches:
        return int(matches[-1])
    numbers = re.findall(r"-?\d+", text)
    return int(numbers[-1])


def _assert_model_mutation_failed(reply: str | None, provider: str) -> None:
    assert reply is not None
    assert reply.startswith("Could not")
    assert provider in reply
    assert not any(
        marker in reply
        for marker in (
            "LLM switched",
            "Saved LLM override",
            "API key updated",
            "Logged out",
            "LLM override cleared",
        )
    )


async def test_en_commands_roll_inline_setcoc_make_and_check():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")

    seed_dice(10)
    rolled = await router.dispatch(ctx, "/roll 4d6kh3")
    assert rolled is not None
    assert "Roll:" in rolled
    assert _total(rolled) == 13

    seed_dice(2)
    inline = await router.dispatch(ctx, "attack [[1d20+5]] now")
    assert inline is not None
    assert "Inline" in inline
    assert _total(inline) == 7

    setcoc = await router.dispatch(ctx, "/setcoc 2")
    assert setcoc == "CoC rule set to 2."
    assert await services.store.get(user_key="", store_key="coc_rule.cli:dm:t") == "2"

    created = await router.dispatch(ctx, "/coc")
    assert created is not None
    assert "CoC" in created

    seed_dice(3)
    checked = await router.dispatch(ctx, "/check spot hidden")
    assert checked is not None
    assert "Check" in checked
    # The canonical key is 侦查, but the en locale renders the rulepack's
    # display name so no CJK leaks into an English table's dice lines.
    assert "Spot Hidden" in checked
    assert "侦查" not in checked


async def test_language_persists_room_locale_and_replies_in_new_language():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="discord:group:table", user_id="u1", locale="en")

    invalid = await router.dispatch(ctx, ".language fr")
    assert invalid == "Usage: .language en|zh"
    assert await services.store.get(user_key="", store_key=f"chat_locale.{ctx.chat_key}") is None

    changed = await router.dispatch(ctx, "/language zh")
    assert changed == "房间语言已切换为中文。"
    assert ctx.locale == "zh"
    assert await services.store.get(user_key="", store_key=f"chat_locale.{ctx.chat_key}") == "zh"

    changed_back = await router.dispatch(ctx, ".language en")
    assert changed_back == "Room language set to English."
    assert ctx.locale == "en"


async def test_zh_commands_roll_check_sheet_fullwidth_and_setcoc():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh")

    await router.dispatch(ctx, ".coc")

    seed_dice(10)
    rolled = await router.dispatch(ctx, ".r 3d6+2")
    assert rolled is not None
    assert "掷骰" in rolled
    assert _total(rolled) == 12

    seed_dice(4)
    checked = await router.dispatch(ctx, ".ra 侦查")
    assert checked is not None
    assert any(rank in checked for rank in ["大成功", "极难成功", "困难成功", "成功", "失败", "大失败"])

    seed_dice(4)
    hard = await router.dispatch(ctx, ".ra 困难侦查")
    assert hard is not None
    assert "有效 12" in hard

    changed = await router.dispatch(ctx, ".st 力量50")
    assert changed is not None
    assert "力量=50" in changed
    character = await services.characters.get_character("u1", "cli:dm:t")
    assert character.attributes["STR"] == 50

    seed_dice(10)
    fullwidth = await router.dispatch(ctx, "。r 3d6+2")
    assert fullwidth is not None
    assert _total(fullwidth) == 12

    setcoc = await router.dispatch(ctx, ".setcoc 2")
    assert setcoc == "CoC 房规已设为 2。"
    assert await services.store.get(user_key="", store_key="coc_rule.cli:dm:t") == "2"


async def test_both_dialects_use_same_roller_for_same_seed_and_expression():
    services = _services()
    router = CommandRouter(services)
    en = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")
    zh = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh")

    seed_dice(44)
    en_roll = await router.dispatch(en, "/roll 1d20+5")
    seed_dice(44)
    zh_roll = await router.dispatch(zh, ".r 1d20+5")

    assert en_roll is not None
    assert zh_roll is not None
    assert _total(en_roll) == _total(zh_roll)


async def test_initiative_subcommands_share_tracker_and_next_never_rolls():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:init-command", user_id="u1", locale="en")

    await router.dispatch(ctx, ".dnd Kael")
    from agent.kp_tools_mechanics import InitiativeTools

    tracker = InitiativeTools(services)
    await tracker.initiative_tracker(ctx, action="add", name="Goblin", initiative=16)
    await tracker.initiative_tracker(ctx, action="add", name="Kael", initiative=12)
    await tracker.initiative_tracker(ctx, action="add", name="Mage", initiative=8)

    shown = await router.dispatch_reply(ctx, ".init")
    assert shown is not None
    assert shown.events == ()
    assert "Goblin" in shown.text
    assert "round 1" in shown.text.casefold()

    advanced = await router.dispatch_reply(ctx, ".init next")
    assert advanced is not None
    assert advanced.events == ()
    assert "Kael" in advanced.text
    order = json.loads(
        await services.store.get(user_key="", store_key=f"initiative.{ctx.chat_key}") or "[]"
    )
    assert [entry["name"] for entry in order] == ["Kael", "Mage", "Goblin"]

    rolled = await router.dispatch_reply(ctx, ".init 1d20")
    assert rolled is not None
    assert len(rolled.events) == 1
    order_after_roll = json.loads(
        await services.store.get(user_key="", store_key=f"initiative.{ctx.chat_key}") or "[]"
    )
    assert order_after_roll == order

    cleared = await router.dispatch_reply(ctx, ".init clear")
    assert cleared is not None
    assert cleared.events == ()
    assert json.loads(
        await services.store.get(user_key="", store_key=f"initiative.{ctx.chat_key}") or "[]"
    ) == []


async def test_report_command_exports_summary_without_keeper_permission():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:report", user_id="player", locale="en")

    await services.battles.start_session(ctx.chat_key, "Report Command")
    await services.battles.add_player_action(ctx.chat_key, "player", "Nora", "checks the locked desk")
    await services.battles.add_key_event(ctx.chat_key, "A silver key was recovered")

    report = await router.dispatch(ctx, ".report")

    assert report is not None
    assert "Report Command" in report
    assert "Player Scores" in report
    assert "Full Session Log" not in report
    assert "checks the locked desk" not in report


async def test_report_detailed_command_exports_full_transcript():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:report-detailed", user_id="player", locale="en")

    await services.battles.start_session(ctx.chat_key, "Detailed Command")
    await services.battles.add_player_action(ctx.chat_key, "player", "Nora", "checks the locked desk")
    await services.battles.add_skill_check(ctx.chat_key, "player", "Nora", "Locksmith", 50, 21, "success")

    report = await router.dispatch(ctx, ".report detailed")

    assert report is not None
    assert "Detailed Command" in report
    assert "Full Session Log" in report
    assert "checks the locked desk" in report
    assert "Locksmith (target 50): rolled 21" in report


# ---------------------------------------------------------------------------
# .model — runtime LLM configuration command
# ---------------------------------------------------------------------------


async def test_model_list_is_public_but_model_show_requires_keeper():
    services = _baseline_services()  # injected FakeLLM -> describe() falls back to settings
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", platform="discord", locale="en")

    shown = await router.dispatch(ctx, ".model")
    assert shown == services.i18n.with_locale("en").t("commands.model.denied")

    listed = await router.dispatch(ctx, ".model list")
    assert listed is not None
    assert "deepseek" in listed  # an OpenAI-compatible preset
    assert "anthropic" in listed and "gemini" in listed  # native providers
    assert listed.count("supergrok") == 1  # subscription category only


async def test_model_set_reconfigures_live_and_persists():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")  # cli -> keeper

    reply = await router.dispatch(ctx, ".model set deepseek deepseek-chat")

    assert reply is not None
    assert "deepseek" in reply and "deepseek-chat" in reply
    # live reconfigure mutated the shared settings (module_init / actors see it)
    assert services.settings.llm.provider == "deepseek"
    assert services.settings.llm.chat_model == "deepseek-chat"
    # and it persisted for the next restart
    assert await services.runtime_config.get() == {
        "provider": "deepseek",
        "chat_model": "deepseek-chat",
        "api_key": "",
        "base_url": "",
    }


async def test_model_set_persistence_failure_keeps_applied_live_config(monkeypatch):
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    old_inner = services.llm.inner

    async def fail_runtime_write(user_key="", store_key="", value=None):
        if store_key == DEFAULT_KEY:
            raise OSError("runtime store unavailable after write")
        return await services.store.__class__.set(
            services.store, user_key=user_key, store_key=store_key, value=value
        )

    monkeypatch.setattr(services.store, "set", fail_runtime_write)
    reply = await router.dispatch(ctx, ".model set deepseek deepseek-chat")

    _assert_model_mutation_failed(reply, "deepseek")
    assert services.settings.llm.provider == "deepseek"
    assert services.settings.llm.chat_model == "deepseek-chat"
    assert services.llm.inner is not old_inner
    assert await services.runtime_config.load() == {}


async def test_model_set_rejects_unknown_provider():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    reply = await router.dispatch(ctx, ".model set nope-9000")

    assert reply is not None
    assert "nope-9000" in reply
    assert services.settings.llm.provider == "openai"  # unchanged


async def test_model_set_subscription_requires_login():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    reply = await router.dispatch(ctx, ".model set supergrok")
    assert reply is not None
    assert "login" in reply.casefold()
    assert services.settings.llm.provider == "openai"


async def test_model_set_supergrok_clears_previous_provider_credentials():
    import time

    from infra.oauth_flows import SubscriptionToken

    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    previous = {
        "provider": "deepseek",
        "chat_model": "deepseek-chat",
        "api_key": "sk-deepseek",
        "base_url": "https://old-provider.example/v1",
    }
    await services.runtime_config.replace(**previous)
    services.llm.apply(previous)
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )

    reply = await router.dispatch(ctx, ".model set supergrok")

    assert reply is not None and "supergrok" in reply
    assert await services.runtime_config.get() == {
        "provider": "supergrok",
        "chat_model": "grok-4.3",
        "api_key": "",
        "base_url": "",
    }
    assert services.settings.llm.api_key == ""
    assert services.settings.llm.base_url == ""


async def test_model_set_chatgpt_uses_only_its_saved_proxy_credentials():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    previous = {
        "provider": "deepseek",
        "chat_model": "deepseek-chat",
        "api_key": "sk-old",
        "base_url": "https://old-provider.example/v1",
    }
    await services.runtime_config.replace(**previous)
    services.llm.apply(previous)
    await services.llm_credentials.remember(
        "chatgpt",
        api_key="sk-chatgpt-proxy",
        base_url="https://chatgpt-proxy.example/v1",
    )

    reply = await router.dispatch(ctx, ".model set chatgpt proxy-model")

    assert reply is not None and "chatgpt" in reply
    assert await services.runtime_config.get() == {
        "provider": "chatgpt",
        "chat_model": "proxy-model",
        "api_key": "sk-chatgpt-proxy",
        "base_url": "https://chatgpt-proxy.example/v1",
    }


async def test_model_show_treats_chatgpt_with_base_url_as_proxy():
    settings = Settings(
        llm=LLMSettings(
            provider="chatgpt",
            chat_model="proxy-model",
            api_key="sk-proxy-secret",
            base_url="https://chatgpt-proxy.example/v1",
        )
    )
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    shown = await router.dispatch(ctx, ".model")

    assert shown is not None
    assert "sk-p" in shown and "cret" in shown
    assert "subscription not logged in" not in shown.casefold()


async def test_model_login_switches_current_chatgpt_proxy_to_oauth(monkeypatch):
    import asyncio
    import time

    from infra.llm_chatgpt import ChatGPTSubscriptionLLM
    from infra.oauth_flows import DeviceLogin, SubscriptionToken

    class _ImmediateFlow:
        async def start(self):
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code="OAUTH",
                poll_interval=1,
                expires_at=time.time() + 60,
            )

        async def poll(self, login):
            return SubscriptionToken("access-oauth", "refresh-oauth", time.time() + 3600)

        async def aclose(self):
            return None

    monkeypatch.setattr("gateway.commands.flow_for", lambda _provider: _ImmediateFlow())
    settings = Settings(
        llm=LLMSettings(
            provider="chatgpt",
            chat_model="proxy-model",
            api_key="sk-proxy-secret",
            base_url="https://chatgpt-proxy.example/v1",
        )
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    started = await router.dispatch(ctx, ".model login chatgpt")
    for _ in range(50):
        if isinstance(services.llm.inner, ChatGPTSubscriptionLLM):
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("ChatGPT proxy login did not switch to OAuth")

    assert started is not None and "OAUTH" in started
    assert services.settings.llm.provider == "chatgpt"
    assert services.settings.llm.api_key == ""
    assert services.settings.llm.base_url == ""
    assert await services.runtime_config.get() == {
        "provider": "chatgpt",
        "chat_model": "proxy-model",
        "api_key": "",
        "base_url": "",
    }
    shown = await router.dispatch(ctx, ".model")
    assert shown is not None and "subscription logged in" in shown.casefold()


async def test_subscription_proxy_switch_persistence_failure_keeps_live_oauth_switch(monkeypatch):
    from gateway.commands import _refresh_active_subscription_clients

    settings = Settings(
        llm=LLMSettings(
            provider="chatgpt",
            chat_model="proxy-model",
            api_key="sk-proxy-secret",
            base_url="https://chatgpt-proxy.example/v1",
        )
    )
    llm = MutableLLM(settings, builder=lambda _settings: FakeLLM(script=[]))
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))
    proxy_snapshot = {
        "provider": "chatgpt",
        "chat_model": "proxy-model",
        "api_key": "sk-proxy-secret",
        "base_url": "https://chatgpt-proxy.example/v1",
    }
    await services.runtime_config.replace(**proxy_snapshot)
    old_inner = services.llm.inner

    async def fail_runtime_write(user_key="", store_key="", value=None):
        if store_key == DEFAULT_KEY:
            raise OSError("runtime store unavailable after write")
        return await services.store.__class__.set(
            services.store, user_key=user_key, store_key=store_key, value=value
        )

    monkeypatch.setattr(services.store, "set", fail_runtime_write)
    with pytest.raises(OSError, match="runtime store unavailable after write"):
        await _refresh_active_subscription_clients(services, "chatgpt")

    assert services.llm.inner is not old_inner
    assert services.settings.llm.api_key == ""
    assert services.settings.llm.base_url == ""
    assert await services.runtime_config.load() == proxy_snapshot


async def test_model_logout_chatgpt_proxy_preserves_static_credentials():
    import time

    from infra.oauth_flows import SubscriptionToken

    settings = Settings(
        llm=LLMSettings(
            provider="chatgpt",
            chat_model="proxy-model",
            api_key="sk-proxy-secret",
            base_url="https://chatgpt-proxy.example/v1",
        )
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "chatgpt",
        SubscriptionToken("access-oauth", "refresh-oauth", time.time() + 3600),
    )
    await services.llm_credentials.remember(
        "chatgpt",
        api_key="sk-proxy-secret",
        base_url="https://chatgpt-proxy.example/v1",
    )

    logout = await router.dispatch(ctx, ".model logout chatgpt")

    assert logout is not None and "chatgpt" in logout
    assert await services.llm_credentials.load_subscription("chatgpt") is None
    credential = await services.llm_credentials.get("chatgpt")
    assert credential["api_key"] == "sk-proxy-secret"
    assert credential["base_url"] == "https://chatgpt-proxy.example/v1"
    assert services.settings.llm.api_key == "sk-proxy-secret"
    assert services.settings.llm.base_url == "https://chatgpt-proxy.example/v1"


async def test_model_logout_credential_write_failure_preserves_oauth_and_proxy_credential(monkeypatch):
    import time

    from infra.oauth_flows import SubscriptionToken

    settings = Settings(
        llm=LLMSettings(
            provider="chatgpt",
            chat_model="proxy-model",
            api_key="sk-proxy-secret",
            base_url="https://chatgpt-proxy.example/v1",
        )
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "chatgpt",
        SubscriptionToken("access-oauth", "refresh-oauth", time.time() + 3600),
    )
    await services.llm_credentials.remember(
        "chatgpt",
        api_key="sk-proxy-secret",
        base_url="https://chatgpt-proxy.example/v1",
    )
    async def fail_credential_write(user_key="", store_key="", value=None):
        if store_key == CREDENTIALS_KEY:
            raise OSError("credential store unavailable after delete")
        return await services.store.__class__.set(
            services.store, user_key=user_key, store_key=store_key, value=value
        )

    monkeypatch.setattr(services.store, "set", fail_credential_write)
    reply = await router.dispatch(ctx, ".model logout chatgpt")

    _assert_model_mutation_failed(reply, "chatgpt")
    credential = await services.llm_credentials.get("chatgpt")
    assert credential["access_token"] == "access-oauth"
    assert credential["refresh_token"] == "refresh-oauth"
    assert credential["api_key"] == "sk-proxy-secret"
    assert credential["base_url"] == "https://chatgpt-proxy.example/v1"
    persisted_book = json.loads(
        await services.store.get(user_key="", store_key=CREDENTIALS_KEY) or "{}"
    )
    assert persisted_book["chatgpt"] == credential
    assert services.settings.llm.api_key == "sk-proxy-secret"
    assert services.settings.llm.base_url == "https://chatgpt-proxy.example/v1"


async def test_model_login_supergrok_refreshes_explicit_imagegen_when_llm_is_other(monkeypatch):
    import asyncio
    import time

    from infra.config import ImageGenSettings
    from infra.oauth_flows import DeviceLogin, SubscriptionToken

    class _ImmediateFlow:
        async def start(self):
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code="IMAGE",
                poll_interval=1,
                expires_at=time.time() + 60,
            )

        async def poll(self, login):
            return SubscriptionToken("access-image", "refresh-image", time.time() + 3600)

        async def aclose(self):
            return None

    monkeypatch.setattr("gateway.commands.flow_for", lambda _provider: _ImmediateFlow())
    settings = Settings(
        llm=LLMSettings(provider="openai", chat_model="gpt-4o", api_key="sk-baseline"),
        imagegen=ImageGenSettings(provider="supergrok", model="grok-imagine-image"),
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    assert services.imagegen is None

    started = await router.dispatch(ctx, ".model login supergrok")
    for _ in range(50):
        if services.imagegen is not None:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("SuperGrok login did not refresh configured imagegen")

    assert started is not None and "IMAGE" in started
    assert services.settings.llm.provider == "openai"
    assert await services.runtime_config.get() == {}
    assert await services.imagegen._token_provider() == "access-image"


async def test_model_set_same_subscription_keeps_custom_model():
    import time

    from infra.oauth_flows import SubscriptionToken

    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )

    await router.dispatch(ctx, ".model set supergrok grok-custom")
    reply = await router.dispatch(ctx, ".model set supergrok")

    assert reply is not None
    assert services.settings.llm.chat_model == "grok-custom"
    assert (await services.runtime_config.get())["chat_model"] == "grok-custom"


async def test_model_logout_invalidates_active_clients_and_reverts_to_base_provider():
    import time

    from infra.oauth_flows import OAuthError, SubscriptionToken

    settings = Settings(
        llm=LLMSettings(provider="openai", chat_model="gpt-4o", api_key="sk-baseline")
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )
    services.settings.imagegen.provider = "supergrok"
    services.settings.imagegen.model = "grok-imagine-image"
    await router.dispatch(ctx, ".model set supergrok grok-custom")
    assert services.imagegen is not None
    old_inner = services.llm.inner

    rejected_key = await router.dispatch(ctx, ".model key sk-must-not-be-saved")
    assert rejected_key is not None and "login" in rejected_key.casefold()
    assert (await services.runtime_config.get())["api_key"] == ""
    assert "api_key" not in await services.llm_credentials.get("supergrok")

    logout = await router.dispatch(ctx, ".model logout supergrok")
    shown = await router.dispatch(ctx, ".model")

    assert logout is not None and "supergrok" in logout
    assert shown is not None and "provider openai" in shown.casefold()
    assert await services.llm_credentials.load_subscription("supergrok") is None
    assert await services.runtime_config.get() == {}
    assert services.settings.llm.provider == "openai"
    assert services.imagegen is None
    with pytest.raises(OAuthError, match="subscription_login_required"):
        await old_inner.chat([{"role": "user", "content": "hello"}])


async def test_model_logout_runtime_clear_failure_keeps_grant_but_live_is_reset(monkeypatch):
    import time

    from infra.oauth_flows import SubscriptionToken

    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )
    await router.dispatch(ctx, ".model set supergrok grok-custom")
    runtime_before = await services.runtime_config.get()
    old_inner = services.llm.inner

    async def fail_runtime_delete(user_key="", store_key=""):
        if store_key == DEFAULT_KEY:
            raise OSError("runtime store unavailable after delete")
        return await services.store.__class__.delete(
            services.store, user_key=user_key, store_key=store_key
        )

    monkeypatch.setattr(services.store, "delete", fail_runtime_delete)
    reply = await router.dispatch(ctx, ".model logout supergrok")

    _assert_model_mutation_failed(reply, "supergrok")
    assert await services.llm_credentials.load_subscription("supergrok") is not None
    assert await services.runtime_config.load() == runtime_before
    assert services.settings.llm.provider == "openai"
    assert services.settings.llm.chat_model == "gpt-4o"
    assert services.llm.inner is not old_inner


async def test_model_logout_credential_failure_keeps_completed_live_and_runtime_reset(monkeypatch):
    import time

    from infra.oauth_flows import SubscriptionToken

    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )
    await router.dispatch(ctx, ".model set supergrok grok-custom")

    async def fail_credential_write(user_key="", store_key="", value=None):
        if store_key == CREDENTIALS_KEY:
            raise OSError("credential store unavailable after delete")
        return await services.store.__class__.set(
            services.store, user_key=user_key, store_key=store_key, value=value
        )

    monkeypatch.setattr(services.store, "set", fail_credential_write)
    reply = await router.dispatch(ctx, ".model logout supergrok")

    _assert_model_mutation_failed(reply, "supergrok")
    assert await services.llm_credentials.load_subscription("supergrok") is not None
    persisted_book = json.loads(
        await services.store.get(user_key="", store_key=CREDENTIALS_KEY) or "{}"
    )
    assert persisted_book["supergrok"]["access_token"] == "access-secret"
    assert await services.runtime_config.load() == {}
    assert services.settings.llm.provider == "openai"
    assert services.settings.llm.chat_model == "gpt-4o"


async def test_model_logout_restart_keeps_base_provider_and_empty_override(tmp_path):
    import time

    from infra.oauth_flows import SubscriptionToken

    db = str(tmp_path / "state.db")
    baseline = LLMSettings(provider="openai", chat_model="gpt-4o", api_key="sk-baseline")
    services = build_services(Settings(llm=baseline), embeddings=FakeEmbeddings(64), db_path=db)
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )
    await router.dispatch(ctx, ".model set supergrok grok-custom")

    await router.dispatch(ctx, ".model logout supergrok")
    services.store.close()

    restarted = build_services(
        Settings(llm=LLMSettings(provider="openai", chat_model="gpt-4o", api_key="sk-baseline")),
        embeddings=FakeEmbeddings(64),
        db_path=db,
    )
    assert restarted.settings.llm.provider == "openai"
    assert await restarted.runtime_config.get() == {}
    restarted.store.close()


async def test_model_logout_does_not_crash_when_base_is_the_oauth_provider(tmp_path):
    import time

    from infra.oauth_flows import OAuthError, SubscriptionToken
    from infra.runtime_config import CredentialBook
    from infra.store import Store

    db = str(tmp_path / "oauth-base.db")
    seed_store = Store(db)
    await CredentialBook(seed_store).save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )
    seed_store.close()

    services = build_services(
        Settings(llm=LLMSettings(provider="supergrok", chat_model="grok-4.3")),
        embeddings=FakeEmbeddings(64),
        db_path=db,
    )
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    old_inner = services.llm.inner

    logout = await router.dispatch(ctx, ".model logout supergrok")
    shown = await router.dispatch(ctx, ".model")

    assert logout is not None and "supergrok" in logout
    assert shown is not None and "subscription not logged in" in shown.casefold()
    assert services.settings.llm.provider == "supergrok"
    assert await services.runtime_config.get() == {}
    assert await services.llm_credentials.load_subscription("supergrok") is None
    with pytest.raises(OAuthError, match="subscription_login_required"):
        await old_inner.chat([{"role": "user", "content": "hello"}])
    services.store.close()


async def test_model_relogin_hot_rebuilds_active_supergrok_clients(monkeypatch):
    import asyncio
    import time

    from infra.oauth_flows import DeviceLogin, OAuthError, SubscriptionToken

    class _ImmediateFlow:
        async def start(self):
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code="RELOGIN",
                poll_interval=1,
                expires_at=time.time() + 60,
            )

        async def poll(self, login):
            return SubscriptionToken("access-two", "refresh-two", time.time() + 3600)

        async def aclose(self):
            return None

    monkeypatch.setattr("gateway.commands.flow_for", lambda _provider: _ImmediateFlow())
    settings = Settings(
        llm=LLMSettings(provider="openai", chat_model="gpt-4o", api_key="sk-baseline")
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-one", "refresh-one", time.time() + 3600),
    )
    services.settings.imagegen.provider = "supergrok"
    services.settings.imagegen.model = "grok-imagine-image"
    await router.dispatch(ctx, ".model set supergrok grok-custom")
    old_llm = services.llm.inner
    old_imagegen = services.imagegen
    assert old_imagegen is not None

    started = await router.dispatch(ctx, ".model login supergrok")
    for _ in range(50):
        if services.llm.inner is not old_llm and services.imagegen is not old_imagegen:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("relogin did not rebuild active subscription clients")

    assert started is not None and "RELOGIN" in started
    assert await services.llm.inner._token_provider() == "access-two"
    assert await services.imagegen._token_provider() == "access-two"
    with pytest.raises(OAuthError, match="subscription_login_required"):
        await old_llm._token_provider()

    # A later relogin must not replace or implicitly enable an unrelated image
    # provider merely because the active LLM is SuperGrok.
    from infra.imagegen import FakeImageGen

    unrelated_imagegen = FakeImageGen()
    services.settings.imagegen = services.settings.imagegen.model_copy(update={"provider": "openai"})
    services.imagegen = unrelated_imagegen
    previous_llm = services.llm.inner
    await router.dispatch(ctx, ".model login supergrok")
    for _ in range(50):
        if services.llm.inner is not previous_llm:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("second relogin did not rebuild the active LLM")
    assert services.imagegen is unrelated_imagegen


async def test_model_relogin_refresh_failure_keeps_new_grant_and_rebuilt_clients(monkeypatch):
    import asyncio
    import time

    import gateway.commands as commands_module
    from infra.oauth_flows import DeviceLogin, OAuthError, SubscriptionToken

    class _ImmediateFlow:
        async def start(self):
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code="REFRESH",
                poll_interval=1,
                expires_at=time.time() + 60,
            )

        async def poll(self, _login):
            return SubscriptionToken("access-new", "refresh-new", time.time() + 7200)

        async def aclose(self):
            return None

    monkeypatch.setattr(commands_module, "flow_for", lambda _provider: _ImmediateFlow())
    settings = Settings(
        llm=LLMSettings(provider="openai", chat_model="gpt-4o", api_key="sk-baseline")
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-old", "refresh-old", time.time() + 3600),
    )
    services.settings.imagegen.provider = "supergrok"
    services.settings.imagegen.model = "grok-imagine-image"
    await router.dispatch(ctx, ".model set supergrok grok-custom")
    runtime_before = await services.runtime_config.get()
    old_llm = services.llm.inner
    old_imagegen = services.imagegen
    assert old_imagegen is not None
    original_refresh = commands_module._refresh_active_subscription_clients

    async def refresh_then_fail(target_services, canonical):
        await original_refresh(target_services, canonical)
        raise OSError("refresh failed after replacing clients")

    monkeypatch.setattr(
        commands_module,
        "_refresh_active_subscription_clients",
        refresh_then_fail,
    )
    started = await router.dispatch(ctx, ".model login supergrok")
    session = services._subscription_logins["supergrok"]
    await asyncio.wait_for(session["task"], timeout=1.0)

    assert started is not None and "REFRESH" in started
    assert session["done"] is True
    assert session["error"] == "subscription_poll_failed"
    assert session.get("token_ok") is not True
    installed = await services.llm_credentials.load_subscription("supergrok")
    assert installed is not None
    assert installed.access_token == "access-new"
    assert installed.refresh_token == "refresh-new"
    persisted_book = json.loads(
        await services.store.get(user_key="", store_key=CREDENTIALS_KEY) or "{}"
    )
    assert persisted_book["supergrok"]["access_token"] == "access-new"
    assert await services.runtime_config.load() == runtime_before
    assert services.llm.inner is not old_llm
    assert services.imagegen is not old_imagegen
    assert await services.llm.inner._token_provider() == "access-new"
    assert await services.imagegen._token_provider() == "access-new"
    with pytest.raises(OAuthError, match="subscription_login_required"):
        await old_llm._token_provider()
    with pytest.raises(OAuthError, match="subscription_login_required"):
        await old_imagegen._token_provider()


async def test_model_first_proxy_login_persistence_failure_keeps_new_oauth_state(monkeypatch):
    import asyncio
    import time

    import gateway.commands as commands_module
    from infra.oauth_flows import DeviceLogin, SubscriptionToken

    class _ImmediateFlow:
        async def start(self):
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code="PROXY",
                poll_interval=1,
                expires_at=time.time() + 60,
            )

        async def poll(self, _login):
            return SubscriptionToken("access-new", "refresh-new", time.time() + 3600)

        async def aclose(self):
            return None

    monkeypatch.setattr(commands_module, "flow_for", lambda _provider: _ImmediateFlow())
    settings = Settings(
        llm=LLMSettings(
            provider="chatgpt",
            chat_model="proxy-model",
            api_key="sk-proxy-secret",
            base_url="https://chatgpt-proxy.example/v1",
        )
    )
    services = build_services(settings, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    proxy_snapshot = {
        "provider": "chatgpt",
        "chat_model": "proxy-model",
        "api_key": "sk-proxy-secret",
        "base_url": "https://chatgpt-proxy.example/v1",
    }
    await services.runtime_config.replace(**proxy_snapshot)
    await services.llm_credentials.replace_static(
        "chatgpt",
        api_key="sk-proxy-secret",
        base_url="https://chatgpt-proxy.example/v1",
    )
    old_inner = services.llm.inner

    async def fail_runtime_write(user_key="", store_key="", value=None):
        if store_key == DEFAULT_KEY:
            raise OSError("runtime store unavailable after write")
        return await services.store.__class__.set(
            services.store, user_key=user_key, store_key=store_key, value=value
        )

    monkeypatch.setattr(services.store, "set", fail_runtime_write)
    started = await router.dispatch(ctx, ".model login chatgpt")
    session = services._subscription_logins["chatgpt"]
    await asyncio.wait_for(session["task"], timeout=1.0)

    assert started is not None and "PROXY" in started
    assert session["error"] == "subscription_poll_failed"
    assert session.get("token_ok") is not True
    installed = await services.llm_credentials.load_subscription("chatgpt")
    assert installed is not None
    assert installed.access_token == "access-new"
    assert installed.refresh_token == "refresh-new"
    credential = await services.llm_credentials.get("chatgpt")
    assert credential["access_token"] == "access-new"
    assert credential["refresh_token"] == "refresh-new"
    assert "api_key" not in credential
    assert "base_url" not in credential
    persisted_book = json.loads(
        await services.store.get(user_key="", store_key=CREDENTIALS_KEY) or "{}"
    )
    assert persisted_book["chatgpt"] == credential
    assert await services.runtime_config.load() == proxy_snapshot
    assert services.llm.inner is not old_inner
    assert services.settings.llm.provider == "chatgpt"
    assert services.settings.llm.api_key == ""
    assert services.settings.llm.base_url == ""


async def test_model_set_supergrok_does_not_implicitly_enable_imagegen():
    import time

    from infra.oauth_flows import SubscriptionToken

    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.save_subscription(
        "supergrok",
        SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600),
    )

    await router.dispatch(ctx, ".model set supergrok")

    assert services.settings.imagegen.provider == ""
    assert services.imagegen is None
    assert await services.imagegen_runtime_config.get() == {}


async def test_model_key_is_remembered_for_the_current_provider():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    reply = await router.dispatch(ctx, ".model key sk-provider-specific")

    assert reply is not None
    assert (await services.llm_credentials.get("openai"))["api_key"] == "sk-provider-specific"


async def test_model_key_build_failure_leaves_runtime_credential_and_live_unchanged():
    settings = _baseline_settings()

    def builder(candidate):
        if candidate.llm.api_key == "sk-rejected":
            raise ValueError("rejected key")
        return FakeLLM(script=[])

    services = build_services(
        settings,
        llm=MutableLLM(settings, builder=builder),
        embeddings=FakeEmbeddings(64),
    )
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    old_inner = services.llm.inner

    reply = await router.dispatch(ctx, ".model key sk-rejected")

    assert reply is not None and "openai" in reply
    assert services.llm.inner is old_inner
    assert services.settings.llm.api_key == ""
    assert await services.runtime_config.get() == {}
    assert await services.llm_credentials.get("openai") == {}


async def test_model_key_credential_failure_keeps_applied_live_key(monkeypatch):
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    old_inner = services.llm.inner

    async def fail_credential_write(user_key="", store_key="", value=None):
        if store_key == CREDENTIALS_KEY:
            raise OSError("credential store unavailable after write")
        return await services.store.__class__.set(
            services.store, user_key=user_key, store_key=store_key, value=value
        )

    monkeypatch.setattr(services.store, "set", fail_credential_write)
    reply = await router.dispatch(ctx, ".model key sk-not-saved")

    _assert_model_mutation_failed(reply, "openai")
    assert services.llm.inner is not old_inner
    assert services.settings.llm.api_key == "sk-not-saved"
    assert await services.runtime_config.get() == {}
    assert await services.llm_credentials.get("openai") == {}
    assert json.loads(
        await services.store.get(user_key="", store_key=CREDENTIALS_KEY) or "{}"
    ) == {}


async def test_model_key_runtime_failure_keeps_live_and_saved_credential(monkeypatch):
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await services.llm_credentials.replace_static(
        "openai",
        api_key="sk-previous",
        base_url="https://previous.example/v1",
    )
    old_inner = services.llm.inner

    async def fail_runtime_write(user_key="", store_key="", value=None):
        if store_key == DEFAULT_KEY:
            raise OSError("runtime store unavailable after write")
        return await services.store.__class__.set(
            services.store, user_key=user_key, store_key=store_key, value=value
        )

    monkeypatch.setattr(services.store, "set", fail_runtime_write)
    reply = await router.dispatch(ctx, ".model key sk-not-committed")

    _assert_model_mutation_failed(reply, "openai")
    assert services.llm.inner is not old_inner
    assert services.settings.llm.api_key == "sk-not-committed"
    assert await services.runtime_config.load() == {}
    assert await services.llm_credentials.get("openai") == {
        "api_key": "sk-not-committed",
    }


async def test_model_login_unexpected_poll_failure_allows_retry(monkeypatch):
    import asyncio
    import time

    from infra.oauth_flows import DeviceLogin

    class _BrokenFlow:
        def __init__(self, code):
            self.code = code

        async def start(self):
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code=self.code,
                poll_interval=1,
                expires_at=time.time() + 60,
            )

        async def poll(self, login):
            raise RuntimeError("malformed response")

        async def aclose(self):
            return None

    flows = iter([_BrokenFlow("FIRST"), _BrokenFlow("RETRY")])
    monkeypatch.setattr("gateway.commands.flow_for", lambda _provider: next(flows))
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    first = await router.dispatch(ctx, ".model login supergrok")
    await asyncio.sleep(0)
    retried = await router.dispatch(ctx, ".model login supergrok")
    await asyncio.sleep(0)

    assert first is not None and "FIRST" in first
    assert retried is not None and "RETRY" in retried


async def test_model_login_closes_flow_when_start_fails(monkeypatch):
    class _StartFailureFlow:
        def __init__(self):
            self.closed = False

        async def start(self):
            raise RuntimeError("network unavailable")

        async def aclose(self):
            self.closed = True

    flow = _StartFailureFlow()
    monkeypatch.setattr("gateway.commands.flow_for", lambda _provider: flow)
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    reply = await router.dispatch(ctx, ".model login supergrok")

    assert reply == services.i18n.with_locale("en").t("commands.model.login_failed")
    assert flow.closed is True


async def test_concurrent_model_login_starts_only_one_device_flow(monkeypatch):
    import asyncio
    import time

    from infra.oauth_flows import DeviceLogin

    start_entered = asyncio.Event()
    release_start = asyncio.Event()
    poll_forever = asyncio.Event()

    class _SlowFlow:
        def __init__(self):
            self.starts = 0

        async def start(self):
            self.starts += 1
            start_entered.set()
            await release_start.wait()
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code="ONLY-ONE",
                poll_interval=60,
                expires_at=time.time() + 600,
            )

        async def poll(self, _login):
            await poll_forever.wait()
            return None

        async def aclose(self):
            return None

    flow = _SlowFlow()
    monkeypatch.setattr("gateway.commands.flow_for", lambda _provider: flow)
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    first_task = asyncio.create_task(router.dispatch(ctx, ".model login supergrok"))
    await start_entered.wait()
    second_task = asyncio.create_task(router.dispatch(ctx, ".model login supergrok"))
    await asyncio.sleep(0)
    release_start.set()
    first, second = await asyncio.gather(first_task, second_task)

    assert flow.starts == 1
    assert first is not None and "ONLY-ONE" in first
    assert second is not None and "ONLY-ONE" in second
    await router.dispatch(ctx, ".model logout supergrok")


async def test_model_login_logout_and_set_with_mock_flow(monkeypatch):
    import time

    from infra.oauth_flows import DeviceLogin, SubscriptionToken

    class _FakeFlow:
        def __init__(self):
            self.polls = 0

        async def start(self):
            return DeviceLogin(
                verification_url="https://auth.example/device",
                user_code="ABCD",
                poll_interval=0.01,
                expires_at=time.time() + 60,
                state={"device_code": "dc"},
            )

        async def poll(self, login):
            self.polls += 1
            if self.polls < 2:
                return None
            return SubscriptionToken("access-secret", "refresh-secret", time.time() + 3600, account_id="")

        async def refresh(self, token):
            return token

        async def aclose(self):
            return None

    fake = _FakeFlow()
    monkeypatch.setattr("gateway.commands.flow_for", lambda _p: fake)

    services = _mutable_services()
    # Builder that accepts subscription providers once credentials exist.
    settings = services.settings

    def builder(s, credentials=None):
        provider = (s.llm.provider or "").lower()
        if provider in {"supergrok", "chatgpt", "gpt-subscription"}:
            if credentials is None or credentials.load_subscription_sync(provider) is None:
                raise ValueError("subscription_login_required")
        return FakeLLM(script=[])

    services.llm = MutableLLM(settings, builder=builder, credentials=services.llm_credentials)
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    started = await router.dispatch(ctx, ".model login supergrok")
    assert started is not None
    assert "https://auth.example/device" in started
    assert "ABCD" in started
    assert "access-secret" not in started
    assert "refresh-secret" not in started

    # Wait for background poll to finish.
    import asyncio

    for _ in range(100):
        sub = await services.llm_credentials.load_subscription("supergrok")
        if sub is not None:
            break
        await asyncio.sleep(0.02)
    else:
        raise AssertionError("login poll never saved subscription")

    assert sub.access_token == "access-secret"

    set_reply = await router.dispatch(ctx, ".model set supergrok grok-4.3")
    assert set_reply is not None
    assert "supergrok" in set_reply
    assert services.settings.llm.provider == "supergrok"

    logout = await router.dispatch(ctx, ".model logout supergrok")
    assert logout is not None
    assert "supergrok" in logout
    assert await services.llm_credentials.load_subscription("supergrok") is None


async def test_model_set_denied_for_non_admin():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="grp:public", user_id="u1", platform="discord", locale="en")  # EVERYONE

    reply = await router.dispatch(ctx, ".model set anthropic")

    assert reply is not None
    assert "admin" in reply.casefold() or "keeper" in reply.casefold()
    assert services.settings.llm.provider == "openai"  # not switched
    assert await services.runtime_config.get() == {}  # not persisted


async def test_model_reset_reverts_override():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    await router.dispatch(ctx, ".model set anthropic claude-x")
    assert services.settings.llm.provider == "anthropic"

    reply = await router.dispatch(ctx, ".model reset")

    assert reply is not None
    assert services.settings.llm.provider == "openai"  # reverted to env baseline
    assert services.settings.llm.chat_model == "gpt-4o"
    assert await services.runtime_config.get() == {}  # override cleared


async def test_model_reset_clear_failure_keeps_live_reset_and_persisted_override(monkeypatch):
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await router.dispatch(ctx, ".model set deepseek deepseek-chat")
    runtime_before = await services.runtime_config.get()
    old_inner = services.llm.inner

    async def fail_runtime_delete(user_key="", store_key=""):
        if store_key == DEFAULT_KEY:
            raise OSError("runtime store unavailable after delete")
        return await services.store.__class__.delete(
            services.store, user_key=user_key, store_key=store_key
        )

    monkeypatch.setattr(services.store, "delete", fail_runtime_delete)
    reply = await router.dispatch(ctx, ".model reset")

    _assert_model_mutation_failed(reply, "deepseek")
    assert services.settings.llm.provider == "openai"
    assert services.settings.llm.chat_model == "gpt-4o"
    assert services.llm.inner is not old_inner
    assert await services.runtime_config.load() == runtime_before


async def test_model_reset_build_failure_does_not_clear_persisted_override(monkeypatch):
    import gateway.commands as commands_module

    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    await router.dispatch(ctx, ".model set deepseek deepseek-chat")
    runtime_before = await services.runtime_config.get()
    old_inner = services.llm.inner
    original_reconfigure = commands_module._reconfigure_llm

    def reject_reset(target_services, overrides):
        if not overrides:
            raise ValueError("base provider unavailable")
        return original_reconfigure(target_services, overrides)

    monkeypatch.setattr(commands_module, "_reconfigure_llm", reject_reset)
    reply = await router.dispatch(ctx, ".model reset")

    assert reply is not None and "deepseek" in reply
    assert services.settings.llm.provider == "deepseek"
    assert services.llm.inner is old_inner
    assert await services.runtime_config.get() == runtime_before


async def test_model_key_rejected_in_public_channel_but_accepted_in_dm():
    services = _mutable_services()
    router = CommandRouter(services)

    # keeper (admin marker) but a PUBLIC group channel -> refuse to echo a key there
    public = AgentCtx(
        chat_key="grp:public",
        user_id="u1",
        platform="discord",
        locale="en",
        extra={"raw": {"is_admin": True}, "source": SimpleNamespace(chat_type="group")},
    )
    refused = await router.dispatch(public, ".model key sk-supersecret-value-9999")
    assert refused is not None
    assert "sk-supersecret" not in refused  # never echoed in public
    assert await services.runtime_config.get() == {}  # not persisted

    # local CLI (private) -> accepted, echoed masked
    cli = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")
    accepted = await router.dispatch(cli, ".model key sk-supersecret-value-9999")
    assert accepted is not None
    assert "sk-supersecret-value-9999" not in accepted  # masked, never echoed in full
    assert "sk-s" in accepted and "9999" in accepted  # masked form
    assert (await services.runtime_config.get())["api_key"] == "sk-supersecret-value-9999"


# ---------------------------------------------------------------------------
# Privilege-escalation regression — `tui` is a MULTI-USER network service
# (`net/tui_server.py`), unlike the single-local-operator `cli`. Its privilege
# must come from the AUTHENTICATED keystore role stamped into `ctx.extra["role"]`
# (`TuiServer._ctx_for`), never be assumed from the platform name alone (see
# `gateway.commands._privilege_level`). A player-role `tui` connection must be
# denied every keeper-only dot-command; a keeper-role one is allowed; `cli`
# keeps auto-master.
# ---------------------------------------------------------------------------


def _tui_ctx(role: str, *, room: str = "room1") -> AgentCtx:
    return AgentCtx(
        chat_key=f"tui:group:{room}", user_id="u1", platform="tui", locale="en", extra={"role": role}
    )


async def test_chat_dm_is_not_keeper_without_an_identity_binding():
    services = _mutable_services()
    router = CommandRouter(services)
    source = SessionSource(platform="discord", chat_type="dm", chat_id="u1", user_id="u1")
    ctx = AgentCtx(
        chat_key=source.chat_key(),
        user_id=source.user_key(),
        platform="discord",
        locale="en",
        extra={"source": source, "raw": {}},
    )

    denied = await router.dispatch(ctx, ".model set anthropic")

    assert denied == services.i18n.with_locale("en").t("commands.model.denied")
    assert services.settings.llm.provider == "openai"


async def test_chat_model_change_rechecks_binding_after_waiting_for_lock():
    services = _mutable_services()
    router = CommandRouter(services)
    source = SessionSource(
        platform="discord", chat_type="dm", chat_id="dm-keeper", user_id="keeper"
    )
    session_key = session_key_for_room("arkham")
    await set_keeper_binding(services.store, "discord", "keeper", "arkham")
    ctx = AgentCtx(
        chat_key=session_key,
        user_id=source.user_key(),
        platform="discord",
        locale="en",
        extra={"source": source, "raw": {}, "role": "keeper"},
    )
    await services.config_lock.acquire()
    task = asyncio.create_task(router.dispatch(ctx, ".model set deepseek"))
    await asyncio.sleep(0)
    await clear_keeper_binding(
        services.store, "discord", "keeper", expected_room="arkham"
    )
    services.config_lock.release()

    reply = await task

    assert reply == services.i18n.with_locale("en").t("commands.model.denied")
    assert services.settings.llm.provider == "openai"
    assert await services.runtime_config.get() == {}


async def test_tui_player_role_is_denied_keeper_only_commands():
    from net.keystore import Keystore

    services = _mutable_services()
    router = CommandRouter(services, keystore=Keystore())
    player = _tui_ctx("player")
    i18n = services.i18n.with_locale("en")

    denied = await router.dispatch(player, ".model set anthropic")
    assert denied == i18n.t("commands.model.denied")
    assert services.settings.llm.provider == "openai"  # unchanged
    assert await services.runtime_config.get() == {}  # not persisted

    denied_lore = await router.dispatch(player, ".lore query anything")
    assert denied_lore == i18n.t("worldbook.commands.lore.denied")

    denied_room = await router.dispatch(player, ".room open")
    assert denied_room == i18n.t("rooms.denied")


async def test_tui_keeper_role_is_allowed_keeper_only_commands():
    from net.keystore import Keystore

    services = _mutable_services()
    keystore = Keystore()
    router = CommandRouter(services, keystore=keystore)
    keeper = _tui_ctx("keeper")
    i18n = services.i18n.with_locale("en")

    allowed = await router.dispatch(keeper, ".model set anthropic")
    assert allowed != i18n.t("commands.model.denied")
    assert services.settings.llm.provider == "anthropic"

    allowed_lore = await router.dispatch(keeper, ".lore query")
    assert allowed_lore == i18n.t("worldbook.commands.lore.query_usage")  # reached the handler, not denied

    allowed_room = await router.dispatch(keeper, ".room open")
    assert allowed_room != i18n.t("rooms.denied")
    assert len(keystore) == 1  # a join key was minted


async def test_cli_ctx_is_still_auto_master_for_keeper_only_commands():
    from net.keystore import Keystore

    services = _mutable_services()
    keystore = Keystore()
    router = CommandRouter(services, keystore=keystore)
    cli = AgentCtx(chat_key="cli:dm:m", user_id="kp", locale="en")
    i18n = services.i18n.with_locale("en")

    allowed = await router.dispatch(cli, ".model set anthropic")
    assert allowed != i18n.t("commands.model.denied")
    assert services.settings.llm.provider == "anthropic"

    allowed_lore = await router.dispatch(cli, ".lore query")
    assert allowed_lore == i18n.t("worldbook.commands.lore.query_usage")

    allowed_room = await router.dispatch(cli, ".room open")
    assert allowed_room != i18n.t("rooms.denied")
    assert len(keystore) == 1


async def test_chat_keeper_bind_is_private_single_use_and_unbind_revokes_it():
    from net.keystore import Keystore

    services = _services()
    keystore = Keystore()
    token = keystore.add(room="arkham", role="keeper", purpose="chat_bind")
    router = CommandRouter(services, keystore=keystore)
    group_source = SessionSource(
        platform="discord", chat_type="group", chat_id="table", user_id="keeper-1"
    )
    group_ctx = AgentCtx(
        chat_key=group_source.chat_key(),
        user_id=group_source.user_key(),
        platform="discord",
        locale="en",
        extra={"source": group_source, "raw": {}},
    )

    private_only = await router.dispatch(group_ctx, f"/bind {token}")
    assert private_only == services.i18n.with_locale("en").t("commands.bind.private_only")
    assert keystore.get(token, purpose="chat_bind") is not None

    dm_source = SessionSource(
        platform="discord", chat_type="dm", chat_id="keeper-1", user_id="keeper-1"
    )
    dm_ctx = AgentCtx(
        chat_key=dm_source.chat_key(),
        user_id=dm_source.user_key(),
        platform="discord",
        locale="en",
        extra={"source": dm_source, "raw": {}},
    )
    bound = await router.dispatch(dm_ctx, f"/bind {token}")
    assert bound == services.i18n.with_locale("en").t("commands.bind.done", room="arkham")
    assert keystore.get(token, purpose=None) is None
    assert await get_binding(services.store, dm_source.chat_key()) is None
    assert await resolve_session_key(services.store, dm_source) == session_key_for_room("arkham")
    identity = await get_keeper_binding(services.store, "discord", "keeper-1")
    assert identity == "arkham"

    reused = await router.dispatch(dm_ctx, f"/bind {token}")
    assert reused == services.i18n.with_locale("en").t("commands.bind.invalid")

    unbound = await router.dispatch(dm_ctx, "/unbind")
    assert unbound == services.i18n.with_locale("en").t("commands.unbind.done", room="arkham")
    assert await get_keeper_binding(services.store, "discord", "keeper-1") is None
    assert await get_binding(services.store, dm_source.chat_key()) is None
    assert await resolve_session_key(services.store, dm_source) == dm_source.chat_key()


async def test_room_open_persists_a_key_that_survives_live_authorization(tmp_path):
    from net.keystore import Keystore, member_id_for_key

    services = _mutable_services()
    key_path = tmp_path / "keys.toml"
    keystore = Keystore.load(key_path)
    router = CommandRouter(services, keystore=keystore)
    cli = AgentCtx(chat_key="cli:dm:keeper", user_id="keeper", locale="en")

    reply = await router.dispatch(cli, ".room open")

    assert reply is not None
    reloaded = Keystore.load(key_path)
    [entry] = reloaded.entries()
    member_id = member_id_for_key(entry.key)
    authorized = reloaded.authorize_member(member_id, room=entry.room)
    assert authorized is not None
    assert await get_binding(services.store, cli.chat_key) == session_key_for_room(entry.room)


async def test_room_link_rejects_a_key_revoked_by_another_process(tmp_path):
    from net.keystore import Keystore

    services = _mutable_services()
    key_path = tmp_path / "keys.toml"
    keystore = Keystore.load(key_path)
    with keystore.persisted_mutation():
        token = keystore.add(room="shared-room", role="player")
    router = CommandRouter(services, keystore=keystore)

    external = Keystore.load(key_path)
    with external.persisted_mutation():
        assert external.remove(token)

    cli = AgentCtx(chat_key="cli:dm:keeper", user_id="keeper", locale="en")
    reply = await router.dispatch(cli, f".room link {token}")

    assert reply == services.i18n.with_locale("en").t("rooms.link.invalid_key")
    assert await get_binding(services.store, cli.chat_key) is None


async def test_roll_invalid_expression_returns_friendly_error_not_crash():
    """A malformed dice expression (e.g. a skill name typed at `.r`/`.rh`/`.rd`) must
    return a localized 'invalid expression' message, never raise a raw d20 error."""
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh")

    for bad in [".r 侦查", ".rh abc", ".rd 图书馆"]:
        reply = await router.dispatch(ctx, bad)
        assert reply is not None
        assert "无效" in reply

    ok = await router.dispatch(ctx, ".r 2d6+1")
    assert ok is not None and "2d6+1" in ok


# ---------------------------------------------------------------------------
# F1 — `.lore list` information isolation (a player must not even learn a
#      secret entry exists; a keeper still sees it).
# ---------------------------------------------------------------------------


async def test_lore_list_hides_secret_entries_from_players_but_shows_them_to_keepers():
    from core.worldbook import LoreEntry

    services = _services()
    router = CommandRouter(services)
    chat_key = "grp:lore"

    await services.worldbook.add(
        chat_key, LoreEntry(id="pub", title="Harbor Gate", content="The gate stands open.", keys=["gate"])
    )
    await services.worldbook.add(
        chat_key,
        LoreEntry(id="sec", title="Cult Safehouse", content="Hidden beneath the chapel.", keys=["chapel"], secret=True),
    )

    # A player (non-admin group member) sees only the public entry — not even the secret title.
    player = AgentCtx(
        chat_key=chat_key,
        user_id="player",
        platform="discord",
        locale="en",
        extra={"raw": {}, "source": SimpleNamespace(chat_type="group")},
    )
    player_view = await router.dispatch(player, ".lore list")
    assert player_view is not None
    assert "Harbor Gate" in player_view
    assert "Cult Safehouse" not in player_view  # RED LINE

    # The keeper (local CLI operator) sees both.
    keeper = AgentCtx(chat_key=chat_key, user_id="kp", locale="en")  # cli default -> keeper
    keeper_view = await router.dispatch(keeper, ".lore list")
    assert keeper_view is not None
    assert "Harbor Gate" in keeper_view
    assert "Cult Safehouse" in keeper_view


# ---------------------------------------------------------------------------
# F2 — `.model set` reconfigures/validates BEFORE persisting: a provider whose
#      build fails leaves the old config active and persists nothing; a stored
#      bad override can't brick `build_services()` boot.
# ---------------------------------------------------------------------------


def _raising_builder(bad_provider: str):
    """A `MutableLLM` builder that fails for one provider (its SDK/key 'missing')
    but builds an offline `FakeLLM` for anything else."""

    def build(settings):
        if (settings.llm.provider or "").lower() == bad_provider:
            raise ValueError(f"{bad_provider} SDK missing")
        return FakeLLM(script=[])

    return build


async def test_model_set_build_failure_leaves_live_and_persisted_config_unchanged():
    settings = _baseline_settings()
    llm = MutableLLM(settings, builder=_raising_builder("anthropic"))
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")  # cli -> keeper

    reply = await router.dispatch(ctx, ".model set anthropic claude-3")

    assert reply is not None
    assert "anthropic" in reply  # localized failure notice naming the provider
    # old config still active, nothing persisted, no exception escaped
    assert services.settings.llm.provider == "openai"
    assert services.settings.llm.chat_model == "gpt-4o"
    assert await services.runtime_config.get() == {}
    # The failed candidate was never installed.
    assert isinstance(services.llm.inner, FakeLLM)


class _BoomMutableLLM:
    """Stand-in for `MutableLLM` whose startup `apply()` rejects a specific bad
    override (a provider whose optional SDK/key is missing), proving that a
    poisoned persisted override does NOT crash `build_services()`."""

    def __init__(self, settings, *, builder=None, credentials=None):
        self._settings = settings
        self.applied: list[dict] = []

    def apply(self, overrides):
        self.applied.append(dict(overrides))
        if overrides.get("provider") == "anthropic":
            raise ValueError("anthropic SDK missing")


async def test_build_services_survives_an_unusable_persisted_llm_override(tmp_path, monkeypatch):
    from infra.runtime_config import RuntimeConfig
    from infra.store import Store

    db = str(tmp_path / "state.db")
    await RuntimeConfig(Store(db)).set(provider="anthropic", chat_model="claude-x")
    monkeypatch.setattr("agent.services.MutableLLM", _BoomMutableLLM)

    # Must NOT raise even though the persisted override fails to build at startup.
    services = build_services(
        Settings(llm=LLMSettings(provider="openai", chat_model="gpt-4o")),
        embeddings=FakeEmbeddings(8),
        db_path=db,
    )

    assert isinstance(services.llm, _BoomMutableLLM)
    assert services.llm.applied[0] == {"provider": "anthropic", "chat_model": "claude-x"}  # attempted
    assert services.llm.applied[-1] == {}  # then rolled back to the pristine baseline


# ---------------------------------------------------------------------------
# F4/F5/F6 — malformed dice-ish input degrades to a localized notice, never a crash
# ---------------------------------------------------------------------------


async def test_inline_roll_on_ordinary_text_never_crashes_dispatch():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")

    handled = await router.dispatch(ctx, "I search the desk [[侦查]]")
    assert isinstance(handled, str)  # no raise
    assert "侦查" in handled  # localized invalid-expression notice

    seed_dice(2)
    valid = await router.dispatch(ctx, "I strike [[1d20+3]] now")
    assert valid is not None
    assert "Inline" in valid  # a valid inline expression still renders


async def test_sanity_command_with_non_numeric_loss_returns_a_notice_not_a_crash():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")
    await router.dispatch(ctx, ".coc")  # a CoC investigator to roll SAN for

    seed_dice(3)
    reply = await router.dispatch(ctx, ".sc 侦查/侦查")
    assert isinstance(reply, str)  # no crash
    assert "侦查" in reply  # localized invalid-expression notice


async def test_sheet_command_with_oversized_dice_expr_returns_a_notice_not_a_crash():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")
    await router.dispatch(ctx, ".coc")  # a CoC sheet to edit

    reply = await router.dispatch(ctx, ".st 力量+9999d6")
    assert isinstance(reply, str)  # no d20.TooManyRolls traceback
    assert "9999d6" in reply  # localized invalid-expression notice


async def test_sheet_command_clamps_values_through_rule_validation():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")
    await router.dispatch(ctx, ".coc")

    reply = await router.dispatch(ctx, ".st STR999")

    assert reply is not None
    assert "力量=90" in reply
    assert "attribute_above_max" in reply
    character = await services.characters.get_character("u1", "cli:dm:t")
    assert character.attributes["STR"] == 90


async def test_coc_st_luc_updates_attribute_and_removes_legacy_skill_value():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:coc-luck", user_id="u1", locale="en")
    await router.dispatch(ctx, ".coc Investigator")
    character = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    character.attributes["LUC"] = 37
    character.skills["LUC"] = 61
    await services.characters.save_character(ctx.user_id, ctx.chat_key, character)

    reply = await router.dispatch(ctx, ".st LUC80")

    updated = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    assert reply is not None and "幸运=80" in reply
    assert updated.attributes["LUC"] == 80
    assert "LUC" not in updated.skills


async def test_coc_st_migrates_legacy_luc_skill_on_the_next_sheet_write():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:coc-luck-migrate", user_id="u1", locale="en")
    await router.dispatch(ctx, ".coc Investigator")
    character = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    character.attributes["LUC"] = 37
    character.skills["LUC"] = 80
    await services.characters.save_character(ctx.user_id, ctx.chat_key, character)

    await router.dispatch(ctx, ".st STR50")

    updated = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    assert updated.attributes["LUC"] == 80
    assert "LUC" not in updated.skills


async def test_dnd_st_recomputes_persisted_skill_initiative_and_ac():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:dnd-derived", user_id="u1", locale="en")
    await services.characters.save_character("u1", ctx.chat_key, CharacterSheet("Fighter", "DnD5e"))

    await router.dispatch(ctx, ".st STR16 DEX14")

    character = await services.characters.get_character("u1", ctx.chat_key)
    assert character.skills["运动"] == 3
    assert character.skills["体操"] == 2
    assert character.skills["隐匿"] == 2
    assert character.secondary_attributes["先攻修正"] == 2
    assert character.secondary_attributes["护甲等级"] == 12
    assert "先攻修正" not in character.attributes
    assert "护甲等级" not in character.attributes


async def test_dnd_same_st_explicit_ac_override_wins_regardless_of_order():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:dnd-ac", user_id="u1", locale="en")
    await services.characters.save_character("u1", ctx.chat_key, CharacterSheet("Fighter", "DnD5e"))

    await router.dispatch(ctx, ".st AC18 STR16 DEX14")

    character = await services.characters.get_character("u1", ctx.chat_key)
    assert character.secondary_attributes["护甲等级"] == 18
    assert character.secondary_attributes["先攻修正"] == 2


async def test_dnd_sheet_hp_edit_uses_authoritative_current_and_max_fields():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:dnd-hp", user_id="u1", locale="en")
    await services.characters.save_character("u1", ctx.chat_key, CharacterSheet("Fighter", "DnD5e"))

    await router.dispatch(ctx, ".st HP12")
    raised = await services.characters.get_character("u1", ctx.chat_key)
    assert (raised.hp_current, raised.hp_max) == (12, 12)

    await router.dispatch(ctx, ".st HP-4")
    damaged = await services.characters.get_character("u1", ctx.chat_key)
    assert (damaged.hp_current, damaged.hp_max) == (8, 12)
    assert "生命值" not in damaged.secondary_attributes
    assert "生命值上限" not in damaged.secondary_attributes


async def test_dnd_auto_rolled_creation_does_not_render_point_buy_warning():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:dnd-create", user_id="u1", locale="en")
    seed_dice(1)

    reply = await router.dispatch(ctx, ".dnd Rolled Hero")

    assert reply is not None
    assert "point_buy" not in reply
    character = await services.characters.get_character("u1", ctx.chat_key)
    assert character.system == "DnD5e"


async def test_manual_create_flow_leaves_stale_vitals_until_finalize_word():
    """Mirrors the TUI manual-create flow (`CharacterScreen.submitManual`): `.coc`
    first creates a sheet from randomly-ROLLED (i.e. not the manually-chosen)
    characteristics -- deriving current HP/MP/SAN from those -- then `.st`
    overwrites the characteristics with the manually-chosen ones. `.st` validates
    with `initialize_vitals=False` (in-play EDIT semantics: preserve, never
    auto-heal), so without an explicit finalize step the finished character keeps
    the ROLLED-derived vitals instead of full HP/MP and starting SAN for the
    CHOSEN characteristics. The `.st finalize` / `.st 定稿` word re-derives them.
    """
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:manual", user_id="u1", locale="en")

    seed_dice(42)
    await router.dispatch(ctx, ".coc Manual")
    rolled = await services.characters.get_character("u1", "cli:dm:manual")
    assert (rolled.attributes["CON"], rolled.attributes["SIZ"], rolled.attributes["POW"]) == (55, 50, 15)
    assert rolled.attributes["HP"] == rolled.attributes["HPMAX"] == 10  # full HP for the rolled characteristics
    assert rolled.attributes["SAN"] == 15  # starting SAN = min(POW, SANMAX) for the rolled POW

    # Manual mode now overwrites the characteristics with the player's chosen ones.
    await router.dispatch(ctx, ".st CON90 SIZ90 POW90")
    stale = await services.characters.get_character("u1", "cli:dm:manual")
    assert (stale.attributes["HPMAX"], stale.attributes["MPMAX"], stale.attributes["SANMAX"]) == (18, 18, 99)
    # Bug: current HP/MP/SAN are still the OLD (rolled-characteristics) values --
    # `.st` preserved them instead of deriving from the chosen CON/SIZ/POW.
    assert (stale.attributes["HP"], stale.attributes["MP"], stale.attributes["SAN"]) == (10, 3, 15)

    reply = await router.dispatch(ctx, ".st finalize")
    assert reply is not None
    assert "Manual" in reply

    finalized = await services.characters.get_character("u1", "cli:dm:manual")
    assert finalized.attributes["HP"] == 18
    assert finalized.attributes["MP"] == 18
    assert finalized.attributes["SAN"] == 90  # min(POW=90, SANMAX=99)


async def test_sheet_finalize_word_is_locale_agnostic_and_localized_reply():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:manual_zh", user_id="u1", locale="zh")

    seed_dice(42)
    await router.dispatch(ctx, ".coc 小明")
    await router.dispatch(ctx, ".st 体质90 体型90 意志90")

    reply = await router.dispatch(ctx, ".st 定稿")
    assert reply is not None
    assert "小明" in reply
    character = await services.characters.get_character("u1", "cli:dm:manual_zh")
    assert character.attributes["HP"] == 18
    assert character.attributes["SAN"] == 90


async def test_genchar_command_builds_and_validates_sheet_from_description():
    services = build_services(
        Settings(),
        llm=FakeLLM(
            script=[
                assistant_text(
                    json.dumps(
                        {
                            "occupation": "Investigator",
                            "attribute_emphasis": ["INT", "EDU"],
                            "signature_skills": ["Library Use", "Occult"],
                            "backstory": "A meticulous cataloger of impossible books.",
                        }
                    )
                )
            ]
        ),
        embeddings=FakeEmbeddings(64),
    )
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:genchar", user_id="u1", locale="en")

    seed_dice(2028)
    reply = await router.dispatch(ctx, ".genchar coc7 Ada | A sharp-eyed scholar of forbidden lore.")

    assert reply is not None
    assert "Generated CoC character from description: Ada" in reply
    character = await services.characters.get_character("u1", "cli:dm:genchar")
    assert character.name == "Ada"
    assert character.system == "CoC"
    assert character.occupation == "Investigator"
    assert character.skills["图书馆"] >= 60
    assert character.attributes["SAN"] <= character.attributes["SANMAX"]


# ---------------------------------------------------------------------------
# `.botlist` — anti-loop bot-ignore list (`gateway.ops.Botlist`). The command
# mutates `router.botlist`, the SAME instance `GatewayRunner.on_inbound` (or any
# caller holding the router) consults, so a successful `.botlist add` takes
# effect immediately for that router's lifetime (see `gateway.runner`).
# ---------------------------------------------------------------------------


async def test_botlist_add_list_remove_via_command():
    services = _services()
    router = CommandRouter(services)
    cli = AgentCtx(chat_key="cli:dm:t", user_id="kp", locale="en")
    i18n = services.i18n.with_locale("en")

    empty = await router.dispatch(cli, ".botlist list")
    assert empty == i18n.t("commands.botlist.empty")

    added = await router.dispatch(cli, ".botlist add onebot:114514")
    assert added == i18n.t("commands.botlist.added", id="onebot:114514")
    assert router.botlist.is_bot("onebot:114514")  # visible to the runner's anti-loop gate

    shown = await router.dispatch(cli, ".botlist")
    assert shown == i18n.t("commands.botlist.show", ids="onebot:114514")

    removed = await router.dispatch(cli, ".botlist remove onebot:114514")
    assert removed == i18n.t("commands.botlist.removed", id="onebot:114514")
    assert not router.botlist.is_bot("onebot:114514")

    usage = await router.dispatch(cli, ".botlist add")
    assert usage == i18n.t("commands.botlist.usage")


async def test_botlist_command_denied_for_ordinary_group_member():
    services = _services()
    router = CommandRouter(services)
    source = SimpleNamespace(chat_type="group")
    player = AgentCtx(
        chat_key="discord:group:c-1",
        user_id="discord:u-1",
        platform="discord",
        locale="en",
        extra={"source": source, "raw": {}},
    )
    i18n = services.i18n.with_locale("en")

    denied = await router.dispatch(player, ".botlist add discord:evilbot")
    assert denied == i18n.t("rooms.denied")
    assert not router.botlist.is_bot("discord:evilbot")  # nothing mutated


async def test_botlist_zh_dialect_alias_adds_id():
    services = _services()
    router = CommandRouter(services)
    cli = AgentCtx(chat_key="cli:dm:t", user_id="kp", locale="zh")
    i18n = services.i18n.with_locale("zh")

    added = await router.dispatch(cli, "。机器人名单 add qq:888")
    assert added == i18n.t("commands.botlist.added", id="qq:888")
    assert router.botlist.is_bot("qq:888")


# ---------------------------------------------------------------------------
# `.skill` — per-room KP-skills layer (Layer B.1, `core.skills` +
# `gateway.ops.get/set_enabled_skills`). `list`/`status` are open to any
# player; `enable`/`disable` are keeper-gated, mirroring `.model`/`.lore`.
# Only relies on the real `skills/` directory containing `mature-mode`.
# ---------------------------------------------------------------------------


async def test_skill_list_shows_mature_mode_off_by_default():
    services = _services()
    router = CommandRouter(services)
    cli = AgentCtx(chat_key="cli:dm:skills-list", user_id="kp", locale="en")
    i18n = services.i18n.with_locale("en")

    shown = await router.dispatch(cli, "/skill list")
    assert shown is not None
    assert "mature-mode" in shown
    assert f"[{i18n.t('commands.skill.enabled_none')}]" in shown  # off by default

    bare = await router.dispatch(cli, "/skill")
    assert bare == shown  # bare `.skill` behaves exactly like `.skill list`


async def test_skill_status_reports_none_enabled_then_the_enabled_id():
    services = _services()
    router = CommandRouter(services)
    cli = AgentCtx(chat_key="cli:dm:skills-status", user_id="kp", locale="en")
    i18n = services.i18n.with_locale("en")

    before = await router.dispatch(cli, "/skill status")
    assert before == i18n.t("commands.skill.status", items=i18n.t("commands.skill.enabled_none"))

    await router.dispatch(cli, "/skill enable mature-mode")
    after = await router.dispatch(cli, "/skill status")
    assert after == i18n.t("commands.skill.status", items="mature-mode")


async def test_skill_enable_disable_via_command_updates_the_room_store():
    services = _services()
    router = CommandRouter(services)
    cli = AgentCtx(chat_key="cli:dm:skills-toggle", user_id="kp", locale="en")
    i18n = services.i18n.with_locale("en")

    assert await get_enabled_skills(services.store, cli.chat_key) == []

    enabled = await router.dispatch(cli, "/skill enable mature-mode")
    assert enabled == i18n.t("commands.skill.enable_done", id="mature-mode")
    assert await get_enabled_skills(services.store, cli.chat_key) == ["mature-mode"]

    disabled = await router.dispatch(cli, "/skill disable mature-mode")
    assert disabled == i18n.t("commands.skill.disable_done", id="mature-mode")
    assert await get_enabled_skills(services.store, cli.chat_key) == []


async def test_skill_enable_unknown_id_is_rejected():
    services = _services()
    router = CommandRouter(services)
    cli = AgentCtx(chat_key="cli:dm:skills-unknown", user_id="kp", locale="en")
    i18n = services.i18n.with_locale("en")

    result = await router.dispatch(cli, "/skill enable not-a-real-skill")
    assert result == i18n.t("commands.skill.unknown", id="not-a-real-skill")
    assert await get_enabled_skills(services.store, cli.chat_key) == []


async def test_skill_enable_disable_denied_for_ordinary_group_member_and_store_unchanged():
    services = _services()
    router = CommandRouter(services)
    source = SimpleNamespace(chat_type="group")
    player = AgentCtx(
        chat_key="discord:group:skills-1",
        user_id="discord:u-1",
        platform="discord",
        locale="en",
        extra={"source": source, "raw": {}},
    )
    i18n = services.i18n.with_locale("en")

    denied = await router.dispatch(player, ".skill enable mature-mode")
    assert denied == i18n.t("commands.skill.denied")
    assert await get_enabled_skills(services.store, player.chat_key) == []  # nothing mutated

    denied_off = await router.dispatch(player, ".skill disable mature-mode")
    assert denied_off == i18n.t("commands.skill.denied")

    # Viewing (list/status) is still open to the same non-keeper player.
    status = await router.dispatch(player, ".skill status")
    assert status == i18n.t("commands.skill.status", items=i18n.t("commands.skill.enabled_none"))
