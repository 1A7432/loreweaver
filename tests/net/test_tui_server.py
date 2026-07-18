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
import hashlib
import json
import re

import pytest
import websockets
from websockets.exceptions import ConnectionClosed

from agent.context import AgentCtx, LocalFs
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_companion import CompanionTools
from agent.services import build_services
from core.character_manager import CharacterSheet
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, ToolCall, assistant_text, assistant_tools, tool_call
from net.keystore import Keystore
from net.session import _MAX_INPUT_CHARS
from net.state import build_room_state
from net.tui_server import TuiServer, WsMember, _pack_media_message, _unpack_media_message
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


async def _recv_until(ws, frame_type: str) -> dict:
    while True:
        frame = await _recv(ws)
        if frame.get("type") == frame_type:
            return frame


async def _join(ws, key: str, name: str | None = None) -> dict:
    frame = {"type": "join", "key": key}
    if name:
        frame["name"] = name
    await ws.send(json.dumps(frame))
    return await _recv(ws)


async def _connect_and_join(url: str, key: str, name: str | None = None, **connect_kwargs):
    """Connect + `join`, draining the `welcome` and the join-time `presence` +
    `state` frames every successful join triggers (see `TuiServer.handle`)."""
    ws = await websockets.connect(url, **connect_kwargs)
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
            assert welcome["protocol"] == "1.5"
            assert "media" in welcome["features"]
            assert "audio" in welcome["features"]
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


async def test_join_ignores_client_supplied_name_and_uses_keystore_identity():
    # Regression (#3): the broadcast display name is authoritative (keystore entry),
    # never the client-sent `join.name` — otherwise any connection could impersonate
    # "Keeper"/another player in the room fan-out.
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="demo", name="Alice", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        async with websockets.connect(url) as ws:
            welcome = await _join(ws, key, "Keeper")  # client tries to spoof "Keeper"
            assert welcome["type"] == "welcome"
            assert welcome["you"]["name"] == "Alice"  # authoritative keystore name wins
            assert welcome["you"]["role"] == "player"
    finally:
        await server.close()


# ---------------------------------------------------------------------------
# Availability hardening: no handshake timeout on unauthenticated connections
# and no connection-count cap let a peer exhaust server coroutines/fds before
# ever authenticating (the rate limiter only applies AFTER `join`, in
# `dispatch_input`). See `infra.config.TuiSettings`.
# ---------------------------------------------------------------------------


async def test_silent_connection_is_closed_after_the_join_handshake_timeout():
    services = _services()
    keystore = Keystore()
    server = TuiServer(services, keystore, port=0, join_timeout=0.05)
    url = await _start(server)
    try:
        async with websockets.connect(url) as ws:
            # Never send `join`: the server must close us out after `join_timeout`
            # instead of holding the connection open forever.
            error = await _recv(ws)
            assert error["type"] == "error"
            assert error["code"] == "join_timeout"
            assert error["message"]

            with pytest.raises(ConnectionClosed):
                await asyncio.wait_for(ws.recv(), timeout=_RECV_TIMEOUT)
    finally:
        await server.close()


async def test_connection_over_the_cap_is_refused_and_closed():
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="capped", name="Alice")
    server = TuiServer(services, keystore, port=0, max_connections=1)
    url = await _start(server)
    try:
        # The first connection fills the (cap=1) slot and stays open.
        ws_a, *_ = await _connect_and_join(url, key, "Alice")

        # A second, simultaneous connection is over the cap: refused before
        # `join` is even read, with `too_many_connections`, then closed.
        async with websockets.connect(url) as ws_b:
            error = await _recv(ws_b)
            assert error["type"] == "error"
            assert error["code"] == "too_many_connections"
            assert error["message"]

            with pytest.raises(ConnectionClosed):
                await asyncio.wait_for(ws_b.recv(), timeout=_RECV_TIMEOUT)

        # Freeing the slot lets a new connection back in.
        await ws_a.close()
        await asyncio.sleep(0.05)  # let the server-side `finally` decrement land
        ws_c, welcome_c, *_ = await _connect_and_join(url, key, "Alice")
        assert welcome_c["type"] == "welcome"
        await ws_c.close()
    finally:
        await server.close()


def test_build_ssl_context_is_none_when_unset_and_rejects_a_half_configured_pair():
    from net.tui_server import _build_ssl_context

    assert _build_ssl_context(Settings()) is None

    half = Settings()
    half.tui.tls_cert_path = "/tmp/does-not-matter.pem"
    with pytest.raises(ValueError):
        _build_ssl_context(half)


async def test_oversized_input_is_rejected_without_starting_a_turn():
    # TUI-INPUT-026: rejecting the whole action is honest; silently truncating it can make the
    # Keeper answer a different action. The same connection remains usable afterward.
    services = _services(responder=lambda messages, tools: assistant_text("ok"))
    keystore = Keystore()
    key = keystore.add(room="caproom", name="Nora")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Nora")
        await ws.send(json.dumps({"type": "input", "text": "x" * (_MAX_INPUT_CHARS + 500)}))

        error = await _recv(ws)
        assert error == {
            "type": "error",
            "code": "input_too_long",
            "message": "Messages may contain at most 4,000 characters. Nothing was sent.",
        }
        assert not server.turns

        # The boundary value is accepted in full, and the prior rejection did not close the socket.
        await ws.send(json.dumps({"type": "input", "text": "y" * _MAX_INPUT_CHARS}))
        echo = await _recv(ws)
        assert echo["type"] == "narrative" and echo["speaker"] == "player"
        assert echo["text"] == "y" * _MAX_INPUT_CHARS
        await ws.close()
    finally:
        await server.close()


def test_input_too_long_error_has_a_chinese_translation():
    from infra.i18n import get_i18n
    from net.session import error_frame

    assert error_frame("input_too_long", get_i18n("zh")) == {
        "type": "error",
        "code": "input_too_long",
        "message": "消息最多可输入 4,000 个字符，本次内容未发送。",
    }


async def test_admin_frame_exception_becomes_error_frame_not_a_dropped_socket(monkeypatch):
    # Regression (#7): a raising admin/ping branch is turned into a per-connection error
    # frame (mirroring dispatch_input) rather than an unhandled exception that drops the
    # socket — and the connection survives to serve the next frame.
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="adminroom", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)

    async def _boom(*args, **kwargs):
        raise RuntimeError("admin handler blew up")

    monkeypatch.setattr(server.admin, "dispatch", _boom)

    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Keeper")
        await ws.send(json.dumps({"type": "admin_get_config"}))
        err = await _recv(ws)
        assert err["type"] == "error" and err["code"] == "server_error"

        # The socket is still alive: a subsequent ping still gets its pong.
        await ws.send(json.dumps({"type": "ping", "t": 42}))
        pong = await _recv(ws)
        assert pong["type"] == "pong" and pong["t"] == 42
        await ws.close()
    finally:
        await server.close()


async def test_model_switch_refreshes_other_connected_keepers(monkeypatch):
    services = _services()
    keystore = Keystore()
    key_a = keystore.add(room="arkham", name="Keeper A", role="keeper")
    key_b = keystore.add(room="dunwich", name="Keeper B", role="keeper")
    key_c = keystore.add(room="innsmouth", name="Former Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)

    config = {
        "type": "admin_config",
        "provider": "deepseek",
        "chat_model": "deepseek-chat",
        "base_url": "",
        "api_key_masked": "",
        "providers": ["deepseek"],
        "saved_providers": [],
        "override_active": True,
        "using_demo": False,
    }

    async def _config(*args, **kwargs):
        return dict(config)

    monkeypatch.setattr(server.admin, "dispatch", _config)
    url = await _start(server)
    try:
        ws_a, *_ = await _connect_and_join(url, key_a)
        ws_b, *_ = await _connect_and_join(url, key_b)
        ws_c, *_ = await _connect_and_join(url, key_c)
        keystore.update(key_c, role="player")

        await ws_a.send(json.dumps({"type": "admin_set_model", "provider": "deepseek"}))
        assert await _recv(ws_a) == config
        assert await _recv(ws_b) == config
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(ws_c.recv(), timeout=0.05)

        await ws_a.close()
        await ws_b.close()
        await ws_c.close()
    finally:
        await server.close()


async def test_live_keeper_downgrade_takes_effect_without_reconnect():
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="arkham", name="Keeper", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key)
        keystore.update(key, role="player")

        await ws.send(json.dumps({"type": "admin_get_config"}))
        denied = await _recv(ws)
        assert denied["type"] == "admin_error"
        assert denied["code"] == "forbidden"

        keystore.remove(key)
        await ws.send(json.dumps({"type": "input", "text": ".r 1d1"}))
        revoked = await _recv(ws)
        assert revoked["type"] == "error"
        assert revoked["code"] == "forbidden"
        await ws.close()
    finally:
        await server.close()


async def test_revoked_connection_cannot_keep_receiving_passive_room_events():
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="arkham", name="Listener", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, welcome, *_ = await _connect_and_join(url, key)
        session_key = SessionSource(
            platform="tui", chat_type="group", chat_id="arkham"
        ).chat_key()
        assert server.hub.online(session_key) == 1

        keystore.remove(key)
        await server.hub.publish(
            session_key,
            Event.narrative(speaker="kp", text="keeper-only next scene"),
        )

        assert server.hub.online(session_key) == 0
        revoked = await _recv(ws)
        assert revoked["type"] == "error"
        assert revoked["code"] == "forbidden"
        with pytest.raises(ConnectionClosed):
            await ws.recv()
        assert welcome["you"]["name"] == "Listener"
    finally:
        await server.close()


async def test_guided_demo_is_rejected_without_mutating_an_existing_room(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    services.llm.using_fallback = True
    keystore = Keystore()
    key = keystore.add(room="arkham", name="Keeper", role="keeper")
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id="arkham").chat_key()
    record_key = f"session_record.{chat_key}.current"
    module_key = f"module_fulltext.{chat_key}"
    await services.store.set(user_key="", store_key=record_key, value='{"name":"existing"}')
    await services.store.set(user_key="", store_key=module_key, value="existing module")

    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, welcome, *_ = await _connect_and_join(url, key)
        assert "demo" not in welcome.get("features", [])

        await ws.send(json.dumps({"type": "input", "text": "Start the built-in sample adventure"}))
        denied = await _recv(ws)
        assert denied["type"] == "error"
        assert denied["code"] == "demo_unavailable"
        assert await services.store.get(user_key="", store_key=record_key) == '{"name":"existing"}'
        assert await services.store.get(user_key="", store_key=module_key) == "existing module"

        # The scripted fallback's legacy CLI phrase reaches the same destructive setup tools.
        # It must not bypass the room-emptiness guard merely by avoiding the TUI button text.
        await ws.send(json.dumps({"type": "input", "text": "upload the demo module"}))
        legacy_denied = await _recv(ws)
        assert legacy_denied["type"] == "error"
        assert legacy_denied["code"] == "demo_unavailable"
        assert await services.store.get(user_key="", store_key=record_key) == '{"name":"existing"}'
        assert await services.store.get(user_key="", store_key=module_key) == "existing module"

        # Ordinary prose is not a hidden demo command merely because it mentions a module.
        await ws.send(json.dumps({"type": "input", "text": "let's check the module again"}))
        ordinary = await _recv(ws)
        assert ordinary["type"] == "narrative"
        assert ordinary["speaker"] == "player"
        assert ordinary["text"] == "let's check the module again"
        assert await services.store.get(user_key="", store_key=record_key) == '{"name":"existing"}'
        assert await services.store.get(user_key="", store_key=module_key) == "existing module"
        await ws.close()
    finally:
        await server.close()


async def test_dot_r_command_broadcasts_echo_dice_reply_and_state():
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

        dice = await _recv(ws)
        assert dice["type"] == "dice"
        assert dice["expr"] == "1d1+1"
        assert dice["total"] == 2

        reply = await _recv(ws)
        assert reply["type"] == "narrative"
        assert reply["speaker"] in ("system", "kp")
        assert _total(reply["text"]) == 2

        state = await _recv(ws)
        assert state["type"] == "state"

        await ws.close()
    finally:
        await server.close()


async def test_ws_media_upload_broadcast_and_download_round_trip(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    keystore = Keystore()
    key_a = keystore.add(room="media-room", name="Ada")
    key_b = keystore.add(room="media-room", name="Ben")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    data = b"\x89PNG\r\n\x1a\nmedia-bytes"
    digest = hashlib.sha256(data).hexdigest()
    try:
        ws_a, *_ = await _connect_and_join(url, key_a, "Ada")
        ws_b, *_ = await _connect_and_join(url, key_b, "Ben")
        await _recv(ws_a)  # Ben's join-time presence broadcast to Ada.
        await _recv(ws_a)  # Ben's join-time state broadcast to Ada.

        await ws_a.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "handout.png",
                    "mime": "image/png",
                    "size": len(data),
                    "sha256": digest,
                }
            )
        )
        accept = await _recv_until(ws_a, "media_accept")
        assert accept["type"] == "media_accept"
        upload_id = accept["upload_id"]

        await ws_a.send(_pack_media_message({"op": "put", "upload_id": upload_id}, data))
        media_a = await _recv_until(ws_a, "media")
        media_b = await _recv_until(ws_b, "media")
        assert media_a["type"] == media_b["type"] == "media"
        assert media_b["hash"] == digest
        assert media_b["name"] == "handout.png"

        await ws_b.send(_pack_media_message({"op": "get", "hash": digest}))
        raw = await asyncio.wait_for(ws_b.recv(), timeout=_RECV_TIMEOUT)
        assert isinstance(raw, bytes)
        header, body = _unpack_media_message(raw)
        assert header["hash"] == digest
        assert header["mime"] == "image/png"
        assert body == data

        await ws_a.close()
        await ws_b.close()
    finally:
        await server.close()


async def test_ws_avatar_set_binds_only_own_character(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    keystore = Keystore()
    key = keystore.add(room="avatar-room", name="Ada")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    data = b"\x89PNG\r\n\x1a\navatar"
    digest = hashlib.sha256(data).hexdigest()
    try:
        ws, welcome, *_ = await _connect_and_join(url, key, "Ada")
        await services.characters.save_character(welcome["you"]["id"], "tui:group:avatar-room", CharacterSheet("Ada Sheet", "CoC"))

        await ws.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "avatar.png",
                    "mime": "image/png",
                    "size": len(data),
                    "sha256": digest,
                }
            )
        )
        accept = await _recv_until(ws, "media_accept")
        await ws.send(_pack_media_message({"op": "put", "upload_id": accept["upload_id"]}, data))
        await _recv_until(ws, "media")

        await ws.send(json.dumps({"type": "avatar_set", "hash": digest}))
        system = await _recv_until(ws, "system")
        state = await _recv_until(ws, "state")
        assert system["text"]
        assert state["character"]["avatar"]["hash"] == digest

        await ws.send(json.dumps({"type": "avatar_set", "hash": digest, "character": "Someone Else"}))
        error = await _recv_until(ws, "error")
        assert error["code"] == "forbidden"
        await ws.close()
    finally:
        await server.close()


async def test_ws_avatar_set_rejects_cross_room_hash(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    keystore = Keystore()
    key_a = keystore.add(room="avatar-a", name="Ada")
    key_b = keystore.add(room="avatar-b", name="Ben")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    data = b"\x89PNG\r\n\x1a\navatar"
    digest = hashlib.sha256(data).hexdigest()
    try:
        ws_a, *_ = await _connect_and_join(url, key_a, "Ada")
        ws_b, welcome_b, *_ = await _connect_and_join(url, key_b, "Ben")
        await services.characters.save_character(welcome_b["you"]["id"], "tui:group:avatar-b", CharacterSheet("Ben Sheet", "CoC"))

        await ws_a.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "avatar.png",
                    "mime": "image/png",
                    "size": len(data),
                    "sha256": digest,
                }
            )
        )
        accept = await _recv_until(ws_a, "media_accept")
        await ws_a.send(_pack_media_message({"op": "put", "upload_id": accept["upload_id"]}, data))
        await _recv_until(ws_a, "media")

        await ws_b.send(json.dumps({"type": "avatar_set", "hash": digest}))
        error = await _recv_until(ws_b, "error")
        assert error["code"] == "media_not_found"
        await ws_a.close()
        await ws_b.close()
    finally:
        await server.close()


async def test_ws_media_upload_larger_than_the_websockets_default_cap(tmp_path):
    """Regression: `websockets` caps one message at 1 MiB by default, and a media PUT is ONE
    binary message on this carrier — without `max_size` raised to the configured media limits,
    any real-sized image kills the connection with 1009 before the server ever sees the offer
    honored. (The offer/quota checks still bound what a compliant client sends.)"""
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    keystore = Keystore()
    key = keystore.add(room="media-big", name="Ada")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    data = b"\x89PNG\r\n\x1a\n" + bytes(1536 * 1024)  # 1.5 MiB body > the library's 1 MiB default
    digest = hashlib.sha256(data).hexdigest()
    try:
        # `max_size=None` lifts the TEST CLIENT's own 1 MiB receive cap for the GET reply.
        ws, *_ = await _connect_and_join(url, key, "Ada", max_size=None)
        await ws.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "big.png",
                    "mime": "image/png",
                    "size": len(data),
                    "sha256": digest,
                }
            )
        )
        accept = await _recv_until(ws, "media_accept")
        await ws.send(_pack_media_message({"op": "put", "upload_id": accept["upload_id"]}, data))
        media = await _recv_until(ws, "media")
        assert media["hash"] == digest

        await ws.send(_pack_media_message({"op": "get", "hash": digest}))
        raw = await asyncio.wait_for(ws.recv(), timeout=_RECV_TIMEOUT)
        header, body = _unpack_media_message(raw)
        assert header["size"] == len(data)
        assert body == data
        await ws.close()
    finally:
        await server.close()


async def test_disconnect_forgets_the_members_pending_media_offers(tmp_path):
    """An accepted offer that is never PUT must not linger in `_pending_media` after the
    offering connection goes away (a PUT can only arrive on that same connection)."""
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    keystore = Keystore()
    key = keystore.add(room="media-pending", name="Ada")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    data = b"\x89PNG\r\n\x1a\nnever-sent"
    try:
        ws, *_ = await _connect_and_join(url, key, "Ada")
        await ws.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "ghost.png",
                    "mime": "image/png",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        )
        accept = await _recv_until(ws, "media_accept")
        assert accept["upload_id"]
        assert len(server._pending_media) == 1

        await ws.close()
        for _ in range(100):  # the server-side handler finishes asynchronously after the close
            if not server._pending_media:
                break
            await asyncio.sleep(0.05)
        assert server._pending_media == {}
    finally:
        await server.close()


async def test_ws_svg_upload_is_safety_checked(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    keystore = Keystore()
    key = keystore.add(room="svg-room", name="Ada")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    safe = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="5">Map</text></svg>'
    unsafe = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    try:
        ws, *_ = await _connect_and_join(url, key, "Ada")
        safe_digest = hashlib.sha256(safe).hexdigest()
        await ws.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "map.svg",
                    "mime": "image/svg+xml",
                    "size": len(safe),
                    "sha256": safe_digest,
                }
            )
        )
        safe_accept = await _recv_until(ws, "media_accept")
        await ws.send(_pack_media_message({"op": "put", "upload_id": safe_accept["upload_id"]}, safe))
        media = await _recv_until(ws, "media")
        assert media["mime"] == "image/svg+xml"
        assert media["name"] == "map.svg"

        unsafe_digest = hashlib.sha256(unsafe).hexdigest()
        await ws.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "bad.svg",
                    "mime": "image/svg+xml",
                    "size": len(unsafe),
                    "sha256": unsafe_digest,
                }
            )
        )
        unsafe_accept = await _recv_until(ws, "media_accept")
        await ws.send(_pack_media_message({"op": "put", "upload_id": unsafe_accept["upload_id"]}, unsafe))
        error = await _recv_until(ws, "error")
        assert error["code"] == "media_bad_svg"

        await ws.close()
    finally:
        await server.close()


async def test_ws_audio_upload_indexes_library_and_bgm_command_broadcasts_control(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    keystore = Keystore()
    key_a = keystore.add(room="audio-room", name="Keeper", role="keeper")
    key_b = keystore.add(room="audio-room", name="Ben")
    hub = RoomHub()
    router = CommandRouter(services, keystore=keystore, hub=hub)
    server = TuiServer(services, keystore, port=0, command_router=router, hub=hub)
    url = await _start(server)
    data = b"ID3audio-bytes"
    digest = hashlib.sha256(data).hexdigest()
    try:
        ws_a, *_ = await _connect_and_join(url, key_a, "Keeper")
        ws_b, *_ = await _connect_and_join(url, key_b, "Ben")
        await _recv(ws_a)  # Ben's join-time presence broadcast to Keeper.
        await _recv(ws_a)  # Ben's join-time state broadcast to Keeper.

        await ws_a.send(
            json.dumps(
                {
                    "type": "media_offer",
                    "name": "theme.mp3",
                    "mime": "audio/mpeg",
                    "size": len(data),
                    "sha256": digest,
                }
            )
        )
        accept = await _recv_until(ws_a, "media_accept")
        await ws_a.send(_pack_media_message({"op": "put", "upload_id": accept["upload_id"]}, data))
        item_a = await _recv_until(ws_a, "audio_library_item")
        item_b = await _recv_until(ws_b, "audio_library_item")
        assert item_a["hash"] == item_b["hash"] == digest
        assert item_b["name"] == "theme.mp3"

        await ws_b.send(_pack_media_message({"op": "get", "hash": digest}))
        raw = await asyncio.wait_for(ws_b.recv(), timeout=_RECV_TIMEOUT)
        assert isinstance(raw, bytes)
        header, body = _unpack_media_message(raw)
        assert header["hash"] == digest
        assert header["mime"] == "audio/mpeg"
        assert body == data

        await ws_a.send(json.dumps({"type": "input", "text": ".bgm play theme --volume 0.5"}))
        control = await _recv_until(ws_b, "audio_control")
        state = await _recv_until(ws_b, "audio_state")
        assert control["action"] == "play"
        assert control["layer"] == "bgm"
        assert control["hash"] == digest
        assert control["volume"] == 0.5
        bgm_state = next(layer for layer in state["layers"] if layer["layer"] == "bgm")
        assert bgm_state["playing"] is True
        assert bgm_state["hash"] == digest

        await ws_a.close()
        await ws_b.close()
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
        busy = await _recv(ws)
        reply = await _recv(ws)
        idle = await _recv(ws)
        state = await _recv(ws)

        assert echo["type"] == "narrative" and echo["speaker"] == "player"
        assert busy == {"type": "turn_status", "status": "busy", "actor": "Nora"}
        assert reply["type"] == "narrative" and reply["speaker"] == "kp"
        assert reply["format"] == "markdown"
        assert reply["text"].strip()
        assert idle == {"type": "turn_status", "status": "idle"}
        assert state["type"] == "state"

        for frame in (echo, busy, reply, idle, state):
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
        busy = await _recv(ws)
        npc_frame = await _recv(ws)
        kp_frame = await _recv(ws)
        idle = await _recv(ws)
        state = await _recv(ws)

        assert echo["type"] == "narrative" and echo["speaker"] == "player"
        assert busy == {"type": "turn_status", "status": "busy", "actor": "Nora"}
        assert npc_frame["type"] == "narrative"
        assert npc_frame["speaker"] == "npc"
        assert npc_frame["name"] == "Martha"
        assert npc_dialogue in npc_frame["text"]
        assert npc_frame["format"] == "markdown"
        assert kp_frame["type"] == "narrative" and kp_frame["speaker"] == "kp"
        assert idle == {"type": "turn_status", "status": "idle"}
        assert state["type"] == "state"

        for frame in (echo, busy, npc_frame, kp_frame, idle, state):
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

        echo = await _recv(ws_a)
        assert echo["type"] == "narrative" and echo["speaker"] == "player" and echo["name"] == "Alice"

        for ws in (ws_a, ws_b):
            dice = await _recv(ws)
            reply = await _recv(ws)
            state = await _recv(ws)
            assert dice["type"] == "dice" and dice["total"] == 2
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
    assert state["character"]["sanmax"] == 99
    nora = next(member for member in state["party"] if member["name"] == "Nora Vance")
    assert nora["hp"] == 10
    assert nora["hpMax"] == 10
    assert nora["san"] == 50
    assert nora["sanMax"] == 99
    assert nora["mp"] == 10
    assert nora["mpMax"] == 10
    assert state["clock"]["time"] == "Night 1, 22:00"


async def test_build_room_state_filters_party_to_active_character_system():
    services = _services()
    ctx = _room_ctx("mixed-system-state", user_id="dnd-player")
    coc = services.characters.generate_character("coc7", "Nora Vance")
    dnd = services.characters.generate_character("dnd5e", "Kael Thorn")
    await services.characters.save_character("coc-player", ctx.chat_key, coc)
    await services.characters.save_character(ctx.user_id, ctx.chat_key, dnd)

    state = await build_room_state(services, ctx)

    assert state["character"]["system"] == "DnD5e"
    assert [member["name"] for member in state["party"]] == ["Kael Thorn"]
    roster = await services.characters.get_party_roster(ctx.chat_key)
    assert {member["name"] for member in roster} == {"Nora Vance", "Kael Thorn"}


# ---------------------------------------------------------------------------
# BUG B: history replay on join -- a joining/reconnecting player sees the
# room's recent narrative instead of an empty log.
# ---------------------------------------------------------------------------


async def test_join_replays_recent_chat_history_to_the_joiner_only():
    services = _services()
    keystore = Keystore()
    key_ann = keystore.add(room="replay-room", name="Ann")
    key_bob = keystore.add(room="replay-room", name="Bob")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("replay-room").chat_key
        history = [
            {"role": "user", "content": "I open the door"},
            {"role": "assistant", "content": "The door creaks open onto a dark hallway."},
        ]
        await services.store.set(user_key="", store_key=f"chat_history.{chat_key}", value=json.dumps(history))

        ws_ann = await websockets.connect(url)
        await _join(ws_ann, key_ann, "Ann")
        await _recv(ws_ann)  # Ann's own join presence

        replay1 = await _recv(ws_ann)
        replay2 = await _recv(ws_ann)
        state_ann = await _recv(ws_ann)

        assert replay1["type"] == "narrative"
        assert replay1["speaker"] == "player"
        assert replay1["text"] == "I open the door"
        assert replay2["type"] == "narrative"
        assert replay2["speaker"] == "kp"
        assert replay2["text"] == "The door creaks open onto a dark hallway."
        assert state_ann["type"] == "state"

        # Bob joins next -- HE also gets the same replay (unicast to him)...
        ws_bob = await websockets.connect(url)
        await _join(ws_bob, key_bob, "Bob")
        await _recv(ws_bob)  # Bob's own join presence
        bob_replay1 = await _recv(ws_bob)
        bob_replay2 = await _recv(ws_bob)
        await _recv(ws_bob)  # state
        assert bob_replay1["text"] == "I open the door"
        assert bob_replay2["text"] == "The door creaks open onto a dark hallway."

        # ...but Ann, already in the room, must NOT receive a second copy of the replay: she only
        # sees the ordinary presence/state updates Bob's join triggers, never a `narrative` frame.
        ann_next_frames = [await _recv(ws_ann), await _recv(ws_ann)]
        assert [frame["type"] for frame in ann_next_frames] == ["presence", "state"]

        await ws_ann.close()
        await ws_bob.close()
    finally:
        await server.close()


async def test_join_replay_is_capped_and_skips_a_brand_new_room():
    services = _services()
    keystore = Keystore()
    key = keystore.add(room="cap-room", name="Nora")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("cap-room").chat_key
        history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"line {i}"} for i in range(40)]
        await services.store.set(user_key="", store_key=f"chat_history.{chat_key}", value=json.dumps(history))

        ws = await websockets.connect(url)
        await _join(ws, key, "Nora")
        await _recv(ws)  # presence

        replayed = [await _recv(ws) for _ in range(30)]
        state = await _recv(ws)

        assert all(frame["type"] == "narrative" for frame in replayed)
        # Only the LAST 30 of the 40 persisted messages are replayed (the oldest 10 are dropped).
        assert [frame["text"] for frame in replayed] == [f"line {i}" for i in range(10, 40)]
        assert state["type"] == "state"
        await ws.close()
    finally:
        await server.close()

    # A brand-new room (no `chat_history` key set) replays nothing: welcome -> presence -> state,
    # exactly `_connect_and_join`'s existing assumption (regression-proofs the no-history path).
    server2 = TuiServer(services, keystore, port=0)
    url2 = await _start(server2)
    try:
        key2 = keystore.add(room="fresh-room", name="Nora")
        ws2, welcome2, presence2, state2 = await _connect_and_join(url2, key2, "Nora")
        assert welcome2["type"] == "welcome"
        assert presence2["type"] == "presence"
        assert state2["type"] == "state"
        await ws2.close()
    finally:
        await server2.close()


# ---------------------------------------------------------------------------
# Privilege-escalation regression (see `gateway.commands._privilege_level`): the
# TUI is a MULTI-USER network service, so a connection's dot-command privilege
# must come from its AUTHENTICATED keystore role, never be assumed just because
# the transport is `tui`. `_ctx_for` is the wiring that carries that role from
# the `WsMember` into the `AgentCtx` every command is gated on.
# ---------------------------------------------------------------------------


async def _send_command(ws, text: str) -> dict:
    """Send a dot-command `input` frame and return its reply, draining the echo and
    the trailing `state` frame every turn publishes (mirrors
    `test_dot_r_command_broadcasts_echo_reply_and_state`'s echo -> reply -> state shape)."""
    await ws.send(json.dumps({"type": "input", "text": text}))
    echo = await _recv(ws)
    assert echo["type"] == "narrative" and echo["speaker"] == "player"
    reply = await _recv(ws)
    assert reply["type"] == "narrative" and reply["speaker"] == "system"
    state = await _recv(ws)
    assert state["type"] == "state"
    return reply


def test_ctx_for_stamps_the_connections_keystore_role_into_ctx_extra():
    services = _services()
    server = TuiServer(services, Keystore(), port=0)
    member = WsMember(
        ws=None,
        id="tui:abc123",
        user_key="tui:abc123",
        name="Pete",
        role="player",
        room="demo",
        session_key=SessionSource(platform="tui", chat_type="group", chat_id="demo").chat_key(),
        locale="en",
    )

    ctx = server._ctx_for(member)

    assert ctx.platform == "tui"
    assert ctx.extra.get("role") == "player"


async def test_player_role_connection_is_denied_keeper_only_dot_commands_over_the_wire():
    services = _services()
    keystore = Keystore()
    player_key = keystore.add(room="demo", name="Pete", role="player")
    hub = RoomHub()
    # Mirrors the production wiring in `app.py`: the router shares the server's
    # keystore/hub so `.room` can actually mint/report keys.
    router = CommandRouter(services, keystore=keystore, hub=hub)
    server = TuiServer(services, keystore, port=0, command_router=router, hub=hub)
    url = await _start(server)
    i18n = services.i18n.with_locale("en")
    try:
        ws, *_ = await _connect_and_join(url, player_key, "Pete")

        reply = await _send_command(ws, ".model set anthropic")
        assert reply["text"] == i18n.t("commands.model.denied")
        assert services.settings.llm.provider != "anthropic"

        reply = await _send_command(ws, ".lore query anything")
        assert reply["text"] == i18n.t("worldbook.commands.lore.denied")

        reply = await _send_command(ws, ".room open")
        assert reply["text"] == i18n.t("rooms.denied")
        assert len(keystore) == 1  # no room key was minted for the player

        await ws.close()
    finally:
        await server.close()


async def test_keeper_role_connection_is_allowed_keeper_only_dot_commands_over_the_wire():
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="demo", name="Kip", role="keeper")
    hub = RoomHub()
    router = CommandRouter(services, keystore=keystore, hub=hub)
    server = TuiServer(services, keystore, port=0, command_router=router, hub=hub)
    url = await _start(server)
    i18n = services.i18n.with_locale("en")
    try:
        ws, *_ = await _connect_and_join(url, keeper_key, "Kip")

        reply = await _send_command(ws, ".model set anthropic")
        assert reply["text"] != i18n.t("commands.model.denied")

        reply = await _send_command(ws, ".lore query")
        # reached the keeper-gated handler (usage notice, not the denial)
        assert reply["text"] == i18n.t("worldbook.commands.lore.query_usage")

        reply = await _send_command(ws, ".room open")
        assert reply["text"] != i18n.t("rooms.denied")
        assert len(keystore) == 2  # the keeper's key plus the freshly-minted room key

        await ws.close()
    finally:
        await server.close()


async def test_kp_toolset_is_hub_wired_so_companion_act_drives_a_live_turn():
    """Regression: TuiServer must build its KP toolset WITH its own hub/command_router,
    or `companion_act` silently degrades to returning a bare declared line instead of
    spotlighting the companion as a live room turn — so an AI companion the Keeper
    addresses (e.g. "沈墨, how do you answer?") would never actually act."""
    seed_dice(20240701)

    def responder(messages, tools):
        if tools is None:  # the companion actor's own call (no KP tools attached)
            return assistant_text(json.dumps({"action": "I raise my lantern toward the sound", "dialogue": "Who's there?"}))
        return assistant_text("Silas' lantern throws the dark back a step. What next?")  # KP resolving it

    services = _services(responder=responder)
    ctx = _room_ctx("companions")
    await CompanionTools(services).add_companion(ctx, name="Silas", persona="A steady lamplighter.", playstyle="cautious")
    await services.battles.start_session(ctx.chat_key)

    server = TuiServer(services, Keystore(), port=0)
    # Dispatch through the SERVER's OWN toolset (not a hand-built one) to prove its wiring.
    result = await server.toolset.dispatch(
        "companion_act", ctx, {"name": "Silas", "situation": "A floorboard creaks in the dark."}
    )

    # Hub path taken: the "✅ … takes a turn." confirmation, NOT the no-hub
    # `Name: "<dialogue>" — <action>` declared-line fallback.
    assert "Silas" in result
    assert "takes a turn" in result
    assert "Who's there?" not in result
