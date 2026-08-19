"""Room-wide AI-KP activity events for shared TUI busy indicators."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from gateway.commands import CommandReply
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, assistant_text, tool_call
from net.session import render_frame


class _Member:
    id = "watcher"
    user_key = "watcher"
    transport = "tui"
    name = "Watcher"

    def __init__(self) -> None:
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


class _NullRouter:
    def resolve(self, text: str, locale: str):
        return None

    async def dispatch_reply(self, ctx: AgentCtx, text: str):
        return None


class _CommandRouter:
    def resolve(self, text: str, locale: str):
        return SimpleNamespace(canonical="report", private_reply=False), ""

    async def dispatch_reply(self, ctx: AgentCtx, text: str):
        return CommandReply("done")


def _services():
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(responder=lambda messages, tools: assistant_text("The door opens.")),
        embeddings=FakeEmbeddings(8),
    )


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key="tui:group:shared", user_id="nora", platform="tui", locale="en")


async def test_ai_turn_broadcasts_busy_actor_then_idle_to_every_room_member() -> None:
    hub = RoomHub()
    first, second = _Member(), _Member()
    second.id = "keeper"
    await hub.subscribe(_ctx().chat_key, first)
    await hub.subscribe(_ctx().chat_key, second)
    first.events.clear()
    second.events.clear()

    services = _services()
    await run_turn(
        hub,
        services,
        _ctx(),
        "I open the door",
        command_router=_NullRouter(),
        toolset=build_kp_toolset(services),
        actor_name="Nora",
    )

    for member in (first, second):
        statuses = [event.data for event in member.events if event.kind == "turn_status"]
        assert statuses == [{"status": "busy", "actor": "Nora"}, {"status": "idle"}]


async def test_idle_is_published_when_ai_turn_raises(monkeypatch) -> None:
    async def explode(*args, **kwargs):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr("gateway.turn.run_kp_turn", explode)
    hub = RoomHub()
    watcher = _Member()
    await hub.subscribe(_ctx().chat_key, watcher)
    watcher.events.clear()
    services = _services()

    with pytest.raises(RuntimeError, match="provider exploded"):
        await run_turn(
            hub,
            services,
            _ctx(),
            "I open the door",
            command_router=_NullRouter(),
            toolset=build_kp_toolset(services),
            actor_name="Nora",
        )

    assert [event.data for event in watcher.events if event.kind == "turn_status"] == [
        {"status": "busy", "actor": "Nora"},
        {"status": "idle"},
    ]


async def test_command_turn_does_not_claim_the_ai_keeper_is_busy() -> None:
    hub = RoomHub()
    watcher = _Member()
    await hub.subscribe(_ctx().chat_key, watcher)
    watcher.events.clear()
    services = _services()

    await run_turn(
        hub,
        services,
        _ctx(),
        ".report",
        command_router=_CommandRouter(),
        toolset=build_kp_toolset(services),
        actor_name="Nora",
    )

    assert not [event for event in watcher.events if event.kind == "turn_status"]


def test_turn_status_renders_to_additive_wire_frames() -> None:
    assert render_frame(Event.turn_status("busy", actor="Nora")) == {
        "type": "turn_status",
        "status": "busy",
        "actor": "Nora",
    }
    assert render_frame(Event.turn_status("idle")) == {
        "type": "turn_status",
        "status": "idle",
    }


# ---------------------------------------------------------------------------
# Protocol 2.3.1: a long turn refreshes `busy` with a coarse activity + round.
# ---------------------------------------------------------------------------


def test_activity_and_round_are_optional_additive_fields() -> None:
    assert render_frame(Event.turn_status("busy", actor="Nora", activity="dice", round_index=2)) == {
        "type": "turn_status",
        "status": "busy",
        "actor": "Nora",
        "activity": "dice",
        "round": 2,
    }
    # Unset stays off the wire, so a pre-2.3.1 client sees the frame it always saw.
    assert "activity" not in render_frame(Event.turn_status("busy", actor="Nora"))
    assert "round" not in render_frame(Event.turn_status("busy", actor="Nora", round_index=0))


async def test_a_tool_round_refreshes_busy_with_its_activity_and_round() -> None:
    hub = RoomHub()
    watcher = _Member()
    await hub.subscribe(_ctx().chat_key, watcher)
    watcher.events.clear()

    calls = {"n": 0}

    def responder(messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            return ChatResult(content=None, tool_calls=[tool_call("roll_dice", expression="1d100")])
        return assistant_text("The die lands on its edge.")

    services = build_services(
        Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8)
    )

    await run_turn(
        hub,
        services,
        _ctx(),
        "I search the desk",
        command_router=_NullRouter(),
        toolset=build_kp_toolset(services),
        actor_name="Nora",
    )

    statuses = [event.data for event in watcher.events if event.kind == "turn_status"]
    assert statuses == [
        {"status": "busy", "actor": "Nora"},
        {"status": "busy", "actor": "Nora", "activity": "dice", "round": 1},
        {"status": "idle"},
    ]


async def test_a_companion_sub_turn_never_reports_activity() -> None:
    """The same structural gate the Scribe and the Director have: a companion's own
    turn re-enters `run_turn`, and its rounds are not the table's turn."""
    services = _services()
    ctx = AgentCtx(
        chat_key="tui:group:shared", user_id="companion:ada", platform="companion", locale="en"
    )

    await run_turn(
        RoomHub(),
        services,
        ctx,
        "Ada steps forward",
        command_router=_NullRouter(),
        toolset=build_kp_toolset(services),
        actor_name="Ada",
    )

    assert ctx.activity_sink is None
