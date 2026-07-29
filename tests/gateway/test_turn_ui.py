"""Tests for gateway.turn's protocol-v1.7 `ui` fan-out: hook-emitted UI frames broadcast
right after the KP narrative and before the closing `state` snapshot, and render as
`{type:"ui", ...}` wire frames. Skipped as a module without the `ejs` extra (hooks are
inert then, so no `ui` event can ever be produced)."""

from __future__ import annotations

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.hook_runtime import install_room_hooks  # noqa: E402
from agent.kp_tools import build_kp_toolset  # noqa: E402
from agent.services import build_services  # noqa: E402
from gateway.hub import RoomHub  # noqa: E402
from gateway.session import SessionSource  # noqa: E402
from gateway.turn import run_turn  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM, assistant_text  # noqa: E402
from net.session import render_frame  # noqa: E402


class _NullRouter:
    """Never resolves a command, so `run_turn` always runs the real AI-KP turn
    (mirrors the duck-typed router stand-in in tests/gateway/test_turn_usage.py)."""

    def resolve(self, text, locale):
        return None

    async def dispatch_reply(self, ctx, text):
        return None


class _Recorder:
    """A minimal hub member that records every delivered event in order."""

    def __init__(self):
        self.id = "m1"
        self.user_key = "tui:m1"
        self.transport = "test"
        self.events = []

    async def deliver(self, event):
        self.events.append(event)


def _ctx(room: str) -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id="p1", platform="tui", locale="en")


async def test_hook_ui_frames_broadcast_between_kp_narrative_and_state():
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text("The night deepens.")]),
        embeddings=FakeEmbeddings(8),
    )
    ctx = _ctx("ui-room")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('reply_ready', () => emitUI([{kind:'meter', label:'Fear', value:3, min:0, max:10}],"
            " {panel:'sidebar', id:'fear', replace:true}));"
        ],
    )
    hub = RoomHub()
    member = _Recorder()
    await hub.subscribe(ctx.chat_key, member)

    await run_turn(hub, services, ctx, "hello", command_router=_NullRouter(), toolset=build_kp_toolset(services))

    kinds = [event.kind for event in member.events]
    ui_index = kinds.index("ui")
    kp_index = next(
        index
        for index, event in enumerate(member.events)
        if event.kind == "narrative" and event.speaker == "kp"
    )
    assert kp_index < ui_index < kinds.index("state")
    ui_event = member.events[ui_index]
    assert ui_event.data == {
        "blocks": [{"kind": "meter", "label": "Fear", "value": 3, "min": 0, "max": 10}],
        "panel": "sidebar",
        "id": "fear",
        "replace": True,
    }
    # The wire rendering is the like-named additive v1.7 frame.
    assert render_frame(ui_event) == {"type": "ui", **ui_event.data}


async def test_turn_without_hooks_publishes_no_ui_event():
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text("Quiet.")]),
        embeddings=FakeEmbeddings(8),
    )
    ctx = _ctx("ui-room-none")
    hub = RoomHub()
    member = _Recorder()
    await hub.subscribe(ctx.chat_key, member)

    await run_turn(hub, services, ctx, "hello", command_router=_NullRouter(), toolset=build_kp_toolset(services))

    assert "ui" not in [event.kind for event in member.events]
