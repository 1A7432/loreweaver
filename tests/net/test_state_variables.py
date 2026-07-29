"""Tests for net.state's `variables` snapshot field: player-visible module variables
(`core.modvars`) surfaced by `build_room_state` as `state["variables"]` (or omitted entirely
when the room has none).

RED LINE (iron rule #3, information isolation): a `visibility="keeper"` variable must NEVER
appear ANYWHERE in the state payload — not its id, not its label, not its value. That filter
lives in `core.modvars.player_entries` (structural, by construction), and these tests are the
tripwire that keeps it that way.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import build_services
from core.modvars import ModvarManager, build_spec
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.state import build_room_state


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _room_ctx(room: str, *, user_id: str = "seed", locale: str = "en") -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform="tui", locale=locale)


async def test_build_room_state_omits_variables_when_none_defined():
    services = _services()
    ctx = _room_ctx("vars-empty-room")

    state = await build_room_state(services, ctx)

    assert "variables" not in state


async def test_build_room_state_surfaces_player_visible_variables_in_definition_order():
    services = _services()
    ctx = _room_ctx("vars-room")
    manager = ModvarManager(services.store)
    await manager.define(
        ctx.chat_key, build_spec("town_fear", "number", labels={"en": "Town Fear"}, minimum=0, maximum=10)
    )
    await manager.define(ctx.chat_key, build_spec("mood", "enum", options=["calm", "tense"]))
    await manager.set(ctx.chat_key, "town_fear", 7)

    state = await build_room_state(services, ctx)

    assert state["variables"] == [
        {"id": "town_fear", "label": "Town Fear", "kind": "number", "value": 7, "min": 0, "max": 10},
        {"id": "mood", "label": "mood", "kind": "enum", "value": "calm"},
    ]


async def test_red_line_keeper_only_variables_never_appear_anywhere_in_the_state_payload():
    """Iron rule #3: the keeper-only variable's id, label, and value must be absent from the
    ENTIRE serialized state frame — not just from `state["variables"]`."""
    services = _services()
    ctx = _room_ctx("vars-secret-room")
    manager = ModvarManager(services.store)
    await manager.define(ctx.chat_key, build_spec("fear", "number", minimum=0, maximum=10))
    await manager.define(
        ctx.chat_key,
        build_spec(
            "true_culprit",
            "text",
            labels={"en": "True Culprit"},
            visibility="keeper",
            default="Dr. Corvus Marsh",
        ),
    )

    state = await build_room_state(services, ctx)

    wire = json.dumps(state, ensure_ascii=False)
    assert "true_culprit" not in wire
    assert "True Culprit" not in wire
    assert "Corvus" not in wire
    assert [entry["id"] for entry in state["variables"]] == ["fear"]


async def test_variables_labels_follow_the_callers_locale():
    services = _services()
    manager = ModvarManager(services.store)
    ctx_zh = _room_ctx("vars-locale-room", locale="zh")
    await manager.define(
        ctx_zh.chat_key,
        build_spec("town_fear", "number", labels={"en": "Town Fear", "zh": "小镇恐慌"}, minimum=0, maximum=10),
    )

    state_zh = await build_room_state(services, ctx_zh)
    state_en = await build_room_state(services, _room_ctx("vars-locale-room", locale="en"))

    assert state_zh["variables"][0]["label"] == "小镇恐慌"
    assert state_en["variables"][0]["label"] == "Town Fear"


async def test_mvu_leaves_ride_the_variables_list_with_prefixed_ids():
    services = _services()
    ctx = _room_ctx("vars-mvu-room")
    from core.mvu_compat import MvuManager

    await ModvarManager(services.store).define(
        ctx.chat_key, build_spec("fear", "number", minimum=0, maximum=10)
    )
    await MvuManager(services.store).init_from_initvar(
        ctx.chat_key, {"理": {"好感度": [33, "affinity"], "档案": {"备注": ["長い", "note"]}}}
    )

    state = await build_room_state(services, ctx)

    ids = [entry["id"] for entry in state["variables"]]
    assert ids[0] == "fear"  # native trackers first
    assert "mvu.理.好感度" in ids
    mvu_entry = next(entry for entry in state["variables"] if entry["id"] == "mvu.理.好感度")
    assert mvu_entry == {"id": "mvu.理.好感度", "label": "理.好感度", "kind": "number", "value": 33}
