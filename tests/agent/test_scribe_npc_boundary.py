"""The Scribe's NPC boundary watch — born from k3 run 2 (2026-08-13).

That run's KP voiced every NPC directly (the sub-actor channel went uncalled for all
74 turns) and held every knowledge boundary on discipline alone, which broke exactly
once: an NPC spoke a secret name her record does not contain. A guard nobody walks
past guards nothing, so the boundary moved to where the Scribe already sits: watch
the reply, whisper to the Keeper, never touch the fiction — the same watcher-actor
line as the unrolled-check note.

FUZZY BY DESIGN (owner call, 2026-08-13): a knowledge list marks secret boundaries,
not a complete mind, so the crossing judgment belongs to the Scribe MODEL. What the
ENGINE pins — and what these tests pin — is the frame around that judgment: the watch
arms only where records exist, the note survives only the same verbatim-evidence gate
every other Scribe claim passes, and a name the model invented cannot smuggle one in.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.npc import create_npc
from agent.scribe import WHISPERS_KEY, pop_whispers, run_scribe
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM

CHAT = "npc-boundary-room"
REPLY = 'A-heng wipes the counter and says: "The Tilted Conch is counting. It counts to three."'
CROSSING = {"npc": "A-heng", "quote": "The Tilted Conch is counting.", "fact": "named the entity"}


def _services(payload: dict, prompts: list[str] | None = None):
    def responder(messages, tools):
        if prompts is not None:
            prompts.append(messages[0]["content"])
        return ChatResult(content=json.dumps(payload), tool_calls=[])

    services = build_services(
        Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(64)
    )
    # The suite-wide conftest turns the scribe off; this file is about it.
    services.settings.scribe.enabled = True
    return services


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="u1", locale="en")


async def _seed_scoped_npc(services, name: str = "A-heng") -> None:
    await create_npc(
        services.documents,
        CHAT,
        name,
        persona="innkeeper",
        knowledge=["ran the inn for twelve years", "saw the oar strike"],
    )


async def test_a_crossing_becomes_a_whisper_and_the_watch_shows_the_records():
    prompts: list[str] = []
    services = _services({"ops": [], "whispers": [], "npc_overreach": CROSSING}, prompts)
    await _seed_scoped_npc(services)

    await run_scribe(services, _ctx(), "I ask her about the lamps.", REPLY)

    whispers = await pop_whispers(services, CHAT)
    assert len(whispers) == 1
    assert "A-heng" in whispers[0] and "named the entity" in whispers[0]
    # The pass actually showed the boundary it judged against: name and facts, in-prompt.
    assert "NPC knowledge boundaries" in prompts[0]
    assert "A-heng | ran the inn for twelve years; saw the oar strike" in prompts[0]


async def test_a_quote_not_in_the_reply_is_discarded():
    """The evidence gate: a crossing that cannot quote the reply never reaches the Keeper."""
    services = _services(
        {"ops": [], "whispers": [], "npc_overreach": {**CROSSING, "quote": "She never said this."}}
    )
    await _seed_scoped_npc(services)

    await run_scribe(services, _ctx(), "I ask her about the lamps.", REPLY)

    assert await pop_whispers(services, CHAT) == []


async def test_an_npc_the_watch_never_listed_cannot_smuggle_a_note():
    services = _services({"ops": [], "whispers": [], "npc_overreach": {**CROSSING, "npc": "Stranger"}})
    await _seed_scoped_npc(services)  # the watch IS armed — just not for this name

    await run_scribe(services, _ctx(), "I ask her about the lamps.", REPLY)

    assert await pop_whispers(services, CHAT) == []


async def test_a_room_without_knowledge_records_pays_nothing_and_ignores_the_field():
    """No records -> the prompt carries no watch block (byte-identical lane cost) and a
    volunteered `npc_overreach` is a hallucination, ignored rather than gated on."""
    prompts: list[str] = []
    services = _services({"ops": [], "whispers": [], "npc_overreach": CROSSING}, prompts)
    # An NPC with an EMPTY knowledge list draws no boundary and arms nothing.
    await create_npc(services.documents, CHAT, "A-heng", persona="innkeeper")

    await run_scribe(services, _ctx(), "I ask her about the lamps.", REPLY)

    assert await pop_whispers(services, CHAT) == []
    assert "NPC knowledge boundaries" not in prompts[0]
    assert "npc_overreach" not in prompts[0]
    assert await services.store.state_get(CHAT, WHISPERS_KEY) in (None, "")
