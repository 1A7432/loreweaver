from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools_mechanics import InitiativeTools
from agent.services import build_services
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
