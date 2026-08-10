"""M20 E: the Scribe is the habits document's author, at zero extra model calls.

The lane exists because `pop_whispers` is read-and-clear: every observation about how the
table plays was discarded one turn after it was made, so the session-12 Keeper understood
this table no better than the session-1 Keeper did. The Scribe already reads the whole
turn to reconcile trackers, so noticing a habit costs nothing new — what it lacks is
anywhere to keep a count, which is the `pending` section's whole job.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.prompt_builder import habit_index
from agent.scribe import run_scribe
from agent.services import build_services
from core.table_habits import HABITS_DOC_TYPE, HABITS_ID, PROMOTION_THRESHOLD
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM

CHAT = "habits-room"
HABIT = "They lose patience with long combats."


def _services(payload: dict):
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(responder=lambda messages, tools: ChatResult(content=json.dumps(payload), tool_calls=[])),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True
    return services


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="u1", locale="en")


async def test_a_repeated_observation_becomes_a_habit_and_reaches_the_prompt_index():
    services = _services({"ops": [], "whispers": [], "habit": {"summary": HABIT, "detail": "Third time."}})

    for sighting in range(1, PROMOTION_THRESHOLD):
        await run_scribe(services, _ctx(), "we skip ahead", "The fight ends quickly.")
        assert await habit_index(services, CHAT) == [], f"promoted after only {sighting} sighting(s)"

    await run_scribe(services, _ctx(), "we skip ahead", "The fight ends quickly.")

    assert await habit_index(services, CHAT) == [HABIT]


async def test_a_one_off_observation_stays_in_the_waiting_room():
    services = _services({"ops": [], "whispers": [], "habit": {"summary": HABIT}})

    await run_scribe(services, _ctx(), "we skip ahead", "The fight ends quickly.")

    document = await services.documents.get(CHAT, HABITS_DOC_TYPE, HABITS_ID)
    assert document is not None
    assert document.data["pending"] and document.data["pending"][0]["seen"] == 1
    assert await habit_index(services, CHAT) == [], "an unproven candidate must not reach the prompt"


async def test_a_turn_with_no_habit_writes_nothing():
    services = _services({"ops": [], "whispers": [], "habit": None})

    await run_scribe(services, _ctx(), "we press on", "The corridor bends left.")

    assert await services.documents.get(CHAT, HABITS_DOC_TYPE, HABITS_ID) is None


async def test_the_habits_lane_costs_no_extra_model_call():
    """The argument for putting this on the Scribe rather than anywhere else."""
    services = _services({"ops": [], "whispers": [], "habit": {"summary": HABIT}})

    await run_scribe(services, _ctx(), "we skip ahead", "The fight ends quickly.")

    assert len(services.llm.calls) == 1
