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
        (".roll 2d6+1", {"expr", "rolls", "total", "detail"}),
        (".check spot hidden", {"expr", "rolls", "total", "target", "outcome", "detail"}),
        (".sanity 0/1d4", {"expr", "total", "target", "subsystem", "outcome", "detail"}),
        (".opposed spot, listen", {"expr", "total", "target", "outcome", "detail"}),
        (".init roll", {"expr", "rolls", "total", "detail", "name"}),
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


async def test_coc_command_roll_check_opposed_and_sanity_are_recorded_structurally() -> None:
    services = _services()
    room = "tui:group:command-recording"
    ctx = AgentCtx(chat_key=room, user_id="u1", platform="tui", locale="en")
    router = CommandRouter(services)
    await router.dispatch(ctx, ".coc Investigator")

    seed_dice(51)
    roll_reply = await router.dispatch_reply(ctx, ".r 2d6+1")
    seed_dice(52)
    check_reply = await router.dispatch_reply(ctx, ".ra b1 spot hidden")
    seed_dice(53)
    alias_reply = await router.dispatch_reply(ctx, ".rc listen")
    seed_dice(54)
    sanity_reply = await router.dispatch_reply(ctx, ".sc 0/1d4")

    assert roll_reply is not None
    assert check_reply is not None
    assert alias_reply is not None
    assert sanity_reply is not None
    check_frame = check_reply.events[0].data
    assert check_frame["outcome"]["label"]
    assert check_frame["outcome"]["id"]
    assert isinstance(check_frame["outcome"]["tier"], int)
    assert sanity_reply.events[0].data["outcome"]["label"]

    record = await services.battles.generator.get_current_session(room)
    assert record is not None
    assert len(record.dice_rolls) == 1
    assert record.dice_rolls[0]["user_id"] == ctx.uid()
    assert record.dice_rolls[0]["expression"] == "2d6+1"
    assert len(record.skill_checks) == 3
    check = record.skill_checks[0]
    assert check["user_id"] == ctx.uid()
    assert check["skill"] == "侦查"
    assert isinstance(check["success"], bool)
    assert isinstance(check["rank_id"], str)
    assert isinstance(check["tier"], int)
    assert isinstance(check["critical"], bool)
    assert isinstance(check["fumble"], bool)
    assert check["label"]
    assert check["bonus"] == 1
    assert check["penalty"] == 0
    assert isinstance(check["base_roll"], int)
    assert len(check["extra_tens"]) == 1
    assert isinstance(check["final_tens"], int)
    san = record.skill_checks[-1]
    assert san["skill"] == "SAN"
    assert san["loss_expr"] in {"0", "1d4"}
    assert isinstance(san["loss"], int)
    assert san["stat_before"] >= san["stat_after"]


async def test_panel_refreshes_the_callers_hud_through_the_reply_events_alone() -> None:
    """`.panel` used to be a command name the turn pipeline recognized (a state refresh
    keyed on `canonical == "panel"`). Now the command attaches its own `Event.panel` to
    the reply, so the pipeline treats it like any other private command: the caller gets
    the text and one state frame, the room gets nothing."""
    services = _services()
    room = "tui:group:panel-hud"
    ctx = AgentCtx(chat_key=room, user_id="u1", platform="tui", locale="en")
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)

    hub = RoomHub()
    origin = RecordingMember("u1", "Nora")
    peer = RecordingMember("u2", "Mina")
    await hub.subscribe(room, origin)
    await hub.subscribe(room, peer)

    await run_turn(hub, services, ctx, ".panel", command_router=router, toolset=toolset, origin=origin)

    panels = [event for event in origin.events if event.kind == "panel"]
    assert len(panels) == 1 and panels[0].data.get("type") == "state" and panels[0].private
    replies = [event for event in origin.events if event.kind == "narrative"]
    assert len(replies) == 1 and replies[0].private
    assert all(event.kind not in ("panel", "narrative") for event in peer.events)
