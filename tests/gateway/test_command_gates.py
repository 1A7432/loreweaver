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
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter, _parse_sheet_assignments
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
    assert await services.store.get(user_key="", store_key=f"bot_enabled.{chat_key}") is None


async def test_bot_status_query_open_but_keeper_can_toggle():
    services = _services()
    router = CommandRouter(services)
    chat_key = "tui:group:bot2"

    status = await router.dispatch(_player_ctx(chat_key), ".bot")
    assert status == services.i18n.with_locale("en").t("commands.bot.status")

    keeper = AgentCtx(chat_key=chat_key, user_id="k1", platform="tui", locale="en", extra={"role": "keeper"})
    toggled = await router.dispatch(keeper, ".bot off")
    assert toggled == services.i18n.with_locale("en").t("commands.bot.off")
    assert await services.store.get(user_key="", store_key=f"bot_enabled.{chat_key}") == "0"


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

    monkeypatch.setattr("gateway.commands.allow_imagegen_request", _spy_allow)
    monkeypatch.setattr("gateway.commands._resolve_avatar_target", _fake_target)

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
    assert done is not None and done.startswith("Campaign reset")


def test_parse_sheet_assignments_is_linear_on_pathological_input():
    # A long run of non-matching characters must not blow up the assignment regex.
    payload = "力" * 8000
    start = time.monotonic()
    result = _parse_sheet_assignments(payload)
    elapsed = time.monotonic() - start
    assert result == []
    assert elapsed < 1.0


def test_parse_sheet_assignments_still_parses_valid_glued_pairs():
    assert _parse_sheet_assignments("STR16 DEX14") == [("STR", "16"), ("DEX", "14")]
    assert _parse_sheet_assignments("力量50，敏捷60") == [("力量", "50"), ("敏捷", "60")]
    assert _parse_sheet_assignments("HP-4") == [("HP", "-4")]
