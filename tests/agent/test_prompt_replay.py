"""M23 WS3 acceptance: the same persisted room state re-assembles the same prompt.

`tests/architecture/test_prompt_replayability.py` proves no NEW unreplayable input can
be added. This proves the two that existed are gone: a second process, reading nothing
but the store, rebuilds a prompt byte-identical to the one the model saw — including the
segments that used to come from an unseeded generator and from process memory.

The room is built to exercise exactly those two: a worldbook entry gated on
`probability` (a real-code coin flip that decides whether a segment appears at all), an
entry whose body contains a `{{random}}` macro (a real-code choice inside a segment), and
a hook injection (a segment handed over on `ctx.extra` and nowhere else).
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.hook_runtime import record_hook_injections, replay_hook_injections
from agent.prompt_builder import build_system_prompt_parts, turn_rng
from agent.services import build_services
from core.worldbook import LoreEntry
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from infra.store import Store

CHAT_KEY = "replay-room"
TURN = 7


def _services(store: Store):
    return build_services(
        Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8), store=store
    )


def _ctx(extra: dict) -> AgentCtx:
    ctx = AgentCtx(chat_key=CHAT_KEY, user_id="nora", platform="tui", locale="en")
    ctx.extra.update(extra)
    return ctx


async def _seed_room(services) -> None:
    """A room whose prompt depends on both kinds of unreplayable input."""
    # Eight independent coin flips, not one: an UNSEEDED generator would have to agree
    # with itself eight times over for a broken build to pass this by luck.
    for index in range(8):
        await services.worldbook.add(
            CHAT_KEY,
            LoreEntry(
                id="",
                title=f"the tide bell {index}",
                content=f"Bell {index} tolls somewhere under the water.",
                keys=[],
                constant=True,
                probability=50,  # a real coin flip decides whether this segment appears
            ),
        )
    await services.worldbook.add(
        CHAT_KEY,
        LoreEntry(
            id="",
            title="the archivist's mood",
            content="The archivist is {{random: wary, distracted, courteous}} today.",
            keys=[],
            constant=True,
        ),
    )


def test_the_seed_is_a_pure_function_of_persisted_state():
    """Same room, same turn, same stream — same generator, in any process."""
    first = turn_rng(CHAT_KEY, TURN, "worldbook")
    second = turn_rng(CHAT_KEY, TURN, "worldbook")
    assert [first.random() for _ in range(5)] == [second.random() for _ in range(5)]
    # Different turns and different streams do NOT share a sequence, or one lane's draws
    # would shift the other's every time a macro was added.
    assert turn_rng(CHAT_KEY, TURN + 1, "worldbook").random() != first.random()
    assert turn_rng(CHAT_KEY, TURN, "macros").random() != turn_rng(CHAT_KEY, TURN, "worldbook").random()


async def test_a_second_process_rebuilds_the_same_prompt_from_the_store_alone():
    store = Store(":memory:")
    live = _services(store)
    await _seed_room(live)
    await live.store.state_set(CHAT_KEY, "chronicle_turn", str(TURN - 1))  # the turn in flight is TURN

    injections = ["The lamps gutter as you speak.", "A door closes two rooms away."]
    original_extra = {"user_message": "I listen for the bell.", "hook_injections": injections}
    await record_hook_injections(live, CHAT_KEY, TURN, injections)
    original = await build_system_prompt_parts(_ctx(original_extra), live)

    # POSITIVE CONTROL: the room really does put the random-dependent material in play.
    assert "archivist is" in original.text

    # A second process: nothing but the store survives. The hook injections come back from
    # the ring rather than from memory, and a replay is the same turn seen again, so the
    # worldbook's sticky/cooldown counter must not tick a second time.
    replayed_services = _services(store)
    replayed_injections = await replay_hook_injections(replayed_services, CHAT_KEY, TURN)
    assert replayed_injections == injections
    replayed = await build_system_prompt_parts(
        _ctx({"user_message": "I listen for the bell.", "hook_injections": replayed_injections}),
        replayed_services,
        advance_timers=False,
    )

    assert replayed.stable == original.stable
    assert replayed.volatile == original.volatile


async def test_the_hook_injections_reach_the_prompt_and_come_from_the_ring():
    """Without the ring the segment is simply gone from a rebuilt prompt — which is the
    bug this workstream closes, stated as a test."""
    store = Store(":memory:")
    live = _services(store)
    await _seed_room(live)
    await live.store.state_set(CHAT_KEY, "chronicle_turn", str(TURN - 1))
    injections = ["A shutter bangs in the wind."]
    await record_hook_injections(live, CHAT_KEY, TURN, injections)

    with_hooks = await build_system_prompt_parts(
        _ctx({"user_message": "I wait.", "hook_injections": injections}), live
    )
    without_hooks = await build_system_prompt_parts(
        _ctx({"user_message": "I wait."}), _services(store), advance_timers=False
    )

    assert "A shutter bangs in the wind." in with_hooks.text
    assert "A shutter bangs in the wind." not in without_hooks.text
    # ...and the ring is what closes that gap for a process that was not there.
    assert await replay_hook_injections(_services(store), CHAT_KEY, TURN) == injections


async def test_the_ring_keeps_one_entry_per_turn_and_a_bounded_window():
    store = Store(":memory:")
    services = _services(store)
    await record_hook_injections(services, CHAT_KEY, 1, ["first"])
    await record_hook_injections(services, CHAT_KEY, 1, ["first, corrected"])
    assert await replay_hook_injections(services, CHAT_KEY, 1) == ["first, corrected"]

    for turn in range(2, 40):
        await record_hook_injections(services, CHAT_KEY, turn, [f"turn {turn}"])
    assert await replay_hook_injections(services, CHAT_KEY, 39) == ["turn 39"]
    assert await replay_hook_injections(services, CHAT_KEY, 1) == [], "the window is bounded"


async def test_a_turn_with_no_injections_writes_nothing():
    """The ring is a record of what happened, not a row per turn."""
    store = Store(":memory:")
    services = _services(store)
    await record_hook_injections(services, CHAT_KEY, 3, [])
    assert await services.store.state_get(CHAT_KEY, "hook_injections") is None
