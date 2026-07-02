import json
import re
from types import SimpleNamespace

from agent.context import AgentCtx
from agent.services import build_services
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
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
