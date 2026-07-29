"""Tests for agent.loop's MVU compatibility seam: `<UpdateVariable>` text blocks in the KP's
final reply are parsed and applied to the room's MVU tree by deterministic code, then stripped
from the player-visible narration (and from persisted history)."""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.loop import run_kp_turn
from agent.services import build_services
from agent.tools import Toolset
from core.mvu_compat import MvuManager
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text


def _services(llm):
    return build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))


def _ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale="en")


UPDATE_REPLY = (
    "She smiles at you, warmer than before.\n"
    "<UpdateVariable>\n"
    "<Analysis>理.好感度: Y</Analysis>\n"
    "_.set('理.好感度', 33, 35);//pleasant conversation\n"
    "</UpdateVariable>"
)


async def test_update_blocks_are_applied_and_stripped_from_the_reply():
    services = _services(FakeLLM(script=[assistant_text(UPDATE_REPLY)]))
    ctx = _ctx("chat-mvu-1")
    await MvuManager(services.store).init_from_initvar(ctx.chat_key, {"理": {"好感度": [33, "affinity"]}})

    result = await run_kp_turn(ctx, services, Toolset(), "I compliment her.")

    assert result.reply.strip() == "She smiles at you, warmer than before."
    assert "UpdateVariable" not in result.reply
    tree = await MvuManager(services.store).load(ctx.chat_key)
    assert tree["理"]["好感度"][0] == 35


async def test_persisted_history_stores_the_cleaned_reply():
    services = _services(FakeLLM(script=[assistant_text(UPDATE_REPLY)]))
    ctx = _ctx("chat-mvu-2")
    await MvuManager(services.store).init_from_initvar(ctx.chat_key, {"理": {"好感度": [33, "affinity"]}})

    await run_kp_turn(ctx, services, Toolset(), "I compliment her.")

    raw = await services.store.get(user_key="", store_key=f"chat_history.{ctx.chat_key}")
    history = json.loads(raw)
    assert all("UpdateVariable" not in message.get("content", "") for message in history)


async def test_reply_without_blocks_is_untouched():
    text = "Nothing stirs in the chapel."
    services = _services(FakeLLM(script=[assistant_text(text)]))

    result = await run_kp_turn(_ctx("chat-mvu-3"), services, Toolset(), "I look around.")

    assert result.reply == text
