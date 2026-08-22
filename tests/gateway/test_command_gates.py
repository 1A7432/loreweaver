"""Regression tests for the command-surface security fixes:

- `.rh` hidden rolls stay out of the player-facing `.report` (leak fix).
- `.bot on|off`, `.room link`, and the mutating `.party` subcommands are
  keeper-gated (a networked player can no longer mute the Keeper, hijack the
  channel's session binding, or mutate the companion roster / drive LLM spend).
- `.import <host path>` requires a keeper; an attachment-based import stays open.
- The avatar/imagegen command checks the keeper gate BEFORE consuming the shared
  rate-limit token, so a denied non-keeper cannot burn the room's quota.
- The router caps command-argument length so an oversized `.st` argument cannot
  stall the event loop via quadratic regex backtracking.

A networked player is modeled as `platform="tui", extra={"role": "player"}`; a
keeper as the trusted local `cli` platform (or `role="keeper"`), matching the
existing `_is_keeper` contract.
"""

import time

import pytest

from agent.context import AgentCtx
from agent.services import build_services
from core.character_manager import CharacterSheet
from core.dice_engine import seed_dice
from core.rulepacks import load_rulepack
from core.sheets import sheet_value
from gateway.commands import CommandRouter
from gateway.commands.sheet import _parse_sheet_assignments
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _services():
    return build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _player_ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="p1", platform="tui", locale="en", extra={"role": "player"})


def _keeper_ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="k1", platform="cli", locale="en")


def _denied(services) -> str:
    return services.i18n.with_locale("en").t("rooms.denied")


# ---------------------------------------------------------------------------
# Fix 1 — hidden rolls never leak into a player-facing report
# ---------------------------------------------------------------------------


async def test_hidden_roll_recorded_hidden_and_excluded_from_detailed_report():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:hidden", user_id="player", locale="en")

    seed_dice(4)
    await router.dispatch(ctx, ".r 2d6")  # public roll
    seed_dice(4)
    await router.dispatch(ctx, ".rh 1d100")  # hidden roll

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    hidden = [roll for roll in record.dice_rolls if roll.get("hidden")]
    visible = [roll for roll in record.dice_rolls if not roll.get("hidden")]
    assert len(hidden) == 1 and hidden[0]["expression"] == "1d100"
    assert len(visible) == 1 and visible[0]["expression"] == "2d6"

    report = await router.dispatch(ctx, ".report detailed")
    assert report is not None
    assert "2d6" in report  # public roll is in the transcript
    assert "1d100" not in report  # hidden roll must never be replayed


# ---------------------------------------------------------------------------
# Fix 2a — .bot on|off is keeper-gated; bare status stays open
# ---------------------------------------------------------------------------


async def test_bot_off_denied_for_player_and_does_not_mute_room():
    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:bot"
    ctx = _player_ctx(chat_key)

    reply = await router.dispatch(ctx, ".bot off")
    assert reply == _denied(services)
    # The room was NOT muted.
    assert await services.store.state_get(chat_key, "bot_enabled") is None


async def test_bot_status_query_open_but_keeper_can_toggle():
    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:bot2"

    status = await router.dispatch(_player_ctx(chat_key), ".bot")
    assert status == services.i18n.with_locale("en").t("commands.bot.status")

    keeper = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="en", extra={"role": "keeper"})
    toggled = await router.dispatch(keeper, ".bot off")
    assert toggled == services.i18n.with_locale("en").t("commands.bot.off")
    assert await services.store.state_get(chat_key, "bot_enabled") == "0"


# ---------------------------------------------------------------------------
# Fix 2a′ — .rule / .language writes are keeper-gated; the bare query stays open
# (room-wide state: coc_rule regrades every check, chat_locale flips every member's language)
# ---------------------------------------------------------------------------


async def test_rule_write_denied_for_player_but_query_open():
    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:coc"
    player = _player_ctx(chat_key)

    denied = await router.dispatch(player, ".rule 2")
    assert denied == _denied(services)
    # The room-wide ladder variant was NOT changed.
    assert (await services.store.get(user_key="", store_key=f"rule_variant.{chat_key}") or "") == ""
    # The bare query stays open to a player (reads, never writes).
    current = await router.dispatch(player, ".rule")
    assert current is not None and current.startswith(
        services.i18n.with_locale("en").t("commands.rule.current", rule="0")
    )
    assert (await services.store.get(user_key="", store_key=f"rule_variant.{chat_key}") or "") == ""


async def test_rule_keeper_can_still_set_the_ladder():
    services = _services()
    router = CommandRouter(services)
    chat_key = "cli:dm:coc"
    reply = await router.dispatch(_keeper_ctx(chat_key), ".rule 2")
    assert reply == services.i18n.with_locale("en").t("commands.rule.changed", rule="2")
    # The store keeps the full ladder-variant id; the reply shows the dialect form.
    assert await services.store.state_get(chat_key, "rule_variant") == "rule2"


async def test_language_write_denied_for_player_does_not_flip_room_locale():
    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:lang"
    reply = await router.dispatch(_player_ctx(chat_key), ".language zh")
    assert reply == _denied(services)
    assert await services.store.state_get(chat_key, "chat_locale") is None


async def test_language_keeper_can_still_set_room_locale():
    services = _services()
    router = CommandRouter(services)
    chat_key = "cli:dm:lang"
    reply = await router.dispatch(_keeper_ctx(chat_key), ".language zh")
    assert reply == services.i18n.with_locale("zh").t("commands.language.done")
    assert await services.store.state_get(chat_key, "chat_locale") == "zh"


# ---------------------------------------------------------------------------
# Fix 2b — .room link is keeper-gated (consistent with open/leave)
# ---------------------------------------------------------------------------


async def test_room_link_requires_keeper():
    services = _services()
    router = CommandRouter(services)
    ctx = _player_ctx("tui:group:room")

    reply = await router.dispatch(ctx, ".room link some-join-key")
    assert reply == _denied(services)
    # No binding was written for this channel.
    assert await services.store.get(user_key="", store_key="bound_room.tui:group:room") is None


async def test_room_link_keeper_passes_gate_then_rejects_bad_key():
    services = _services()
    router = CommandRouter(services)
    ctx = _keeper_ctx("cli:dm:room")

    # A keeper clears the gate and reaches _room_link, which (no keystore) rejects
    # the unknown token -- proving the gate let the keeper through.
    reply = await router.dispatch(ctx, ".room link some-join-key")
    assert reply == services.i18n.with_locale("en").t("rooms.link.invalid_key")


# ---------------------------------------------------------------------------
# Fix 2c — mutating .party subcommands are keeper-gated; bare list stays open
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("args", [".party add Bob", ".party remove Bob", ".party auto on", ".party act Bob"])
async def test_party_mutations_denied_for_player(args):
    services = _services()
    router = CommandRouter(services)
    reply = await router.dispatch(_player_ctx("tui:group:party"), args)
    assert reply == _denied(services)


async def test_party_bare_list_open_to_player():
    services = _services()
    router = CommandRouter(services)
    reply = await router.dispatch(_player_ctx("tui:group:party2"), ".party")
    assert reply is not None
    assert reply != _denied(services)


async def test_party_add_passes_gate_for_keeper():
    services = _services()
    router = CommandRouter(services)
    reply = await router.dispatch(_keeper_ctx("cli:dm:party"), ".party add Bob")
    # Whatever the companion tool returns, it must NOT be the keeper denial.
    assert reply is not None
    assert reply != _denied(services)


# ---------------------------------------------------------------------------
# Fix 3 — .import path arg requires keeper; attachment import stays open
# ---------------------------------------------------------------------------


async def test_import_raw_path_denied_for_player():
    services = _services()
    router = CommandRouter(services)
    reply = await router.dispatch(_player_ctx("tui:group:imp"), ".import /etc/passwd")
    assert reply == _denied(services)


async def test_import_raw_path_passes_gate_for_keeper():
    services = _services()
    router = CommandRouter(services)
    reply = await router.dispatch(_keeper_ctx("cli:dm:imp"), ".import /nonexistent/card.png")
    # The keeper clears the path gate and reaches the import tool (which then fails
    # to read the file); it must not be the keeper denial.
    assert reply is not None
    assert reply != _denied(services)


async def test_import_attachment_open_to_player():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(
        chat_key="tui:group:imp2",
        user_id="p1",
        platform="tui",
        locale="en",
        extra={"role": "player", "attachment_names": ["mycard.png"]},
    )
    reply = await router.dispatch(ctx, ".import")
    # An attachment-based self-import is reachable by a player (it then fails to read
    # the file / lacks fs), so the reply is anything BUT the keeper denial.
    assert reply is not None
    assert reply != _denied(services)


async def test_import_names_an_option_it_cannot_resolve_instead_of_dropping_it():
    """A system token that resolves to nothing used to be silently skipped — the card then
    imported under the DEFAULT system while the keeper believed the name had been honored."""
    services = _services()
    router = CommandRouter(services)
    reply = await router.dispatch(_keeper_ctx("cli:dm:imp3"), ".import /nonexistent/card.png coc7-nosuchpack pc")
    assert "coc7-nosuchpack" in reply
    assert reply == services.i18n.with_locale("en").t(
        "charcard.commands.import.unknown_option", option="coc7-nosuchpack"
    )


def _install_pack_card(data_dir, card: dict) -> str:
    """Drop a card file where `resolve_installed_path` finds it; return its pack ref."""
    import json as _json
    from pathlib import Path

    card_path = Path(data_dir) / "packs" / "harbour@1.0.0" / "cards" / "pregen.json"
    card_path.parent.mkdir(parents=True, exist_ok=True)
    card_path.write_text(_json.dumps(card, ensure_ascii=False), encoding="utf-8")
    return "harbour/cards/pregen.json"


async def test_import_pack_relative_pc_open_to_player(tmp_path):
    """Owner verdict (2026-08-17): a CONFINED pack-relative character import is not a
    server-filesystem read — a module that ships a PC card must be claimable without
    keeper ceremony. The card split still strips world machinery structurally."""
    from agent.context import LocalFs

    services = build_services(
        Settings(data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    router = CommandRouter(services)
    chat_key = "tui:group:packpc"
    ref = _install_pack_card(
        tmp_path / "data",
        {
            "name": "Harbour Pilot",
            "description": "A weathered pilot who knows every shoal.",
            "extensions": {"loreweaver_hooks": ["on('turn_start', () => {});"]},
        },
    )

    reply = await router.dispatch(
        AgentCtx(
            chat_key=chat_key,
            user_id="p1",
            platform="tui",
            locale="en",
            # Production parity: SessionCore hands every networked member a confined
            # LocalFs whose extra base is the data_dir (net/session.py `_ctx_for`).
            fs=LocalFs(str(tmp_path), extra_bases=(str(tmp_path / "data"),)),
            extra={"role": "player"},
        ),
        f".import {ref} pc",
    )

    assert reply is not None
    assert reply != _denied(services)
    assert "Harbour Pilot" in reply
    # The character half landed; the world machinery did not (card split).
    assert await services.store.state_get(chat_key, "room_hooks") is None


async def test_import_pack_relative_world_still_keeper_only(tmp_path):
    services = build_services(
        Settings(data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    router = CommandRouter(services)
    ref = _install_pack_card(tmp_path / "data", {"name": "W"})

    reply = await router.dispatch(
        AgentCtx(chat_key="tui:group:packworld", user_id="p1", platform="tui", locale="en", extra={"role": "player"}),
        f".import {ref} world",
    )

    assert reply == services.i18n.with_locale("en").t("charcard.commands.import.world_denied")


async def test_import_list_shows_installed_pack_refs_to_players(tmp_path):
    services = build_services(
        Settings(data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    router = CommandRouter(services)
    ref = _install_pack_card(tmp_path / "data", {"name": "Harbour Pilot"})

    reply = await router.dispatch(
        AgentCtx(chat_key="tui:group:packlist", user_id="p1", platform="tui", locale="en", extra={"role": "player"}),
        ".import list",
    )

    assert reply is not None and ref in reply


async def test_import_unresolvable_pack_ref_still_denied_for_player(tmp_path):
    """A pack-shaped ref that resolves to nothing falls back to being a host path —
    and a host path stays keeper-only."""
    services = build_services(
        Settings(data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    router = CommandRouter(services)

    reply = await router.dispatch(
        AgentCtx(chat_key="tui:group:packmiss", user_id="p1", platform="tui", locale="en", extra={"role": "player"}),
        ".import ghost-pack/cards/nope.json pc",
    )

    assert reply == _denied(services)


# ---------------------------------------------------------------------------
# Fix 4 — imagegen quota is not consumed before the keeper check
# ---------------------------------------------------------------------------


async def test_target_avatar_denied_does_not_consume_imagegen_quota(monkeypatch):
    services = _services()
    services.imagegen = object()  # non-None so the command proceeds past config checks

    calls = {"n": 0}

    def _spy_allow(_services, _chat_key):
        calls["n"] += 1
        return True

    async def _fake_target(_ctx, _target):
        return object()  # resolves as an existing NPC/companion target

    monkeypatch.setattr("gateway.commands.media.allow_imagegen_request", _spy_allow)
    monkeypatch.setattr("gateway.commands.media._resolve_avatar_target", _fake_target)

    router = CommandRouter(services)
    ctx = _player_ctx("tui:group:av")
    reply = await router.dispatch(ctx, ".avatar gen Goblin a fearsome portrait")

    assert reply == services.i18n.with_locale("en").t("commands.avatar.denied")
    assert calls["n"] == 0  # the shared rate-limit token was NOT burned


# ---------------------------------------------------------------------------
# Fix 5 — router argument-length cap + ReDoS-safe .st parsing
# ---------------------------------------------------------------------------


async def test_oversized_command_argument_is_rejected_fast():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:cap", user_id="u1", locale="en")

    payload = "a" * 20000  # the argument that used to backtrack for ~8s
    start = time.monotonic()
    reply = await router.dispatch(ctx, f".st {payload}")
    elapsed = time.monotonic() - start

    assert reply == services.i18n.with_locale("en").t("commands.error.too_long", limit=4000)
    assert elapsed < 1.0  # rejected at the router, never handed to the regex


async def test_reset_confirm_still_works_under_arg_cap(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:reset", user_id="u1", locale="en")

    armed = await router.dispatch(ctx, ".reset")
    assert armed is not None and "reset confirm" in armed
    done = await router.dispatch(ctx, ".reset confirm")
    assert done is not None and done.startswith("Reset complete")


def test_parse_sheet_assignments_is_linear_on_pathological_input():
    # A long run of non-matching characters must not blow up the assignment regex.
    payload = "力" * 8000
    start = time.monotonic()
    result = _parse_sheet_assignments(payload)
    elapsed = time.monotonic() - start
    assert result == []
    assert elapsed < 1.0


def test_parse_sheet_assignments_still_parses_valid_glued_pairs():
    assert _parse_sheet_assignments("STR16 DEX14") == [("STR", "set", "16"), ("DEX", "set", "14")]
    assert _parse_sheet_assignments("力量50，敏捷60") == [("力量", "set", "50"), ("敏捷", "set", "60")]
    assert _parse_sheet_assignments("HP-4") == [("HP", "sub", "4")]


# ---------------------------------------------------------------------------
# The explicit `.st NAME=VALUE` assignment form — the legacy scan has no syntax
# for an absolute negative and mis-splits a digit-bearing attribute name, both
# of which clients now reach by building `.st <wire-key> <n>` from pack keys.
# ---------------------------------------------------------------------------


def test_parse_sheet_assignments_explicit_form():
    assert _parse_sheet_assignments("STR=16 DEX=14") == [("STR", "set", "16"), ("DEX", "set", "14")]
    # A digit-bearing name survives: the legacy scan reads `skill2 30` as `skill`/`2`.
    assert _parse_sheet_assignments("skill2=30") == [("skill2", "set", "30")]
    # An ABSOLUTE negative — the whole point of the explicit form.
    assert _parse_sheet_assignments("mod=-3") == [("mod", "set", "-3")]
    assert _parse_sheet_assignments("HP-=4") == [("HP", "sub", "4")]
    assert _parse_sheet_assignments("HP+=1d6") == [("HP", "add", "1d6")]
    # A name may contain spaces: separators only split at a new `name<op>value` group.
    assert _parse_sheet_assignments("spot hidden=70") == [("spot hidden", "set", "70")]
    assert _parse_sheet_assignments("力量=60，敏捷=55") == [("力量", "set", "60"), ("敏捷", "set", "55")]


def test_parse_sheet_assignments_explicit_form_is_linear_on_pathological_input():
    # An `=` in the argument switches the scan to the explicit form; it must stay
    # as linear as the legacy one on a long run of non-matching characters.
    payload = "力" * 4000 + "=" + "力" * 4000
    start = time.monotonic()
    result = _parse_sheet_assignments(payload)
    elapsed = time.monotonic() - start
    assert result == []
    assert elapsed < 1.0


async def test_sheet_explicit_assignment_sets_absolutely_and_relatively(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:st-explicit", user_id="u1", locale="en")
    await router.dispatch(ctx, ".coc Investigator")

    assert await router.dispatch(ctx, ".st 力量=60") is not None
    character = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    assert character.attributes["STR"] == 60

    assert await router.dispatch(ctx, ".st 力量-=5") is not None
    character = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    assert character.attributes["STR"] == 55

    assert await router.dispatch(ctx, ".st 力量+=5") is not None
    character = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    assert character.attributes["STR"] == 60


async def test_sheet_explicit_assignment_stores_an_absolute_negative(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:st-negative", user_id="u1", locale="en")
    await services.characters.save_character(ctx.user_id, ctx.chat_key, CharacterSheet("Fighter", "DnD5e"))

    # A d20 ability modifier is legitimately negative; the legacy form could only
    # ever subtract from the current value, never assign minus three.
    reply = await router.dispatch(ctx, ".st 力量调整值=-3")

    assert reply is not None
    character = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    pack = load_rulepack("dnd5e")
    assert sheet_value(character, pack, "力量调整值") == -3


# ---------------------------------------------------------------------------
# `.st <someone else> <attr>=<n>` — the ghost-key mis-parse. Both scans take
# everything before the value as the attribute NAME, so a teammate's name became
# part of the key and was written to the CALLER's own sheet, then echoed back as
# "updated" while the real attribute never moved (run-3 play-test).
# ---------------------------------------------------------------------------


async def _table_with_two_characters(tmp_path, chat_key: str):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")
    await router.dispatch(ctx, ".coc Investigator")
    # A second player's character, so the room's roster really holds the name typed below.
    await services.characters.save_character("u2", chat_key, CharacterSheet("沈拾遗", "coc7"))
    return services, router, ctx


async def test_st_refuses_a_teammates_name_and_writes_no_ghost_key(tmp_path):
    services, router, ctx = await _table_with_two_characters(tmp_path, "cli:dm:st-ghost")

    reply = await router.dispatch(ctx, ".st 沈拾遗 力量=3")

    i18n = services.i18n.with_locale("en")
    assert reply is not None
    # It names the other character, says whose sheet `.st` writes, and spells the fix.
    assert i18n.t("commands.sheet.key_is_name", name="沈拾遗", key="沈拾遗 力量") in reply
    assert i18n.t("commands.sheet.key_suggestion", command="st", suggestion="力量=3") in reply
    assert i18n.t("commands.sheet.changed", items="") not in reply

    # Nothing was written ANYWHERE: not the ghost key, not the real attribute.
    caller = await services.characters.get_character("u1", ctx.chat_key)
    assert not any("沈拾遗" in str(key) for key in {**caller.attributes, **caller.skills})
    assert caller.attributes.get("STR") != 3
    other = await services.characters.get_character("u2", ctx.chat_key)
    assert not any("沈拾遗" in str(key) for key in {**other.attributes, **other.skills})


async def test_st_refuses_a_relative_assignment_under_a_name_too(tmp_path):
    services, router, ctx = await _table_with_two_characters(tmp_path, "cli:dm:st-ghost-rel")
    before = (await services.characters.get_character("u1", ctx.chat_key)).attributes.get("STR")

    reply = await router.dispatch(ctx, ".st 沈拾遗 力量+=3")

    i18n = services.i18n.with_locale("en")
    assert reply is not None
    assert i18n.t("commands.sheet.key_is_name", name="沈拾遗", key="沈拾遗 力量") in reply
    # The correction keeps the operator it was typed with, or it would silently mean
    # something else than the player asked for.
    assert i18n.t("commands.sheet.key_suggestion", command="st", suggestion="力量+=3") in reply
    caller = await services.characters.get_character("u1", ctx.chat_key)
    assert caller.attributes.get("STR") == before
    assert not any("沈拾遗" in str(key) for key in {**caller.attributes, **caller.skills})


async def test_st_refuses_a_spaced_key_that_names_nobody(tmp_path):
    """Whitespace in a name the pack never declared is a mis-parse whoever typed it —
    a stranger's name, a typo, a two-word phrase. It is refused either way; only the
    sentence differs, because "that is another character here" would be a lie."""
    services, router, ctx = await _table_with_two_characters(tmp_path, "cli:dm:st-spaced")

    reply = await router.dispatch(ctx, ".st 无名氏 力量=3")

    i18n = services.i18n.with_locale("en")
    assert reply is not None
    assert i18n.t("commands.sheet.key_has_space", name="无名氏", key="无名氏 力量") in reply
    assert i18n.t("commands.sheet.key_is_name", name="无名氏", key="无名氏 力量") not in reply
    assert i18n.t("commands.sheet.key_suggestion", command="st", suggestion="力量=3") in reply
    caller = await services.characters.get_character("u1", ctx.chat_key)
    assert not any("无名氏" in str(key) for key in {**caller.attributes, **caller.skills})


async def test_st_still_writes_the_plain_and_the_custom_single_token_key(tmp_path):
    """The refusal must not cost a table its house skills: inventing a skill mid-session
    is what `.st` is FOR, so a single-token key nobody declared still writes (owner
    amendment). A pack-DECLARED multi-word name still writes too — it resolves."""
    services, router, ctx = await _table_with_two_characters(tmp_path, "cli:dm:st-custom")
    pack = load_rulepack("coc7")

    assert await router.dispatch(ctx, ".st 力量=60") is not None
    assert await router.dispatch(ctx, ".st 学识星象=45") is not None
    assert await router.dispatch(ctx, ".st spot hidden=70") is not None

    character = await services.characters.get_character("u1", ctx.chat_key)
    assert character.attributes["STR"] == 60
    assert sheet_value(character, pack, "学识星象") == 45
    assert sheet_value(character, pack, "侦查") == 70


# ---------------------------------------------------------------------------
# 拆卡 — the world-import verb is keeper-gated even for a room attachment,
# and `.var` (imported-variable exposure) is keeper-gated on every subcommand.
# ---------------------------------------------------------------------------


async def test_import_world_denied_for_player_even_via_attachment(tmp_path):
    import json as _json

    from agent.context import LocalFs

    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:worldgate"
    (tmp_path / "w.json").write_text(_json.dumps({"name": "W"}), encoding="utf-8")
    player = AgentCtx(
        chat_key=chat_key,
        user_id="p1",
        platform="tui",
        locale="en",
        fs=LocalFs(str(tmp_path)),
        extra={"role": "player", "attachment_names": ["w.json"]},
    )

    reply = await router.dispatch(player, ".import world")

    assert reply == services.i18n.with_locale("en").t("charcard.commands.import.world_denied")
    # Nothing reached the room: no hooks, no variable tree.
    assert await services.store.state_get(chat_key, "room_hooks") is None


async def test_import_world_runs_for_the_keeper(tmp_path):
    import json as _json

    from agent.context import LocalFs
    from core.mvu_compat import load_mvu

    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:worldok"
    heavy = {
        "name": "Manor",
        "extensions": {"loreweaver_hooks": ["on('turn_start', () => {});"]},
        "character_book": {"entries": [{"comment": "[InitVar]", "content": '{"真凶": ["butler", "t"]}'}]},
    }
    (tmp_path / "w.json").write_text(_json.dumps(heavy, ensure_ascii=False), encoding="utf-8")
    keeper = AgentCtx(
        chat_key=chat_key,
        user_id="k1",
        platform="tui",
        locale="en",
        fs=LocalFs(str(tmp_path)),
        extra={"role": "keeper", "attachment_names": ["w.json"], "reauthorize": lambda: True},
    )

    reply = await router.dispatch(keeper, ".import world")

    assert reply is not None and "hook script" in reply
    assert (await load_mvu(services.documents, chat_key))["真凶"][0] == "butler"
    raw = await services.store.state_get(chat_key, "room_hooks")
    assert raw and "card:Manor" in raw


async def test_var_command_is_keeper_gated_and_curates_exposure():
    from core.mvu_compat import mvu_exposed_prefixes, mvu_init_from_initvar

    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:vargate"
    await mvu_init_from_initvar(services.documents, chat_key, {"理": {"好感度": [33, "a"]}, "真凶": ["管家", "t"]})

    player = _player_ctx(chat_key)
    for line in (".var", ".var list", ".var expose 理", ".var hide 理"):
        reply = await router.dispatch(player, line)
        assert reply == services.i18n.with_locale("en").t("vars.commands.denied")

    keeper = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="en", extra={"role": "keeper"})
    exposed = await router.dispatch(keeper, ".var expose 理")
    assert exposed is not None and "理" in exposed
    assert await mvu_exposed_prefixes(services.documents, chat_key) == ["理"]

    listing = await router.dispatch(keeper, ".var list")
    assert listing is not None
    assert "[visible]" in listing and "[hidden]" in listing
    assert "真凶" in listing  # the keeper's own listing shows the hidden remainder

    hidden = await router.dispatch(keeper, ".var hide 理")
    assert hidden is not None
    assert await mvu_exposed_prefixes(services.documents, chat_key) == []


async def test_preset_import_resolves_pack_relative_refs(tmp_path):
    import json

    from core.preset_store import load_preset

    services = build_services(
        Settings(data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    router = CommandRouter(services)
    pack_presets = tmp_path / "data/packs/stylekit@1.0.0/presets"
    pack_presets.mkdir(parents=True)
    (pack_presets / "noir.json").write_text(
        json.dumps(
            {
                "prompts": [
                    {"identifier": "main", "name": "Main", "content": "Write plainly.", "role": "system"}
                ],
                "prompt_order": [{"character_id": 100001, "order": [{"identifier": "main", "enabled": True}]}],
            }
        ),
        encoding="utf-8",
    )

    keeper = AgentCtx(chat_key="tui:group:presetpack", user_id="k1", platform="cli", locale="en")
    reply = await router.dispatch(keeper, ".preset import stylekit/presets/noir.json")
    assert reply is not None and "noir" in reply
    assert load_preset(tmp_path / "data", "noir") is not None


async def test_var_set_and_add_write_native_modvars_with_validation():
    from core.modvars import build_spec, define_modvar, load_modvars

    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:varwrite"
    await define_modvar(
        services.documents, chat_key, build_spec("suspicion", "number", minimum=0, maximum=10, default=3)
    )
    await define_modvar(
        services.documents, chat_key, build_spec("mood", "enum", options=["calm", "uneasy"], default="calm")
    )
    en = services.i18n.with_locale("en")

    player = _player_ctx(chat_key)
    for line in (".var set suspicion 5", ".var add suspicion 1"):
        assert await router.dispatch(player, line) == en.t("vars.commands.denied")

    keeper = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="en", extra={"role": "keeper"})

    reply = await router.dispatch(keeper, ".var set suspicion 7")
    assert reply == en.t("vars.commands.set_done", label="suspicion", id="suspicion", old=3, new=7)

    # add clamps into the declared bounds — core.modvars validation, not the command's
    reply = await router.dispatch(keeper, ".var add suspicion 9")
    assert reply == en.t("vars.commands.add_done", label="suspicion", id="suspicion", old=7, new=10, delta="9")
    assert (await load_modvars(services.documents, chat_key))["values"]["suspicion"] == 10

    # a bad enum value fails through core.modvars and writes nothing
    bad = await router.dispatch(keeper, ".var set mood furious")
    assert bad is not None and "mood" in bad
    assert (await load_modvars(services.documents, chat_key))["values"]["mood"] == "calm"

    # add on a non-number refuses; a garbage delta gets the friendly error
    assert (bad := await router.dispatch(keeper, ".var add mood 1")) is not None and "mood" in bad
    assert await router.dispatch(keeper, ".var add suspicion abc") == en.t("vars.commands.bad_delta", delta="abc")

    # unknown id lists the defined ones; a missing value is a usage error
    assert await router.dispatch(keeper, ".var set nosuch 1") == en.t(
        "vars.commands.unknown_var", id="nosuch", known="suspicion, mood"
    )
    assert await router.dispatch(keeper, ".var set suspicion") == en.t("vars.commands.usage")

    # .var list shows the typed trackers too (k3 playtest D9a) — with no listing, a
    # keeper's only route to "see the trackers" was asking the model, the leak path.
    await define_modvar(
        services.documents, chat_key, build_spec("dread", "number", visibility="keeper", default=2)
    )
    listing = await router.dispatch(keeper, ".var list")
    assert listing is not None
    assert "suspicion" in listing and "10" in listing
    assert "dread" in listing and en.t("vars.commands.keeper_tag") in listing
    assert en.t("vars.commands.player_tag") in listing


async def test_pc_roster_claim_is_player_open_but_foreign_release_is_keeper_only():
    from core.character_manager import CharacterSheet
    from core.pregen_roster import pregen_add

    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:cast"
    sheet = CharacterSheet(name="理", system="CoC")
    await pregen_add(services.documents, chat_key, sheet, source="card:test")

    p1 = _player_ctx(chat_key)
    listing = await router.dispatch(p1, ".pc")
    assert listing is not None and "理" in listing

    claimed = await router.dispatch(p1, ".pc claim 理")
    assert claimed == services.i18n.with_locale("en").t("pregen.commands.claimed", name="理", system="CoC")
    assert (await services.characters.get_character("p1", chat_key)).name == "理"

    # Another player can neither claim nor release someone else's character...
    p2 = AgentCtx(chat_key=chat_key, user_id="p2", platform="tui", locale="en", extra={"role": "player"})
    taken = await router.dispatch(p2, ".pc claim 理")
    assert taken == services.i18n.with_locale("en").t("pregen.commands.claim_taken", name="理")
    denied = await router.dispatch(p2, ".pc release 理")
    assert denied == services.i18n.with_locale("en").t("pregen.commands.release_not_yours", name="理")

    # ...but the keeper force-releases, and the slot opens again.
    keeper = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="en", extra={"role": "keeper"})
    released = await router.dispatch(keeper, ".pc release 理")
    assert released == services.i18n.with_locale("en").t("pregen.commands.released", name="理")
    reclaim = await router.dispatch(p2, ".pc claim 理")
    assert reclaim == services.i18n.with_locale("en").t("pregen.commands.claimed", name="理", system="CoC")


def test_parse_sheet_assignments_refuses_a_mix_of_forms_and_operator_names():
    """`.st STR=16 DEX14` used to set STR and silently drop DEX. Half-doing a command is
    worse than refusing it: the whole thing is refused (the caller answers bad_args)."""
    assert _parse_sheet_assignments("STR=16 DEX14") == []
    assert _parse_sheet_assignments("HP+=2 STR18") == []
    assert _parse_sheet_assignments("x==5") == []
    assert _parse_sheet_assignments("a=b=5") == []
    # …while a trailing separator or whitespace is not a dropped half.
    assert _parse_sheet_assignments("STR=16, ") == [("STR", "set", "16")]
