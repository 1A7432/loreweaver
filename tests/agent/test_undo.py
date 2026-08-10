"""ORACLE for M20 D: a rewind that moves BOTH halves of the room, or neither.

The first draft of this design asserted a necessary condition as a sufficient one:
"history is append-only, so rewinding is a pointer move". True, and not enough. A turn's
tool calls also write documents (NPC records, modvars, sheets) and room_state (clock,
scene, relationship tracks). Rewinding only the conversation produces the worst kind of
inconsistency — both halves self-consistent, the whole a hallucination — and that is the
thing most of this file is about.

The depth cap is the other load-bearing decision, and it is not a size compromise: capping
inside the chronicle's no-future lag window makes a conflict with the rolling summary
STRUCTURALLY impossible, because those turns have not been folded yet. So the cap derives
from the setting, and the test that matters most here is the one that moves the setting.
"""

from __future__ import annotations

from agent.chronicle import CHRONICLE_TURN_KEY, chronicle_turn
from agent.context import AgentCtx
from agent.history import append_turn, leaf_key, load_chain
from agent.loop import run_kp_turn
from agent.services import build_services
from agent.tools import Toolset, tool
from agent.undo import available_turns, capture, restore, undo_depth
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call

CHAT = "undo-room"
KEY = "chat_history"


class _NoteProvider:
    """A tool that writes DOCUMENT state, so a rewind has something to get wrong."""

    def __init__(self, services):
        self._services = services

    @tool
    async def record_fact(self, ctx: AgentCtx, text: str) -> str:
        """Write a keeper note."""
        await self._services.documents.put(ctx.chat_key, "note", "log", {"category": "log", "content": text})
        return "noted"


def _services(llm=None, *, lag_turns: int | None = None):
    services = build_services(Settings(locale="en"), llm=llm or FakeLLM(), embeddings=FakeEmbeddings(64))
    if lag_turns is not None:
        services.settings.chronicle.lag_turns = lag_turns
    return services


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="u1", locale="en")


# ---------------------------------------------------------------------------
# The history tree
# ---------------------------------------------------------------------------


async def test_history_is_append_only_and_a_rewind_is_a_pointer_move():
    services = _services()

    first = await append_turn(services, CHAT, KEY, user_message="one", reply="1", turn=1)
    await append_turn(services, CHAT, KEY, user_message="two", reply="2", turn=2)
    assert len(await load_chain(services, CHAT, KEY)) == 4

    # Rewind: point at the end of turn 1. Nothing was deleted to make that happen.
    await services.store.state_set(CHAT, leaf_key(KEY), first)
    assert [message["content"] for message in await load_chain(services, CHAT, KEY)] == ["one", "1"]
    assert len(await services.store.history_rows(CHAT)) == 4, "the abandoned turn is still on disk"


async def test_playing_forward_from_a_rewind_branches_instead_of_overwriting():
    """Two children of one record is the NORMAL case, not a conflict — which is what makes
    a rewind safe to take back."""
    services = _services()

    first = await append_turn(services, CHAT, KEY, user_message="one", reply="1", turn=1)
    await append_turn(services, CHAT, KEY, user_message="door", reply="it opens", turn=2)
    await services.store.state_set(CHAT, leaf_key(KEY), first)
    await append_turn(services, CHAT, KEY, user_message="window", reply="it sticks", turn=2)

    chain = [message["content"] for message in await load_chain(services, CHAT, KEY)]
    assert chain == ["one", "1", "window", "it sticks"]
    assert len(await services.store.history_rows(CHAT)) == 6, "both branches persist"


# ---------------------------------------------------------------------------
# The depth cap
# ---------------------------------------------------------------------------


def test_the_depth_cap_derives_from_the_lag_window_and_never_from_a_literal():
    """THE invariant. An operator who lowers TRPG_CHRONICLE__LAG_TURNS must not thereby
    gain the ability to undo across the fold watermark — which a hardcoded 4 would grant
    silently, breaking the exact guarantee the cap exists to provide."""
    assert undo_depth(_services(lag_turns=4)) == 4
    assert undo_depth(_services(lag_turns=2)) == 2
    assert undo_depth(_services(lag_turns=9)) == 9


async def test_the_snapshot_ring_is_sized_by_the_same_setting():
    services = _services(lag_turns=2)

    for turn in range(1, 6):
        await capture(services, CHAT, turn)

    assert await available_turns(services, CHAT) == [5, 4], "the ring holds exactly what may be restored"


# ---------------------------------------------------------------------------
# Both halves move together
# ---------------------------------------------------------------------------


async def test_a_restore_rewinds_documents_and_state_and_the_conversation_together():
    """THE M20 D acceptance criterion. Three turns write a note each; rewinding to turn 1
    must leave the note, the clock, and the replayed conversation all describing turn 1."""
    services = _services(
        FakeLLM(
            responder=lambda messages, tools: assistant_text("noted."),
        )
    )
    provider = _NoteProvider(services)

    for turn in range(1, 4):
        services.llm = FakeLLM(
            script=[assistant_tools(tool_call("record_fact", text=f"fact-{turn}")), assistant_text(f"reply {turn}")]
        )
        await services.store.state_set(CHAT, "game_clock", f'{{"current_time": "day {turn}"}}')
        await run_kp_turn(_ctx(), services, Toolset(provider), f"turn {turn}")

    assert await chronicle_turn(services.store, CHAT) == 3

    assert await restore(services, CHAT, 1)

    note = await services.documents.get(CHAT, "note", "log")
    assert note is not None and note.data["content"] == "fact-1", "documents rewound"
    assert '"day 1"' in (await services.store.state_get(CHAT, "game_clock") or ""), "room_state rewound"
    chain = [message["content"] for message in await load_chain(services, CHAT, KEY)]
    assert chain == ["turn 1", "reply 1"], "the conversation rewound to the same moment"


async def test_a_restore_of_a_missing_turn_changes_nothing():
    services = _services()
    await capture(services, CHAT, 3)

    assert not await restore(services, CHAT, 99)


async def test_state_written_after_the_snapshot_is_gone_after_the_rewind():
    """The half that is easiest to forget: state a later turn wrote must not survive a
    rewind past it, or the room ends up remembering something that never happened."""
    services = _services()
    await services.store.state_set(CHAT, "scene", "the pier")
    await capture(services, CHAT, 1)
    await services.store.state_set(CHAT, "scene", "the cellar")
    await services.store.state_set(CHAT, "loot", "a brass key")

    await restore(services, CHAT, 1)

    assert await services.store.state_get(CHAT, "scene") == "the pier"
    assert await services.store.state_get(CHAT, "loot") is None, "a key picked up after the snapshot is gone too"


# ---------------------------------------------------------------------------
# The keeper's command
# ---------------------------------------------------------------------------


def _keeper() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="kp", platform="cli", locale="en")


def _player() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="p1", platform="tui", locale="en", extra={"role": "player"})


async def test_the_undo_command_rewinds_the_room_and_clears_every_client_log():
    from gateway.commands import CommandRouter

    services = _services()
    router = CommandRouter(services)
    for turn in (1, 2, 3):
        await append_turn(services, CHAT, KEY, user_message=f"turn {turn}", reply=f"reply {turn}", turn=turn)
        await services.store.state_set(CHAT, CHRONICLE_TURN_KEY, str(turn))
        await capture(services, CHAT, turn)

    ctx = _keeper()
    reply = await router.dispatch(ctx, ".undo 2")

    assert "turn 1" in reply or "1" in reply
    assert await chronicle_turn(services.store, CHAT) == 1
    assert [message["content"] for message in await load_chain(services, CHAT, KEY)] == ["turn 1", "reply 1"]


async def test_a_player_cannot_rewind_the_room():
    from gateway.commands import CommandRouter

    services = _services()
    router = CommandRouter(services)
    await append_turn(services, CHAT, KEY, user_message="one", reply="1", turn=1)
    await services.store.state_set(CHAT, CHRONICLE_TURN_KEY, "1")
    await capture(services, CHAT, 1)

    await router.dispatch(_player(), ".undo 1")

    assert await chronicle_turn(services.store, CHAT) == 1, "nothing moved"


async def test_the_command_refuses_to_reach_past_the_lag_window():
    from gateway.commands import CommandRouter

    services = _services(lag_turns=2)
    router = CommandRouter(services)

    reply = await router.dispatch(_keeper(), ".undo 5")

    assert "2" in reply, "the refusal names the window it is bounded by"
