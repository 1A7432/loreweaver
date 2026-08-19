"""The CALL PATHS into the compiled resolver — audit findings F07 + F08.

`tests/core/test_resolution_tables.py` proves the ladders themselves grade the
rulebooks correctly. This file covers the other half: what the command and tool
lanes actually HAND the resolver, and what they do with what comes back.

- F07: a pack whose ``roll:`` declares a ``{slot}`` with no ``default`` made
  every check command in that room raise an uncaught ``ResolutionError``. Two
  halves: the bundled pool pack defaults its slot, and the command/subsystem
  lanes turn a genuinely undefaultable slot into a localized, actionable notice
  instead of dropping the turn.
- F08: an opposed check in a dc-target system passed ``target=None``, which
  `interpret` silently read as ``0`` — making ``roll >= target`` a tautology, so
  both sides graded "success" and the handler reported a tie ~82% of the time
  while ignoring the actual totals.
"""

from __future__ import annotations

import dataclasses

import pytest

from agent.context import AgentCtx
from agent.kp_tools_subsystems import dispatch_subsystem
from agent.services import build_services
from core.check_outcome import RollDetail
from core.dice_engine import DiceRoller, seed_dice
from core.resolution import ParamSpec, ResolutionError, compile_resolution
from core.rulepacks import load_rulepack
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _services(**settings):
    return build_services(
        Settings(locale="en", **settings), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8)
    )


def _undefaulted(pack):
    """`pack` with every roll ``{slot}`` stripped of its default — the shape a
    third-party pack author ships when a slot genuinely cannot be defaulted."""
    resolver = dataclasses.replace(
        pack.resolver,
        params=tuple(dataclasses.replace(spec, default=None) for spec in pack.resolver.params)
        or (ParamSpec(id="pool", minimum=1, maximum=200, default=None),),
    )
    return dataclasses.replace(pack, resolver=resolver)


# ---------------------------------------------------------------------------
# F07 (a) — the bundled pool pack works out of the box
# ---------------------------------------------------------------------------


def test_every_bundled_pack_can_roll_its_check_with_no_caller_params():
    """A shipped pack whose check cannot be rolled without caller-supplied
    params is broken for every lane that does not wire them (all but one)."""
    for system in ("coc7", "dnd5e", "wod"):
        resolver = load_rulepack(system).resolver
        assert resolver is not None
        missing = [spec.id for spec in resolver.params if spec.default is None]
        assert not missing, f"rulepacks/{system}.yaml roll params without a default: {missing}"


async def test_wod_room_check_command_rolls_instead_of_raising():
    services = _services(default_rulepack="wod")
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="tui:group:wod-check", user_id="u1", platform="tui", locale="en")
    character = services.characters.generate_character("wod", "Vera")
    await services.characters.save_character("u1", ctx.chat_key, character)

    pack = load_rulepack("wod")
    seed_dice(3)
    expected_roll = DiceRoller().roll_for_check(pack.resolver)
    expected_label = pack.rank_label(pack.resolver.interpret(expected_roll, 0).rank.id, "en")

    seed_dice(3)
    reply = await router.dispatch_reply(ctx, ".ra")

    assert reply is not None and not reply.error
    # A pool system's "roll" IS its success count — the graded number must be real.
    assert expected_roll.successes is not None
    assert str(expected_roll.successes) in reply.text
    assert expected_label in reply.text


# ---------------------------------------------------------------------------
# F07 (b) — an undefaultable slot fails loudly and legibly, never uncaught
# ---------------------------------------------------------------------------


async def test_command_lane_names_the_missing_roll_param(monkeypatch):
    services = _services(default_rulepack="wod")
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="tui:group:wod-noparam", user_id="u1", platform="tui", locale="en")
    character = services.characters.generate_character("wod", "Vera")
    await services.characters.save_character("u1", ctx.chat_key, character)

    broken = _undefaulted(load_rulepack("wod"))
    monkeypatch.setattr("gateway.commands.checks.load_rulepack", lambda system: broken)

    reply = await router.dispatch_reply(ctx, ".ra")

    assert reply is not None
    assert reply.error
    assert reply.text == services.i18n.with_locale("en").t("kp_tools.dice.pool.missing_param", param="pool")


async def test_command_lane_still_rolls_when_the_param_has_a_default(monkeypatch):
    """Positive control for the choke above: the SAME patched-load path with the
    pack's declared defaults intact must still produce a graded check."""
    services = _services(default_rulepack="wod")
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="tui:group:wod-control", user_id="u1", platform="tui", locale="en")
    character = services.characters.generate_character("wod", "Vera")
    await services.characters.save_character("u1", ctx.chat_key, character)

    pack = load_rulepack("wod")
    monkeypatch.setattr("gateway.commands.checks.load_rulepack", lambda system: pack)

    seed_dice(3)
    reply = await router.dispatch_reply(ctx, ".ra")

    assert reply is not None and not reply.error
    assert reply.text != services.i18n.with_locale("en").t("kp_tools.dice.pool.missing_param", param="pool")


async def test_subsystem_lane_names_the_missing_roll_param(monkeypatch):
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="tui:group:sub-noparam", user_id="u1", platform="tui", locale="en")
    await router.dispatch(ctx, ".coc Investigator")

    broken = _undefaulted(load_rulepack("coc7"))
    monkeypatch.setattr("agent.kp_tools_subsystems.load_rulepack", lambda system: broken)

    result = await dispatch_subsystem(
        services, ctx, broken, "sanity_check", {"success_loss": "0", "failure_loss": "1"}
    )

    assert result == services.i18n.with_locale("en").t("kp_tools.dice.pool.missing_param", param="pool")


async def test_subsystem_lane_still_runs_when_the_param_has_a_default():
    """Positive control: the same subsystem under the real pack still resolves."""
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="tui:group:sub-control", user_id="u1", platform="tui", locale="en")
    await router.dispatch(ctx, ".coc Investigator")

    seed_dice(5)
    result = await dispatch_subsystem(
        services, ctx, load_rulepack("coc7"), "sanity_check", {"success_loss": "0", "failure_loss": "1"}
    )

    assert result
    assert result != services.i18n.with_locale("en").t("kp_tools.dice.pool.missing_param", param="pool")


# ---------------------------------------------------------------------------
# F08 — dc-target opposed checks grade against a real number
# ---------------------------------------------------------------------------


async def _dnd_router():
    services = _services(default_rulepack="dnd5e")
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="tui:group:dnd-opposed", user_id="u1", platform="tui", locale="en")
    await router.dispatch(ctx, ".dnd Hero")
    return services, router, ctx


async def test_dnd5e_opposed_reports_the_side_with_the_higher_total():
    services, router, ctx = await _dnd_router()
    i18n = services.i18n.with_locale("en")

    # seed 1 rolls 5 then 19: 5+9 = 14 loses to 19+1 = 20.
    seed_dice(1)
    reply = await router.dispatch_reply(ctx, ".rav 察觉 9, 隐匿 1")
    assert i18n.t("commands.opposed.right") in reply.text
    assert i18n.t("commands.opposed.tie") not in reply.text

    # seed 4 rolls 8 then 10: 8+9 = 17 beats 10+1 = 11.
    seed_dice(4)
    reply = await router.dispatch_reply(ctx, ".rav 察觉 9, 隐匿 1")
    assert i18n.t("commands.opposed.left") in reply.text
    assert i18n.t("commands.opposed.tie") not in reply.text


async def test_dnd5e_opposed_wire_frame_agrees_with_the_grading():
    services, router, ctx = await _dnd_router()

    seed_dice(1)
    reply = await router.dispatch_reply(ctx, ".rav 察觉 9, 隐匿 1")
    frame = next(event for event in reply.events if event.kind == "dice")

    assert frame.data["detail"]["winner"] == "right"
    # Each side's reported total is the number that actually decided the contest.
    assert frame.data["detail"]["left"]["total"] == 5 + 9
    assert frame.data["detail"]["right"]["total"] == 19 + 1
    # The grading target is a real number, never a silent 0.
    assert frame.data["detail"]["left"]["target"] == 19 + 1
    assert frame.data["detail"]["right"]["target"] == 5 + 9


async def test_dnd5e_opposed_still_reports_a_genuine_tie():
    """Positive control: equal ranks AND equal totals really is a tie."""
    services, router, ctx = await _dnd_router()
    i18n = services.i18n.with_locale("en")

    # seed 0 rolls 13 then 14: 13+3 == 14+2.
    seed_dice(0)
    reply = await router.dispatch_reply(ctx, ".rav 察觉 3, 隐匿 2")

    assert i18n.t("commands.opposed.tie") in reply.text
    frame = next(event for event in reply.events if event.kind == "dice")
    assert frame.data["detail"]["winner"] == "tie"


async def test_dnd5e_opposed_rank_tier_outranks_the_totals():
    """Positive control: a natural-20 crit beats a bigger total that only
    reached plain success — tier is compared first, totals only break ties."""
    services, router, ctx = await _dnd_router()
    i18n = services.i18n.with_locale("en")

    # seed 5 rolls 20 then 9: left totals 20, right totals 39 — and left wins.
    seed_dice(5)
    reply = await router.dispatch_reply(ctx, ".rav 察觉 0, 隐匿 30")

    assert i18n.t("commands.opposed.left") in reply.text
    frame = next(event for event in reply.events if event.kind == "dice")
    assert frame.data["detail"]["left"]["total"] == 20
    assert frame.data["detail"]["right"]["total"] == 39
    assert frame.data["detail"]["left"]["outcome"]["critical"] is True


# ---------------------------------------------------------------------------
# F08 — `interpret` never invents a target
# ---------------------------------------------------------------------------


def test_interpret_refuses_to_grade_a_target_reading_ladder_without_a_target():
    resolver = load_rulepack("dnd5e").resolver

    with pytest.raises(ResolutionError):
        resolver.interpret(RollDetail("1d20", (5,), 5), None)


def test_interpret_still_grades_dnd5e_against_a_real_target():
    """Positive control for the guard above."""
    resolver = load_rulepack("dnd5e").resolver

    assert resolver.interpret(RollDetail("1d20", (5,), 5), 15).rank.id == "fail"
    assert resolver.interpret(RollDetail("1d20", (18,), 18), 15).rank.id == "success"
    assert resolver.interpret(RollDetail("1d20", (1,), 1), 5).rank.id == "fumble"


def test_targetless_pack_still_grades_without_a_target():
    """Positive control: a `target: none` pool system never reads `target`, so
    the guard must not touch it."""
    resolver = load_rulepack("wod").resolver
    detail = RollDetail("3d10>=6", (7, 2, 1), 1, successes=1, ones=1)

    outcome = resolver.interpret(detail, None)

    assert outcome.rank.id == "success"
    assert outcome.margin == 1


# ---------------------------------------------------------------------------
# F08 — a targetless pack may not compile a ladder that reads `target`
# ---------------------------------------------------------------------------


def _pool_block(when: str) -> dict:
    return {
        "roll": "{pool}d10>=6",
        "target": "none",
        "compare": ">=",
        "params": {"pool": {"min": 1, "max": 10, "default": 3}},
        "ranks": [{"id": "win", "when": when, "success": True, "tier": 2}, {"id": "lose", "tier": 1}],
    }


def test_targetless_pack_may_not_reference_target():
    with pytest.raises(ResolutionError) as err:
        compile_resolution("probe", _pool_block("roll >= target"))

    assert "target" in str(err.value)


def test_targetless_pack_reading_its_own_successes_compiles():
    """Positive control: the guard rejects only the impossible name."""
    resolver = compile_resolution("probe", _pool_block("successes >= 1"))

    detail = RollDetail("3d10>=6", (7, 2, 1), 1, successes=1, ones=1)
    assert resolver.interpret(detail, None).rank.id == "win"
