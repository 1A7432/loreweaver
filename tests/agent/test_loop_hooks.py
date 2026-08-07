"""Integration tests for the event-hook layer through run_kp_turn: room-registered scripts
fire on the turn lifecycle, effects apply through validated deterministic code, and hooks can
never break a turn. Skipped as a module without the `ejs` extra (hooks are inert then)."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.hook_runtime import install_room_hooks  # noqa: E402
from agent.loop import run_kp_turn  # noqa: E402
from agent.prompt_builder import build_system_prompt  # noqa: E402
from agent.services import build_services  # noqa: E402
from agent.tools import Toolset, tool  # noqa: E402
from core.modvars import build_spec, define_modvar, load_modvars  # noqa: E402
from core.mvu_compat import load_mvu  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call  # noqa: E402


def _services(llm):
    return build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))


def _ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale="en")


class _DiceProvider:
    @tool
    async def skill_check(self, ctx: AgentCtx, skill_name: str) -> str:
        """Roll a skill check."""
        return f"{skill_name}: rolled 42 vs 65 -> hard success"


async def test_reply_ready_rewrite_and_narrate_shape_the_final_reply():
    services = _services(FakeLLM(script=[assistant_text("Night falls.")]))
    ctx = _ctx("chat-hooks-1")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        ["on('reply_ready', (e) => { rewriteReply(e.reply.toUpperCase()); narrate('[omen intensifies]'); });"],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "look around")

    assert result.reply.startswith("NIGHT FALLS.")
    assert "[omen intensifies]" in result.reply


async def test_turn_start_writes_validate_and_chain_into_variables_changed():
    services = _services(FakeLLM(script=[assistant_text("ok")]))
    ctx = _ctx("chat-hooks-2")
    await define_modvar(services.documents, ctx.chat_key, build_spec("fear", "number", minimum=0, maximum=10))
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => { setvar('fear', 99); setvar('trail.seen', true); });"
            "on('variables_changed', (e) => narrate('changed:' + e.writes.length));"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "go")

    state = await load_modvars(services.documents, ctx.chat_key)
    assert state["values"]["fear"] == 10  # validated + clamped by real code
    tree = await load_mvu(services.documents, ctx.chat_key)
    assert tree["trail"]["seen"] is True  # non-modvar name routes into the MVU tree
    assert "changed:2" in result.reply  # variables_changed observed both writes


async def test_dice_rolled_fires_on_real_dice_tools():
    llm = FakeLLM(script=[assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")), assistant_text("done")])
    services = _services(llm)
    ctx = _ctx("chat-hooks-3")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        ["on('dice_rolled', (e) => narrate('dice:' + e.rolls[0].tool));"],
    )

    result = await run_kp_turn(ctx, services, Toolset(_DiceProvider()), "I search the room")

    assert "dice:skill_check" in result.reply


async def test_turn_start_inject_lands_in_the_system_prompt():
    services = _services(FakeLLM(script=[]))
    ctx = _ctx("chat-hooks-4")
    ctx.extra["hook_injections"] = ["The bells have tolled thirteen times."]

    prompt = await build_system_prompt(ctx, services)

    i18n = services.i18n.with_locale("en")
    assert i18n.t("prompt.hooks_header") in prompt
    assert "thirteen times" in prompt


async def test_emit_ui_frames_collect_across_phases_in_fire_order():
    services = _services(FakeLLM(script=[assistant_text("All quiet.")]))
    ctx = _ctx("chat-hooks-ui")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => emitUI([{kind:'badge', label:'Chapter 1'}]));"
            "on('reply_ready', () => emitUI({kind:'stat', label:'Tension', value:2},"
            " {panel:'sidebar', id:'hud', replace:true}));"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "hello")

    assert result.reply == "All quiet."
    assert result.ui_frames == [
        {"blocks": [{"kind": "badge", "label": "Chapter 1"}], "panel": "inline"},
        {
            "blocks": [{"kind": "stat", "label": "Tension", "value": 2}],
            "panel": "sidebar",
            "id": "hud",
            "replace": True,
        },
    ]


async def test_broken_hooks_never_break_the_turn():
    services = _services(FakeLLM(script=[assistant_text("safe")]))
    ctx = _ctx("chat-hooks-5")
    await install_room_hooks(
        services, ctx.chat_key, "test", ["on('reply_ready', () => { while(true){} });"]
    )

    result = await run_kp_turn(ctx, services, Toolset(), "hello")

    assert result.reply == "safe"


async def test_reimport_replaces_a_sources_scripts_instead_of_stacking():
    services = _services(FakeLLM(script=[]))
    await install_room_hooks(services, "room-x", "card:络络", ["on('turn_start', () => {});"])
    await install_room_hooks(services, "room-x", "card:络络", ["on('reply_ready', () => {});"])

    raw = await services.store.state_get("room-x", "room_hooks")
    entries = json.loads(raw)
    assert len(entries) == 1
    assert entries[0]["id"] == "card:络络#0"


async def test_emit_panel_events_aggregate_across_phases_into_the_turn_result():
    services = _services(FakeLLM(script=[assistant_text("Night falls.")]))
    ctx = _ctx("chat-hooks-panels-1")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => emitPanel('pack/board', {phase: 'start'}));"
            "on('reply_ready', () => emitPanel('pack/board', {phase: 'reply'}));"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "look around")

    assert [event["payload"]["phase"] for event in result.panel_events] == ["start", "reply"]


async def test_emit_panel_per_turn_budget_keeps_the_head_and_drops_the_rest():
    from core.hooks import MAX_PANEL_EVENTS_PER_TURN

    services = _services(FakeLLM(script=[assistant_text("ok")]))
    ctx = _ctx("chat-hooks-panels-2")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => { for (var i = 0; i < 15; i++) emitPanel('pack/a', i); });"
            "on('reply_ready', () => { for (var i = 0; i < 15; i++) emitPanel('pack/b', i); });"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "poke")

    assert len(result.panel_events) == MAX_PANEL_EVENTS_PER_TURN
    assert [event["panel"] for event in result.panel_events[:15]] == ["pack/a"] * 15
    assert [event["panel"] for event in result.panel_events[15:]] == ["pack/b"] * 5


async def test_clock_advanced_fires_once_per_clock_tool_advance():
    """The game_clock tool's advance records the move; the turn finalizer fires
    `clock_advanced` with {from, to, delta} so room hooks can keep their own
    calendars (day counters, deadlines) in lockstep with the clock."""
    from agent.kp_tools_knowledge import NoteTools

    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("game_clock", action="set", value="D1 09:00")),
            assistant_tools(tool_call("game_clock", action="advance", value="+1天")),
            assistant_text("done"),
        ]
    )
    services = _services(llm)
    ctx = _ctx("chat-hooks-clock")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        ["on('clock_advanced', (e) => narrate('clock:' + e['from'] + '>' + e.to + '/' + e.delta));"],
    )

    result = await run_kp_turn(ctx, services, Toolset(NoteTools(services)), "rest until morning")

    assert "clock:D1 09:00>D2 09:00/+1天" in result.reply


async def test_clock_advanced_stale_records_never_leak_into_the_next_turn():
    from agent.kp_tools_knowledge import NoteTools

    services = _services(FakeLLM(script=[assistant_text("ok")]))
    ctx = _ctx("chat-hooks-clock-stale")
    ctx.extra["clock_advances"] = [{"from": "D9 08:00", "to": "D10 08:00", "delta": "+1天"}]
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        ["on('clock_advanced', (e) => narrate('stale:' + e.to));"],
    )

    result = await run_kp_turn(ctx, services, Toolset(NoteTools(services)), "hello")

    assert "stale:" not in result.reply
