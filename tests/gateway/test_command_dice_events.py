from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


class RecordingMember:
    transport = "tui"
    locale = "en"

    def __init__(self, member_id: str, name: str) -> None:
        self.id = member_id
        self.user_key = f"user:{member_id}"
        self.name = name
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _services():
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[]),
        embeddings=FakeEmbeddings(8),
    )


async def test_deterministic_commands_publish_their_actual_rolls_to_the_hub() -> None:
    services = _services()
    room = "tui:group:structured-dice"
    ctx = AgentCtx(chat_key=room, user_id="u1", platform="tui", locale="en")
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)
    await router.dispatch(ctx, ".coc Investigator")

    hub = RoomHub()
    origin = RecordingMember("u1", "Nora")
    peer = RecordingMember("u2", "Mina")
    await hub.subscribe(room, origin)
    await hub.subscribe(room, peer)

    cases = (
        (".roll 2d6+1", {"expr", "rolls", "total", "modifier"}),
        (".check spot hidden", {"expr", "rolls", "total", "target", "rank", "success"}),
        (".sanity 0/1d4", {"expr", "total", "target", "rank", "loss", "remaining"}),
        (".opposed spot, listen", {"expr", "total", "target", "rank", "left", "right", "winner"}),
        (".init", {"expr", "rolls", "total", "modifier", "name"}),
    )
    for index, (command, expected_fields) in enumerate(cases):
        origin.events.clear()
        peer.events.clear()
        seed_dice(100 + index)

        await run_turn(
            hub,
            services,
            ctx,
            command,
            command_router=router,
            toolset=toolset,
            origin=origin,
        )

        origin_dice = [event for event in origin.events if event.kind == "dice"]
        peer_dice = [event for event in peer.events if event.kind == "dice"]
        assert len(origin_dice) == len(peer_dice) == 1
        assert origin_dice[0].data == peer_dice[0].data
        assert expected_fields <= origin_dice[0].data.keys()
        assert origin_dice[0].data["actor"] == "Investigator (Nora)"

        # The localized command text and structured event came from the same roll.
        reply = next(
            event.text
            for event in origin.events
            if event.kind == "narrative" and event.speaker == "system"
        )
        assert str(origin_dice[0].data["total"]) in reply


async def test_multi_roll_has_one_structured_event_per_roll_and_hidden_roll_is_private() -> None:
    services = _services()
    room = "tui:group:structured-multi-dice"
    ctx = AgentCtx(chat_key=room, user_id="u1", platform="tui", locale="en")
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)
    hub = RoomHub()
    origin = RecordingMember("u1", "Nora")
    peer = RecordingMember("u2", "Mina")
    await hub.subscribe(room, origin)
    await hub.subscribe(room, peer)
    origin.events.clear()
    peer.events.clear()

    seed_dice(7)
    await run_turn(
        hub,
        services,
        ctx,
        ".roll 3#1d6",
        command_router=router,
        toolset=toolset,
        origin=origin,
    )
    assert len([event for event in origin.events if event.kind == "dice"]) == 3
    assert len([event for event in peer.events if event.kind == "dice"]) == 3

    origin.events.clear()
    peer.events.clear()
    seed_dice(8)
    await run_turn(
        hub,
        services,
        ctx,
        ".rh 1d20",
        command_router=router,
        toolset=toolset,
        origin=origin,
    )
    assert len([event for event in origin.events if event.kind == "dice"]) == 1
    assert not [event for event in peer.events if event.kind == "dice"]
