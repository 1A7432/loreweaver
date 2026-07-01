"""Tests for the networked TUI WebSocket server (M4 spec §2, `docs/protocol.md`).

A real `TuiServer` is bound to an ephemeral localhost port (`port=0`) and
driven by a real `websockets` client, so these exercise the actual wire
protocol end to end rather than poking at internals. The KP self-play
fixtures/sentinel are reused from `tests/agent/test_kp_selfplay.py` so the
"no keeper-secret leak" guarantee is verified over the wire, not just at the
`agent.loop` level.
"""

from __future__ import annotations

import asyncio
import json
import re

import websockets

from agent.context import AgentCtx, LocalFs
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from core.dice_engine import seed_dice
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, ToolCall, assistant_text, assistant_tools, tool_call
from net.keystore import Keystore
from net.state import build_room_state
from net.tui_server import TuiServer
from tests.agent.test_kp_selfplay import FIXTURES, SENTINEL, _tools_called_this_turn, kp_responder

_RECV_TIMEOUT = 5.0


def _services(responder=None):
    llm = FakeLLM(responder=responder) if responder is not None else FakeLLM(script=[])
    return build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(64))


def _room_ctx(room: str, *, user_id: str = "seed", fs=None) -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform="tui", locale="en", fs=fs)


async def _start(server: TuiServer) -> str:
    await server.start()
    return f"ws://127.0.0.1:{server.bound_port}/"


async def _recv(ws) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout=_RECV_TIMEOUT)
    return json.loads(raw)


async def _join(ws, key: str, name: str | None = None) -> dict:
    frame = {"type": "join", "key": key}
    if name:
        frame["name"] = name
    await ws.send(json.dumps(frame))
    return await _recv(ws)


async def _connect_and_join(url: str, key: str, name: str | None = None):
    """Connect + `join`, draining the `welcome` and the join-time `presence` +
    `state` frames every successful join triggers (see `TuiServer.handle`)."""
    ws = await websockets.connect(url)
    welcome = await _join(ws, key, name)
    presence = await _recv(ws)
    state = await _recv(ws)
    return ws, welcome, presence, state


def _total(text: str) -> int:
    matches = re.findall(r"=\s*(-?\d+)(?:\D*$|\n)", text)
    if matches:
        return int(matches[-1])
    return int(re.findall(r"-?\d+", text)[-1])


async def test_join_with_good_key_gets_welcome_and_bad_key_gets_error():
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="demo", name="Alice", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        async with websockets.connect(url) as ws:
            welcome = await _join(ws, key, "Alice")
            assert welcome["type"] == "welcome"
            assert welcome["protocol"] == "1.1"
            assert welcome["room"] == "demo"
            assert welcome["you"]["name"] == "Alice"
            assert welcome["you"]["role"] == "player"

        async with websockets.connect(url) as ws:
            error = await _join(ws, "not-a-registered-key")
            assert error["type"] == "error"
            assert error["code"] == "bad_key"
            assert error["message"]
    finally:
        await server.close()


async def test_dot_r_command_broadcasts_echo_reply_and_state():
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="solo", name="Nora")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Nora")
        seed_dice(1234)
        await ws.send(json.dumps({"type": "input", "text": ".r 1d1+1"}))

        echo = await _recv(ws)
        assert echo["type"] == "narrative"
        assert echo["speaker"] == "player"
        assert echo["text"] == ".r 1d1+1"

        reply = await _recv(ws)
        assert reply["type"] == "narrative"
        assert reply["speaker"] in ("system", "kp")
        assert _total(reply["text"]) == 2

        state = await _recv(ws)
        assert state["type"] == "state"

        await ws.close()
    finally:
        await server.close()


async def test_kp_turn_after_module_seed_has_no_sentinel_leak_and_uses_keeper_tool():
    services = _services(responder=kp_responder)
    toolset = build_kp_toolset(services)
    keystore = Keystore()
    key = keystore.add(room="blackmoor", name="Nora")
    server = TuiServer(services, keystore, port=0, toolset=toolset)

    seed_ctx = _room_ctx("blackmoor", fs=LocalFs(str(FIXTURES)))
    uploaded = await toolset.dispatch("upload_document", seed_ctx, {"file_path": "module_en.txt", "doc_type": "module"})
    assert isinstance(uploaded, str) and uploaded
    keeper_pool = await services.store.get(store_key=f"module_keeper_pool.{seed_ctx.chat_key}")
    assert SENTINEL in (keeper_pool or ""), "seed must include sentinel"

    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Nora")
        await ws.send(json.dumps({"type": "input", "text": "let's begin"}))

        echo = await _recv(ws)
        reply = await _recv(ws)
        state = await _recv(ws)

        assert echo["type"] == "narrative" and echo["speaker"] == "player"
        assert reply["type"] == "narrative" and reply["speaker"] == "kp"
        assert reply["format"] == "markdown"
        assert reply["text"].strip()
        assert state["type"] == "state"

        for frame in (echo, reply, state):
            assert SENTINEL not in json.dumps(frame), "sentinel leaked in frame"

        assert server.turns, "no turn was recorded"
        last_trace = server.turns[-1].tool_trace
        assert any(t["name"] == "get_module_summary" and t["keeper_only"] for t in last_trace), (
            "keeper tool not used"
        )

        await ws.close()
    finally:
        await server.close()


async def test_kp_turn_broadcasts_ai_npc_dialogue_before_kp_narrative_without_leaking_keeper_secret():
    npc_dialogue = "Keep your voice down; the lighthouse hears more than men do."

    def responder(messages, tools):
        if tools is None:
            assert SENTINEL not in json.dumps(messages)
            return assistant_text(
                json.dumps(
                    {
                        "dialogue": npc_dialogue,
                        "action_intent": "glance toward the shuttered window",
                        "mood": "afraid",
                    }
                )
            )

        called = _tools_called_this_turn(messages)
        if "create_npc" not in called:
            return assistant_tools(
                ToolCall(
                    id="call_create_martha",
                    name="create_npc",
                    arguments={
                        "name": "Martha",
                        "persona": "A wary innkeeper.",
                        "knowledge": "The lighthouse bell rang after midnight.",
                    },
                )
            )
        if "speak_as_npc" not in called:
            return assistant_tools(
                tool_call("speak_as_npc", npc="Martha", situation="Nora asks what Martha heard last night.")
            )
        return assistant_text("Martha's warning leaves the common room brittle and quiet.")

    services = _services(responder=responder)
    toolset = build_kp_toolset(services)
    keystore = Keystore()
    key = keystore.add(room="npc-room", name="Nora")
    server = TuiServer(services, keystore, port=0, toolset=toolset)

    seed_ctx = _room_ctx("npc-room")
    await services.store.set(
        user_key="",
        store_key=f"module_keeper_pool.{seed_ctx.chat_key}",
        value=json.dumps({"truths": [{"description": SENTINEL}]}),
    )

    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Nora")
        await ws.send(json.dumps({"type": "input", "text": "Ask Martha what she heard."}))

        echo = await _recv(ws)
        npc_frame = await _recv(ws)
        kp_frame = await _recv(ws)
        state = await _recv(ws)

        assert echo["type"] == "narrative" and echo["speaker"] == "player"
        assert npc_frame["type"] == "narrative"
        assert npc_frame["speaker"] == "npc"
        assert npc_frame["name"] == "Martha"
        assert npc_dialogue in npc_frame["text"]
        assert npc_frame["format"] == "markdown"
        assert kp_frame["type"] == "narrative" and kp_frame["speaker"] == "kp"
        assert state["type"] == "state"

        for frame in (echo, npc_frame, kp_frame, state):
            assert SENTINEL not in json.dumps(frame), "sentinel leaked in frame"

        await ws.close()
    finally:
        await server.close()


async def test_two_clients_same_room_both_receive_the_broadcast_turn():
    services = _services()
    keystore = Keystore()
    key_a = keystore.add(room="party", name="Alice")
    key_b = keystore.add(room="party", name="Bob")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws_a, *_ = await _connect_and_join(url, key_a, "Alice")
        ws_b, *_ = await _connect_and_join(url, key_b, "Bob")

        # Bob's join pushed a fresh presence+state to Alice too; drain those
        # before driving a turn so they don't get mistaken for turn frames.
        await _recv(ws_a)
        await _recv(ws_a)

        seed_dice(99)
        await ws_a.send(json.dumps({"type": "input", "text": ".r 1d1+1"}))

        for ws in (ws_a, ws_b):
            echo = await _recv(ws)
            reply = await _recv(ws)
            state = await _recv(ws)
            assert echo["type"] == "narrative" and echo["speaker"] == "player" and echo["name"] == "Alice"
            assert reply["type"] == "narrative"
            assert _total(reply["text"]) == 2
            assert state["type"] == "state"

        await ws_a.close()
        await ws_b.close()
    finally:
        await server.close()


async def test_build_room_state_reports_character_party_and_clock():
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = _room_ctx("state-room", user_id="tui:abc123")

    await toolset.dispatch("create_character", ctx, {"name": "Nora Vance", "system": "coc7", "auto_generate": False})
    await services.store.set(
        user_key="",
        store_key=f"game_clock.{ctx.chat_key}",
        value=json.dumps({"current_time": "Night 1, 22:00"}),
    )

    state = await build_room_state(services, ctx)

    assert state["character"]["name"] == "Nora Vance"
    assert state["character"]["hp"] == 10
    assert state["character"]["hpmax"] == 10
    assert state["character"]["san"] == 50
    assert state["character"]["sanmax"] == 50
    assert any(member["name"] == "Nora Vance" for member in state["party"])
    assert state["clock"]["time"] == "Night 1, 22:00"
