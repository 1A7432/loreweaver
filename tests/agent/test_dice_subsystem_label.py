"""Protocol 2.5: every dice frame that names a `subsystem` also names it for people.

`subsystem` stays the pack's stable id (`sanity_check`); `subsystem_label` is that
subsystem's own `display` in the issuing context's locale ("Sanity" / "理智"). Every
place that sets `subsystem` sets the label beside it: the check-with-loss tool, the
resource-spend tool, the script lane and the `.sc` command. The frame is recorded into
the replay lane as-is, so the label is frozen at record time like `expr`.
"""

from __future__ import annotations

import pytest

import core.rulepacks as rulepacks_module
from agent.context import AgentCtx
from agent.kp_tools_mechanics import CharacterTools
from agent.kp_tools_subsystems import dispatch_subsystem
from agent.services import build_services
from core.dice_engine import seed_dice
from core.ejs_full import quickjs_available
from core.rulepacks import load_rulepack, reload_rulepacks
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _build(locale: str):
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key=f"tui:group:subsystem-label-{locale}", user_id="u1", platform="tui", locale=locale)
    return services, ctx


@pytest.mark.parametrize(("locale", "label"), [("en", "Sanity"), ("zh", "理智")])
async def test_check_with_loss_frame_names_its_subsystem(locale: str, label: str) -> None:
    services, ctx = _build(locale)
    await CharacterTools(services).create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(5)
    await dispatch_subsystem(
        services, ctx, load_rulepack("coc7"), "sanity_check", {"success_loss": "0", "failure_loss": "1"}
    )

    payload = ctx.dice_payloads[-1]
    assert payload["subsystem"] == "sanity_check"  # the stable id never changes
    assert payload["subsystem_label"] == label


@pytest.mark.parametrize(("locale", "label"), [("en", "Luck"), ("zh", "幸运")])
async def test_resource_spend_frame_names_its_subsystem(locale: str, label: str) -> None:
    services, ctx = _build(locale)
    await CharacterTools(services).create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.add_skill_check(
        ctx.chat_key, ctx.uid(), "Vera", "侦查", 50, 55,
        success=False, rank=-1, raw_roll=55, difficulty=1, rule=0,
    )

    await dispatch_subsystem(services, ctx, load_rulepack("coc7"), "spend_luck", {"points": 6})

    payload = ctx.dice_payloads[-1]
    assert payload["subsystem"] == "spend_luck"
    assert payload["subsystem_label"] == label


async def test_sanity_command_frame_names_its_subsystem() -> None:
    services, ctx = _build("zh")
    router = CommandRouter(services)
    await router.dispatch(ctx, ".coc Investigator")

    seed_dice(54)
    reply = await router.dispatch_reply(ctx, ".sc 0/1d4")

    assert reply is not None
    frame = reply.events[0].data
    assert frame["subsystem"] == "sanity_check"
    assert frame["subsystem_label"] == "理智"


_SCRIPT_PACK_YAML = """
names: [labelfate]
defaults:
  勇气: 2
subsystems:
  fate_surge:
    script: surge.js
    rolls: {surge: "2d6"}
    display: {en: Fate surge, zh: 命运涌动}
sheet:
  label: LabelFate
  attributes: {勇气: 2}
  resources: []
"""

_SURGE_JS = """
function flow(input) {
  return {stat_delta: {勇气: 1}, narration: "Fate favors the bold."};
}
"""


@pytest.mark.skipif(not quickjs_available(), reason="quickjs extra not installed")
async def test_script_flow_frame_names_its_subsystem(tmp_path) -> None:
    (tmp_path / "labelfate.yaml").write_text(_SCRIPT_PACK_YAML, encoding="utf-8")
    (tmp_path / "surge.js").write_text(_SURGE_JS, encoding="utf-8")
    original = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    reload_rulepacks()
    try:
        services, ctx = _build("zh")
        await CharacterTools(services).create_character(ctx, name="Vera", system="labelfate", auto_generate=False)

        seed_dice(3)
        await dispatch_subsystem(services, ctx, load_rulepack("labelfate"), "fate_surge", {})

        payload = ctx.dice_payloads[-1]
        assert payload["subsystem"] == "fate_surge"
        assert payload["subsystem_label"] == "命运涌动"
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original
        reload_rulepacks()
