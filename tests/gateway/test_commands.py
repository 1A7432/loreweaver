import re
from types import SimpleNamespace

from agent.context import AgentCtx
from agent.services import build_services
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from infra.providers import MutableLLM


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
    assert "侦查" in checked


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


async def test_model_show_and_list_are_open_to_everyone():
    services = _baseline_services()  # injected FakeLLM -> describe() falls back to settings
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", platform="discord", locale="en")

    shown = await router.dispatch(ctx, ".model")
    assert shown is not None
    assert "openai" in shown  # default provider
    assert "gpt-4o" in shown  # default chat model
    assert "none" in shown.casefold()  # no override active

    listed = await router.dispatch(ctx, ".model list")
    assert listed is not None
    assert "deepseek" in listed  # an OpenAI-compatible preset
    assert "anthropic" in listed and "gemini" in listed  # native providers


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
    assert await services.runtime_config.get() == {"provider": "deepseek", "chat_model": "deepseek-chat"}


async def test_model_set_rejects_unknown_provider():
    services = _mutable_services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:m", user_id="u1", locale="en")

    reply = await router.dispatch(ctx, ".model set nope-9000")

    assert reply is not None
    assert "nope-9000" in reply
    assert services.settings.llm.provider == "openai"  # unchanged


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


async def test_model_set_rolls_back_and_persists_nothing_when_the_provider_fails_to_build():
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
    # the live LLM was rolled back to a still-buildable client
    assert isinstance(services.llm.inner, FakeLLM)


class _BoomMutableLLM:
    """Stand-in for `MutableLLM` whose startup `apply()` rejects a specific bad
    override (a provider whose optional SDK/key is missing), proving that a
    poisoned persisted override does NOT crash `build_services()`."""

    def __init__(self, settings, *, builder=None):
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
