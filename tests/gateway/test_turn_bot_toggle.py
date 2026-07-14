"""`.bot off` mutes the AI Keeper on the hub/TUI path (`gateway.turn._kp_enabled`).

A human-Keeper table needs the KP to stay quiet on plain chat while dice
commands keep working; `.bot on`/unset keeps today's KP-answers-everything
behavior. (The chat adapters gate earlier, in `GatewayRunner.on_inbound`.)
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

ROOM = "tui:group:bot-toggle"


class _FakeMember:
    transport = "tui"

    def __init__(self, member_id: str) -> None:
        self.id = member_id
        self.user_key = f"user:{member_id}"
        self.name = member_id
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _services():
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text("The Keeper narrates.")]),
        embeddings=FakeEmbeddings(8),
    )


async def _room(services):
    hub = RoomHub()
    member = _FakeMember("p1")
    await hub.subscribe(ROOM, member)
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key=ROOM, user_id="u1", platform="tui", locale="en")
    return hub, member, router, toolset, ctx


async def test_bot_off_still_echoes_chat_but_runs_no_kp_turn():
    services = _services()
    hub, member, router, toolset, ctx = await _room(services)
    await services.store.set(user_key="", store_key=f"bot_enabled.{ROOM}", value="0")

    result = await run_turn(hub, services, ctx, "we gather around the map", command_router=router, toolset=toolset)

    assert result is None
    kinds = [event.kind for event in member.events]
    assert "player_action" in kinds  # the table still sees the chat line
    assert all(getattr(event, "speaker", "") != "kp" for event in member.events)


async def test_bot_off_keeps_dice_commands_working():
    services = _services()
    hub, member, router, toolset, ctx = await _room(services)
    await services.store.set(user_key="", store_key=f"bot_enabled.{ROOM}", value="0")

    result = await run_turn(hub, services, ctx, ".r 3d6", command_router=router, toolset=toolset)

    assert result is None  # command turn
    assert any(
        getattr(event, "speaker", "") == "system" and "3d6" in (getattr(event, "text", "") or "")
        for event in member.events
    )


async def test_bot_unset_and_bot_on_run_the_kp_turn():
    services = _services()
    hub, member, router, toolset, ctx = await _room(services)

    result = await run_turn(hub, services, ctx, "I open the door", command_router=router, toolset=toolset)
    assert result is not None
    assert any(getattr(event, "speaker", "") == "kp" for event in member.events)

    # An explicit `.bot on` after an off round restores the KP.
    await services.store.set(user_key="", store_key=f"bot_enabled.{ROOM}", value="0")
    member.events.clear()
    services.llm._script.append(assistant_text("Back at the table."))
    await run_turn(hub, services, ctx, ".bot on", command_router=router, toolset=toolset)
    member.events.clear()
    result = await run_turn(hub, services, ctx, "I listen at the door", command_router=router, toolset=toolset)
    assert result is not None
    assert any(getattr(event, "speaker", "") == "kp" for event in member.events)
