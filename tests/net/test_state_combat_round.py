from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools_mechanics import InitiativeTools
from agent.services import build_services
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.state import build_room_state


async def test_room_state_clock_carries_the_active_combat_round_without_a_game_clock():
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key="cli:dm:combat-round", user_id="u1")
    initiative = InitiativeTools(services)

    await initiative.initiative_tracker(ctx, action="add", name="Alice", initiative=15)
    await initiative.initiative_tracker(ctx, action="add", name="Bob", initiative=20)
    await initiative.initiative_tracker(ctx, action="next")
    await initiative.initiative_tracker(ctx, action="next")

    state = await build_room_state(services, ctx)

    assert state["clock"]["round"] == 2


async def test_tool_and_command_next_each_commit_one_pointer_step_with_agreement():
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key="cli:dm:pointer-agreement", user_id="u1", locale="en")
    initiative = InitiativeTools(services)
    router = CommandRouter(services)

    await initiative.initiative_tracker(ctx, action="add", name="Alice", initiative=20)
    await initiative.initiative_tracker(ctx, action="add", name="Bob", initiative=15)
    await initiative.initiative_tracker(ctx, action="add", name="Cora", initiative=10)

    tool_result = await initiative.initiative_tracker(ctx, action="next")
    assert "Bob" in tool_result
    state_after_tool = await build_room_state(services, ctx)
    assert [entry["name"] for entry in state_after_tool["initiative"]] == ["Bob", "Cora", "Alice"]
    assert [entry["current"] for entry in state_after_tool["initiative"]] == [True, False, False]
    session_after_tool = await services.battles.generator.get_current_session(ctx.chat_key)
    assert session_after_tool is not None
    assert session_after_tool.combat_rounds[-1]["current"] == "Bob"
    assert session_after_tool.combat_rounds[-1]["turn"] == 1

    command_reply = await router.dispatch_reply(ctx, ".init next")
    assert command_reply is not None
    assert command_reply.events == ()
    assert "Cora" in command_reply.text
    state_after_command = await build_room_state(services, ctx)
    assert [entry["name"] for entry in state_after_command["initiative"]] == ["Cora", "Alice", "Bob"]
    session_after_command = await services.battles.generator.get_current_session(ctx.chat_key)
    assert session_after_command is not None
    assert session_after_command.combat_rounds[-1]["current"] == "Cora"
    assert session_after_command.combat_rounds[-1]["turn"] == 2
