"""M21: the Scribe is the chronicle's automatic author, at zero extra model calls.

M18 gave the chronicle its documents, its fold and its topical recall — and left the
KEEPER calling `record_chronicle` as the only thing that could ever author a record. So
durable campaign memory rested on model discipline, which is the exact failure the
Scribe was built to stop resting on (M20 E's argument, one axis over). It rested on it
twice over: the fold is also the ONLY place history is ever trimmed
(`agent.history.trim_folded`), so a Keeper who never recorded got no long-term memory
AND an unbounded replayed history.

The turn STAMP is the load-bearing detail most of these tests exist to pin. The Scribe
runs after `run_kp_turn` has returned — and after any companion sub-turns — so the room's
counter has already moved past the turn the pass actually read. Deriving the stamp there
(M18's path, correct for the in-turn tool) would file every record one or more indices
ahead of itself, and since `trim_folded` drops history BY TURN INDEX, folding such a
record would silently cut turns no summary ever covered.
"""

from __future__ import annotations

import json

from agent.chronicle import CHRONICLE_DOC_TYPE, advance_chronicle_turn
from agent.context import AgentCtx
from agent.history import trim_folded
from agent.scribe import _MAX_CHRONICLE_CHARS, run_scribe
from agent.services import build_services
from core.documents import PLAYER_VIEWER, project
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM

CHAT = "auto-chronicle-room"
RECORD = "The party rang the chapel bell and the tide answered."
SENTINEL = "THE SUNKEN BELL MUST NEVER RING"


def _services(payload: dict):
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(responder=lambda messages, tools: ChatResult(content=json.dumps(payload), tool_calls=[])),
        embeddings=FakeEmbeddings(64),
    )
    # The suite-wide conftest turns both of these OFF; this lane is their intersection.
    services.settings.scribe.enabled = True
    services.settings.chronicle.enabled = True
    return services


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="u1", locale="en")


async def _records(services):
    return await services.documents.list(CHAT, CHRONICLE_DOC_TYPE)


async def test_a_material_turn_is_recorded_without_the_keeper_calling_anything():
    """The milestone in one line: durable memory with no tool call and no discipline."""
    services = _services({"ops": [], "whispers": [], "chronicle": RECORD})

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", [], 7)

    docs = await _records(services)
    assert len(docs) == 1
    assert docs[0].data["text"] == RECORD
    assert docs[0].data["turn"] == 7


async def test_the_stamp_is_the_turn_that_happened_not_the_counter_that_moved_on():
    """The Scribe runs late; the counter does not wait for it."""
    services = _services({"ops": [], "whispers": [], "chronicle": RECORD})
    # The pass read turn 5. Since then the counter advanced for that turn and again for
    # each companion sub-turn that followed it.
    for _ in range(8):
        await advance_chronicle_turn(services.store, CHAT)

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", [], 5)

    assert (await _records(services))[0].data["turn"] == 5, "a record must name the turn it summarises"


async def test_the_stamp_lets_a_fold_trim_exactly_what_it_summarised():
    """The consequence of the stamp, spelled out end to end.

    `trim_folded` drops history by turn index, so a record filed ahead of itself would
    take later, unsummarised turns down with it when it folded. This is that safety
    property as an assertion rather than as a comment.
    """
    services = _services({"ops": [], "whispers": [], "chronicle": RECORD})
    for _ in range(9):
        await advance_chronicle_turn(services.store, CHAT)

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", [], 5)
    stamp = (await _records(services))[0].data["turn"]

    chain = [{"role": "user", "content": "…", "_lw_turn": index} for index in range(1, 10)]
    kept = await trim_folded(services, CHAT, "chat_history", chain, stamp)

    assert [message["_lw_turn"] for message in kept] == [6, 7, 8, 9], "later turns survive the fold"


async def test_the_auto_record_is_player_grade_and_carries_no_keeper_margin():
    """Iron rule #3, structurally: this path cannot author keeper-side material at all.

    The spoiler margin stays exclusively on the voluntary tool, where the Keeper writes it
    deliberately — so whatever the model emitted alongside, an auto-record holds nothing a
    player projection would have to strip.
    """
    services = _services(
        {"ops": [], "whispers": [], "chronicle": RECORD, "keeper": SENTINEL, "keeper_notes": SENTINEL}
    )

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", [], 3)

    doc = (await _records(services))[0]
    assert doc.data["keeper"] == ""
    assert SENTINEL not in json.dumps(doc.data, ensure_ascii=False), "no keeper margin is authored here"
    dumped = json.dumps(project(doc, PLAYER_VIEWER), ensure_ascii=False)
    assert RECORD in dumped, "the record itself is table-public — that is what it is for"
    assert SENTINEL not in dumped


async def test_a_quiet_turn_records_nothing():
    services = _services({"ops": [], "whispers": [], "chronicle": ""})

    await run_scribe(services, _ctx(), "what do I see?", "Dust, and the smell of salt.", [], 4)

    assert await _records(services) == []


async def test_a_turn_the_keeper_recorded_deliberately_is_not_recorded_twice():
    services = _services({"ops": [], "whispers": [], "chronicle": RECORD})

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", ["record_chronicle"], 6)

    assert await _records(services) == [], "the Keeper's own record stands; a near-duplicate is noise"


async def test_a_turn_that_never_committed_records_nothing():
    """`KPTurnResult.turn` is 0 on the provider-error early return: that path writes no
    history and never advances the counter, so there is no turn to record against — and a
    record on a turn with no history is exactly what over-trims later."""
    services = _services({"ops": [], "whispers": [], "chronicle": RECORD})

    await run_scribe(services, _ctx(), "we ring the bell", "The Keeper is unavailable.", [], 0)

    assert await _records(services) == []


async def test_the_lane_can_be_switched_off():
    services = _services({"ops": [], "whispers": [], "chronicle": RECORD})
    services.settings.chronicle.auto_record = False

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", [], 2)

    assert await _records(services) == []


async def test_a_runaway_record_is_bounded():
    services = _services({"ops": [], "whispers": [], "chronicle": "x" * 5_000})

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", [], 2)

    assert len((await _records(services))[0].data["text"]) == _MAX_CHRONICLE_CHARS


async def test_the_chronicle_lane_costs_no_extra_model_call():
    """The argument for putting this on the Scribe rather than anywhere else."""
    services = _services({"ops": [], "whispers": [], "chronicle": RECORD})

    await run_scribe(services, _ctx(), "we ring the bell", "The bell tolls once.", [], 1)

    assert len(services.llm.calls) == 1
