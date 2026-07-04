"""Tests for net.state's `usage` snapshot field: the rolling per-room token/cache
aggregate `gateway.turn._record_usage_stats` writes to `usage_stats.{chat_key}`,
surfaced by `build_room_state` as `state["usage"]` (or omitted entirely when unset).
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import build_services
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.state import build_room_state


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _room_ctx(room: str, *, user_id: str = "seed") -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform="tui", locale="en")


async def test_build_room_state_surfaces_usage_when_stats_are_seeded():
    services = _services()
    ctx = _room_ctx("usage-room")

    await services.store.set(
        user_key="",
        store_key=f"usage_stats.{ctx.chat_key}",
        value=json.dumps(
            {
                "last": {"prompt": 3000, "completion": 400, "cache_hit": 1000, "cache_miss": 2000, "context_window": 128000},
                "session": {"prompt": 9000, "completion": 1200, "cache_hit": 2500, "cache_miss": 6500, "turns": 3},
            }
        ),
    )

    state = await build_room_state(services, ctx)

    assert state["usage"] == {
        "context_tokens": 3000,
        "context_window": 128000,
        "input_tokens": 9000,
        "output_tokens": 1200,
        "cache_hit_tokens": 2500,
        "cache_miss_tokens": 6500,
    }


async def test_build_room_state_omits_usage_when_stats_are_absent():
    services = _services()
    ctx = _room_ctx("usage-room-empty")

    state = await build_room_state(services, ctx)

    assert "usage" not in state


async def test_build_room_state_omits_usage_on_corrupt_stats():
    services = _services()
    ctx = _room_ctx("usage-room-corrupt")

    await services.store.set(user_key="", store_key=f"usage_stats.{ctx.chat_key}", value="{not valid json")

    state = await build_room_state(services, ctx)

    assert "usage" not in state


async def test_build_room_state_usage_tolerates_missing_subfields():
    services = _services()
    ctx = _room_ctx("usage-room-partial")

    # A "last"-only payload (e.g. a very first recorded turn, or a hand-edited
    # store) with no "session" key yet -- every session.* field defaults to 0.
    await services.store.set(
        user_key="",
        store_key=f"usage_stats.{ctx.chat_key}",
        value=json.dumps({"last": {"prompt": 500, "context_window": 65536}}),
    )

    state = await build_room_state(services, ctx)

    assert state["usage"] == {
        "context_tokens": 500,
        "context_window": 65536,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_hit_tokens": 0,
        "cache_miss_tokens": 0,
    }
