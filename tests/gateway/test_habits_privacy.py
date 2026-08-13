"""Sentinel for `.habits` on the WIRE: the Scribe's notes about the PLAYERS reach
only the keeper connection that asked for them.

`core.table_habits.project_habits` already returns `None` for player viewers, but that
filter guards reads through `core.documents.project` — a command reply is a different
lane entirely: `cmd_habits` reads the raw document (keeper-gated at the TYPING end) and
its reply rides `gateway.turn.run_turn`'s delivery. Without `private_reply` on the
CommandSpec the reply went to `hub.publish`, and every member of the room received the
table's own behavioural profile verbatim ("they lose patience with long combats") — the
exact hand-back the module's docstring calls a metagaming leak. This pins the unicast,
with the keeper's own copy as the positive control so it cannot pass vacuously.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from core.table_habits import HABITS_DOC_TYPE, HABITS_ID
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

ROOM = "tui:group:habits-wire"
SENTINEL = "they lose patience with long combats"


class _Member:
    transport = "tui"

    def __init__(self, member_id: str) -> None:
        self.id = member_id
        self.user_key = member_id
        self.name = member_id
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _texts(member: _Member) -> str:
    return " ".join(event.text or "" for event in member.events if event.kind == "narrative")


async def test_habits_reply_reaches_only_the_keeper():
    services = build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    hub = RoomHub()
    keeper, player = _Member("keeper"), _Member("player")
    await hub.subscribe(ROOM, keeper)
    await hub.subscribe(ROOM, player)
    await services.documents.put(
        ROOM, HABITS_DOC_TYPE, HABITS_ID, {"habits": [{"summary": SENTINEL, "detail": ""}], "pending": []}
    )
    ctx = AgentCtx(chat_key=ROOM, user_id="keeper", platform="cli", locale="en")

    await run_turn(
        hub,
        services,
        ctx,
        ".habits",
        command_router=CommandRouter(services, hub=hub),
        toolset=build_kp_toolset(services),
        origin=keeper,
        actor_name="Keeper",
    )

    assert SENTINEL in _texts(keeper)  # positive control — the keeper still gets the notes
    assert SENTINEL not in _texts(player), ".habits must never broadcast the table's profile of itself"
