"""Tests for gateway.turn._record_usage_stats: the rolling per-room token/cache
usage aggregate `run_turn` best-effort persists after a real (non-command) AI-KP
turn, read back by `net.state.build_room_state` as `state.usage` (see
`tests/net/test_state_usage.py` for that side of the wiring).
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from gateway.commands import CommandReply
from gateway.hub import RoomHub
from gateway.session import SessionSource
from gateway.turn import run_turn
from infra.config import LLMSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, Usage, context_window_for

# Pin the model explicitly so the expected context-window is deterministic and offline
# (CLAUDE.md) -- `Settings()`'s default chat_model otherwise varies with an untracked local
# `.env`, and a clean checkout/CI would resolve a different window than a dev sandbox.
_CHAT_MODEL = "deepseek-chat"
_WINDOW = context_window_for(_CHAT_MODEL)


class _NullRouter:
    """A command-router stand-in that never resolves/dispatches a command, so
    `run_turn` always falls through to the real AI-KP turn (`run_kp_turn`) --
    mirrors `tests/gateway/test_turn_locks.py`'s duck-typed router stand-ins."""

    def resolve(self, text: str, locale: str):
        return None

    async def dispatch_reply(self, ctx: AgentCtx, text: str) -> CommandReply | None:
        return None


def _ctx(room: str) -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id="p1", platform="tui", locale="en")


def _services(responder):
    return build_services(
        Settings(locale="en", llm=LLMSettings(chat_model=_CHAT_MODEL)),
        llm=FakeLLM(responder=responder),
        embeddings=FakeEmbeddings(8),
    )


async def test_run_turn_records_usage_stats_after_a_real_kp_turn():
    def responder(messages, tools):
        return ChatResult(
            content="The door creaks open.",
            tool_calls=[],
            usage=Usage(prompt_tokens=120, completion_tokens=30, total_tokens=150, cache_hit_tokens=50, cache_miss_tokens=70),
        )

    services = _services(responder)
    ctx = _ctx("usage-turn-room")
    hub = RoomHub()

    await run_turn(hub, services, ctx, "open the door", command_router=_NullRouter(), toolset=build_kp_toolset(services))

    raw = await services.store.get(user_key="", store_key=f"usage_stats.{ctx.chat_key}")
    assert raw is not None
    stats = json.loads(raw)
    # Window is computed from the pinned model (see `_WINDOW`) so it can't drift from the fixture.
    assert stats["last"] == {"prompt": 120, "completion": 30, "cache_hit": 50, "cache_miss": 70, "context_window": _WINDOW}
    assert stats["session"] == {"prompt": 120, "completion": 30, "cache_hit": 50, "cache_miss": 70, "turns": 1}


async def test_run_turn_accumulates_session_usage_across_multiple_turns():
    def responder(messages, tools):
        return ChatResult(content="ok", tool_calls=[], usage=Usage(prompt_tokens=100, completion_tokens=10, total_tokens=110))

    services = _services(responder)
    ctx = _ctx("usage-turn-room-2")
    hub = RoomHub()

    await run_turn(hub, services, ctx, "one", command_router=_NullRouter(), toolset=build_kp_toolset(services))
    await run_turn(hub, services, ctx, "two", command_router=_NullRouter(), toolset=build_kp_toolset(services))

    raw = await services.store.get(user_key="", store_key=f"usage_stats.{ctx.chat_key}")
    stats = json.loads(raw)
    assert stats["session"]["turns"] == 2
    assert stats["session"]["prompt"] == 200
    assert stats["session"]["completion"] == 20
    # "last" reflects only the MOST RECENT turn, not a sum.
    assert stats["last"]["prompt"] == 100


async def test_run_turn_never_writes_usage_stats_for_a_zero_usage_turn():
    def responder(messages, tools):
        return ChatResult(content="ok", tool_calls=[])  # default usage=None -> KPTurnResult.usage stays all-zero

    services = _services(responder)
    ctx = _ctx("usage-turn-room-zero")
    hub = RoomHub()

    await run_turn(hub, services, ctx, "hi", command_router=_NullRouter(), toolset=build_kp_toolset(services))

    assert await services.store.get(user_key="", store_key=f"usage_stats.{ctx.chat_key}") is None
