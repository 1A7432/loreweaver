"""Tests for the KP-skills mature-mode censor gate (Layer B.1).

A room with a KP skill enabled whose `content_rating` is mature/explicit (the
built-in `mature-mode` skill) bypasses the output word-filter ENTIRELY for
that room, regardless of the configured `Censor` — see
`gateway.ops.room_content_unfiltered` and `gateway.turn.run_turn`. Every other
room keeps the configured `Censor`'s behavior exactly as before.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.hub import RoomHub
from gateway.ops import Censor, get_enabled_skills, room_content_unfiltered, set_enabled_skills
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

REPLY_TEXT = "The naughtyword lingers in the air."


def _responder(messages, tools):
    return assistant_text(REPLY_TEXT)


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(responder=_responder), embeddings=FakeEmbeddings(8))


async def _run(services, chat_key: str, censor: Censor):
    hub = RoomHub()
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")
    return await run_turn(
        hub, services, ctx, "I greet the shopkeeper", command_router=router, toolset=toolset, censor=censor
    )


async def test_room_content_unfiltered_false_by_default() -> None:
    services = _services()
    assert not await room_content_unfiltered(services.store, "room-plain")


async def test_room_content_unfiltered_true_once_mature_skill_enabled() -> None:
    services = _services()
    chat_key = "room-mature-flag"
    await set_enabled_skills(services.store, chat_key, ["mature-mode"])

    assert await get_enabled_skills(services.store, chat_key) == ["mature-mode"]
    assert await room_content_unfiltered(services.store, chat_key)


async def test_censor_still_applies_without_a_mature_skill_enabled() -> None:
    services = _services()
    censor = Censor({"naughtyword": 5})

    result = await _run(services, "room-no-mature-skill", censor)

    assert result is not None
    assert "naughtyword" not in result.reply  # masked by the configured Censor, as before


async def test_censor_is_bypassed_once_a_mature_skill_is_enabled_for_the_room() -> None:
    services = _services()
    censor = Censor({"naughtyword": 5})
    chat_key = "room-with-mature-skill"
    await set_enabled_skills(services.store, chat_key, ["mature-mode"])

    result = await _run(services, chat_key, censor)

    assert result is not None
    assert "naughtyword" in result.reply  # the mature-mode gate bypassed the word-filter entirely


async def test_censor_bypass_is_room_scoped_not_global() -> None:
    """Enabling the mature skill in ONE room must not affect a DIFFERENT room's censor."""
    services = _services()
    censor = Censor({"naughtyword": 5})
    await set_enabled_skills(services.store, "room-a-mature", ["mature-mode"])

    unaffected = await _run(services, "room-b-plain", censor)
    affected = await _run(services, "room-a-mature", censor)

    assert unaffected is not None and "naughtyword" not in unaffected.reply
    assert affected is not None and "naughtyword" in affected.reply
