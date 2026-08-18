"""The join-replay event lane (`turn_event_history`) — what goes in, what stays, and what
`.undo` does to it.

Every rule here exists because a reconnecting member used to see a different scene than
the one everyone else watched: typed rolls were never recorded, `.undo` deleted the
restored turn's own rolls, a dice-heavy stretch evicted older turns mid-sequence, and a
hook's refusal could be spoken as an NPC's line.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from agent.undo import capture, restore
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.turn import (
    TURN_EVENT_HISTORY_CAP,
    TURN_EVENT_HISTORY_KEY,
    TURN_EVENT_HISTORY_TURNS,
    _npc_events,
    _public_tool_events,
    prune_turn_events,
    record_turn_events,
    run_turn,
    undo_state_rewrite,
)
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
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
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))


async def _lane(services, room: str) -> list[dict]:
    raw = await services.store.state_get(room, TURN_EVENT_HISTORY_KEY)
    return json.loads(raw) if raw else []


# --- the command branch records its PUBLIC rolls, anchored after the last turn --------


async def test_a_typed_roll_joins_the_replay_lane_after_the_last_turn() -> None:
    services = _services()
    room = "tui:group:typed-roll-lane"
    ctx = AgentCtx(chat_key=room, user_id="u1", platform="tui", locale="en")
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)
    await router.dispatch(ctx, ".coc Investigator")
    hub = RoomHub()
    origin = RecordingMember("u1", "Nora")
    await hub.subscribe(room, origin)
    seed_dice(7)

    await run_turn(hub, services, ctx, ".roll 2d6+1", command_router=router, toolset=toolset, origin=origin)

    lane = await _lane(services, room)
    assert len(lane) == 1
    record = lane[0]
    # No AI-Keeper turn has run: the roll sits AFTER turn 0 — the very top of a replay.
    assert record["turn"] == 0 and record["after"] is True
    assert record["event"]["kind"] == "dice"
    assert record["event"]["data"]["actor"] == "Investigator (Nora)"
    published = next(event for event in origin.events if event.kind == "dice")
    assert record["event"]["data"]["total"] == published.data["total"]


async def test_a_hidden_roll_is_private_and_stays_out_of_the_lane() -> None:
    """A private event is a unicast to one connection; a lane re-broadcast to whoever
    joins next has no place for it."""
    services = _services()
    room = "tui:group:hidden-roll-lane"
    ctx = AgentCtx(chat_key=room, user_id="u1", platform="tui", locale="en")
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)
    await router.dispatch(ctx, ".coc Investigator")
    hub = RoomHub()
    origin = RecordingMember("u1", "Nora")
    await hub.subscribe(room, origin)

    await run_turn(hub, services, ctx, ".rh 1d100", command_router=router, toolset=toolset, origin=origin)

    assert [event.kind for event in origin.events if event.kind == "dice"] == ["dice"]
    assert await _lane(services, room) == []


# --- the window is counted in TURNS ---------------------------------------------------


def test_the_lane_keeps_whole_turns_never_half_of_one() -> None:
    """A flat event cap cut at an arbitrary offset: a run of dice-heavy combat turns
    evicted older turns' rolls and left the oldest surviving turn showing only its last
    few rolls — indistinguishable from "nobody rolled the rest"."""
    records = [
        {"turn": turn, "event": {"kind": "dice", "data": {"n": index}}}
        for turn in range(1, TURN_EVENT_HISTORY_TURNS + 11)
        for index in range(12)
    ]
    kept = prune_turn_events(records)
    turns = sorted({record["turn"] for record in kept})
    # The newest forty turns, every one of them complete.
    assert turns[0] == 11 and turns[-1] == TURN_EVENT_HISTORY_TURNS + 10
    assert all(sum(1 for record in kept if record["turn"] == turn) == 12 for turn in turns)
    # Malformed entries do not survive to be replayed.
    assert prune_turn_events([{"turn": "abc"}, "nope", {"turn": 3, "event": {}}]) == [{"turn": 3, "event": {}}]
    # The flat ceiling is a safety net, not the working bound.
    huge = [{"turn": 1, "event": {}}] * (TURN_EVENT_HISTORY_CAP + 5)
    assert len(prune_turn_events(huge)) == TURN_EVENT_HISTORY_CAP
    # "Newest" is by append order, not by the largest turn number: one imported record
    # with an absurd `turn` is one distinct turn among forty — it must not evict every
    # legitimate record and then swallow every future write.
    poisoned = [{"turn": 10**9, "event": {}}, *({"turn": turn, "event": {}} for turn in range(1, 6))]
    kept = prune_turn_events(poisoned)
    assert [record["turn"] for record in kept] == [10**9, 1, 2, 3, 4, 5]
    assert [record["turn"] for record in prune_turn_events([*kept, {"turn": 6, "event": {}}])][-1] == 6


# --- `.undo` keeps the restored turn's own rolls, drops the abandoned future ----------


async def test_undo_keeps_the_restored_turn_s_rolls_and_drops_what_came_after() -> None:
    """The turn-boundary snapshot is taken BEFORE that turn's events are recorded, so a
    restore from the snapshot's copy of the lane deleted the restored turn's own rolls
    while the transcript still ended on its narration."""
    services = _services()
    room = "tui:group:undo-lane"
    for turn in (11, 12, 13):
        # Snapshot first (as `run_kp_turn` does), THEN this turn's events, then a typed
        # roll after it — the real write order.
        await capture(services, room, turn)
        await record_turn_events(services.store, room, turn, [Event.dice(actor="A", kind="check", expr="d", total=turn)])
        await record_turn_events(
            services.store, room, turn, [Event.dice(actor="A", kind="roll", expr="d", total=turn * 100)], after=True
        )

    assert await restore(services, room, 12, state_rewrite=undo_state_rewrite(services.store, room, 12))

    totals = [(record["turn"], bool(record.get("after")), record["event"]["data"]["total"]) for record in await _lane(services, room)]
    assert totals == [
        (11, False, 11),
        (11, True, 1100),
        (12, False, 12),  # turn 12's OWN roll survives the rewind to the end of turn 12
        # (12, True): the roll typed after turn 12 is the abandoned future — gone
        # (13, …): gone
    ]


async def test_undo_without_the_rewrite_would_lose_the_restored_turn_s_rolls() -> None:
    """The control for the test above: the seam is what carries the fix."""
    services = _services()
    room = "tui:group:undo-lane-control"
    await capture(services, room, 12)
    await record_turn_events(services.store, room, 12, [Event.dice(actor="A", kind="check", expr="d", total=12)])
    assert await restore(services, room, 12)
    assert await _lane(services, room) == []


# --- NPC lines come from the structural channel, never from a tool's return string ---


def test_npc_lines_are_built_from_what_the_tool_emitted_not_from_its_result() -> None:
    i18n = get_i18n("en")
    spoken = {
        "name": "speak_as_npc",
        "arguments": {"npc": "Martha"},
        "result": "Martha (uneasy): I heard the gate.",
        "npc_lines": [{"name": "Martha", "text": "Martha (uneasy): I heard the gate."}],
    }
    assert [event.name for event in _npc_events(spoken, i18n)] == ["Martha"]

    # A hook vetoed the call: the trace carries the refusal as RESULT and `suppressed`.
    vetoed = {
        "name": "speak_as_npc",
        "arguments": {"npc": "Martha"},
        "result": "Tool speak_as_npc was refused by a room hook: not now",
        "suppressed": True,
    }
    assert _npc_events(vetoed, i18n) == []
    # An unknown NPC, a gated tool, a prep-only tool: a result string, no emitted line.
    errored = {"name": "speak_as_npc", "arguments": {"npc": "Nobody"}, "result": "❌ No NPC found matching Nobody"}
    assert _npc_events(errored, i18n) == []
    assert _public_tool_events(errored, "Nora", i18n) == []
    # And a keeper-only call has no public consequences at all.
    keeper = {**spoken, "keeper_only": True}
    assert _public_tool_events(keeper, "Nora", i18n) == []


async def test_speak_as_npc_emits_its_line_on_success_only() -> None:
    """The tool's own contract, end to end: a voiced line lands on the ctx channel; a
    missing NPC returns its message and emits nothing."""
    from agent.kp_tools_npc import NpcTools

    services = _services()
    ctx = AgentCtx(chat_key="tui:group:npc-emit", user_id="u1", platform="tui", locale="en")
    tools = NpcTools(services)
    reply = await tools.speak_as_npc(ctx, npc="Nobody", situation="…")
    assert "Nobody" in reply
    assert ctx.consume_npc_lines() == []
