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
from agent.history import DEFAULT_HISTORY_KEY, append_message, append_turn
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
from net.session import PROTOCOL_VERSION, _MAX_INPUT_CHARS
from net.state import build_room_state
from net.tui_server import TuiServer, WsMember, _pack_media_message, _unpack_media_message
from tests.agent.test_kp_selfplay import FIXTURES, SENTINEL, _tools_called_this_turn, kp_responder

_RECV_TIMEOUT = 5.0


def _services(responder=None):
    llm = FakeLLM(responder=responder) if responder is not None else FakeLLM(script=[])
    return build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(64))


def _room_ctx(room: str, *, user_id: str = "seed", fs=None) -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    # Same extra key SessionCore stamps: a TUI ctx without `reauthorize` is
    # fail-closed at the first live-auth write (e.g. `upload_document`).
    return AgentCtx(
        chat_key=chat_key,
        user_id=user_id,
        platform="tui",
        locale="en",
        fs=fs,
        extra={"reauthorize": lambda: True},
    )


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
    `state` + `ui_manifest` frames every successful join triggers (see
    `TuiServer.handle`)."""
    ws = await websockets.connect(url, **connect_kwargs)
    welcome = await _join(ws, key, name)
    presence = await _recv(ws)
    state = await _recv(ws)
    manifest = await _recv(ws)
    assert manifest["type"] == "ui_manifest"
    return ws, welcome, presence, state


def _total(text: str) -> int:
    matches = re.findall(r"=\s*(-?\d+)(?:\D*$|\n)", text)
    if matches:
        return int(matches[-1])
    return int(re.findall(r"-?\d+", text)[-1])


async def test_list_pack_cards_answers_a_player_with_installed_refs(tmp_path):
    """v2.2: the structured lane behind "import from installed pack" pickers —
    player-open, filenames only."""
    data_dir = tmp_path / "data"
    cards_dir = data_dir / "packs" / "harbour@1.0.0" / "cards"
    cards_dir.mkdir(parents=True)
    (cards_dir / "pilot.json").write_text(json.dumps({"name": "Pilot"}), encoding="utf-8")

    services = build_services(
        Settings(locale="en", data_dir=str(data_dir)), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    keystore = Keystore()
    key = keystore.add(room="packs", name="Momo", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Momo")
        await ws.send(json.dumps({"type": "list_pack_cards"}))
        frame = await _recv_until(ws, "pack_cards")
        # v2.3: every entry carries the kind a picker needs to choose the import verb.
        # This pack home has no manifest, which is the pre-2.3 assumption's own default.
        assert frame["cards"] == [
            {"ref": "harbour/cards/pilot.json", "pack": "harbour", "name": "pilot", "kind": "character"}
        ]
        # It walks the pack dirs on the event loop, player-open and off the turn lock —
        # so it spends the same allowance an input does, and a client looping it is
        # throttled like one looping `.import list` (the limiter's capacity is 5).
        for _ in range(6):
            await ws.send(json.dumps({"type": "list_pack_cards"}))
        seen = [await _recv(ws) for _ in range(6)]
        assert [f["type"] for f in seen].count("pack_cards") == 4  # 5 tokens minus the one above
        assert any(f.get("type") == "error" and f.get("code") == "rate_limited" for f in seen)
    finally:
        await server.close()


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
            # Pinned to the constant, not a literal: a minor bump is additive by
            # definition, so the handshake test should not need editing for one.
            assert welcome["protocol"] == PROTOCOL_VERSION
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
    await services.store.state_set(chat_key, "session_record.current", '{"name":"existing"}')
    await services.store.state_set(chat_key, "module_fulltext", "existing module")

    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, welcome, *_ = await _connect_and_join(url, key)
        assert "demo" not in welcome.get("features", [])

        await ws.send(json.dumps({"type": "input", "text": "Start the built-in sample adventure"}))
        denied = await _recv(ws)
        assert denied["type"] == "error"
        assert denied["code"] == "demo_unavailable"
        assert await services.store.state_get(chat_key, "session_record.current") == '{"name":"existing"}'
        assert await services.store.state_get(chat_key, "module_fulltext") == "existing module"

        # The scripted fallback's legacy CLI phrase reaches the same destructive setup tools.
        # It must not bypass the room-emptiness guard merely by avoiding the TUI button text.
        await ws.send(json.dumps({"type": "input", "text": "upload the demo module"}))
        legacy_denied = await _recv(ws)
        assert legacy_denied["type"] == "error"
        assert legacy_denied["code"] == "demo_unavailable"
        assert await services.store.state_get(chat_key, "session_record.current") == '{"name":"existing"}'
        assert await services.store.state_get(chat_key, "module_fulltext") == "existing module"

        # Ordinary prose is not a hidden demo command merely because it mentions a module.
        await ws.send(json.dumps({"type": "input", "text": "let's check the module again"}))
        ordinary = await _recv(ws)
        assert ordinary["type"] == "narrative"
        assert ordinary["speaker"] == "player"
        assert ordinary["text"] == "let's check the module again"
        assert await services.store.state_get(chat_key, "session_record.current") == '{"name":"existing"}'
        assert await services.store.state_get(chat_key, "module_fulltext") == "existing module"
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
    pool_doc = await services.documents.get_singleton(seed_ctx.chat_key, "module_pool")
    keeper_pool = json.dumps(pool_doc.data.get("keeper") if pool_doc else {}, ensure_ascii=False)
    assert SENTINEL in keeper_pool, "seed must include sentinel"

    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Nora")
        await ws.send(json.dumps({"type": "input", "text": "let's begin"}))

        echo = await _recv(ws)
        busy = await _recv(ws)
        streamed = []
        refreshes = []
        reply = await _recv(ws)
        while reply["type"] == "narrative_delta" or (
            # 2.3.1: each tool round re-sends `busy` with a coarse activity + round.
            reply["type"] == "turn_status" and reply.get("status") == "busy"
        ):
            (refreshes if reply["type"] == "turn_status" else streamed).append(reply)
            reply = await _recv(ws)
        idle = await _recv(ws)
        state = await _recv(ws)

        assert echo["type"] == "narrative" and echo["speaker"] == "player"
        assert busy == {"type": "turn_status", "status": "busy", "actor": "Nora"}
        # The turn read the module, and said so without naming the tool that did it.
        assert [frame["activity"] for frame in refreshes] == ["reading"]
        assert all(frame["round"] >= 1 and frame["actor"] == "Nora" for frame in refreshes)
        assert reply["type"] == "narrative" and reply["speaker"] == "kp"
        assert reply["format"] == "markdown"
        # Protocol 2.0: the closing narrative carries the FULL final text and
        # replaces the streamed draft (deltas concatenate to the same text).
        full_reply = reply["text"]
        assert full_reply.strip()
        if streamed:
            assert "".join(frame["text"] for frame in streamed) == reply["text"]
            assert all(frame["id"] == reply["id"] for frame in streamed)
        assert idle == {"type": "turn_status", "status": "idle"}
        assert state["type"] == "state"

        for frame in (echo, busy, *refreshes, *streamed, reply, idle, state):
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
    await services.documents.put_singleton(
        seed_ctx.chat_key, "module_pool", {"keeper": {"truths": [{"description": SENTINEL}]}, "player": {}}
    )

    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Nora")
        await ws.send(json.dumps({"type": "input", "text": "Ask Martha what she heard."}))

        echo = await _recv(ws)
        busy = await _recv(ws)
        # The NPC speaks when the tool runs — BEFORE the reply that weaves her line
        # starts streaming. Reading the events off the finished trace instead made the
        # order depend on whether the provider streamed at all: the draft bubble opened
        # first, so a streaming turn showed the narration above the line it quoted.
        frames = []
        while True:
            frame = await _recv(ws)
            frames.append(frame)
            if frame["type"] == "turn_status" and frame["status"] == "idle":
                break
        state = await _recv(ws)
        idle = frames[-1]
        streamed = [frame for frame in frames if frame["type"] == "narrative_delta"]
        npc_frame = next(f for f in frames if f["type"] == "narrative" and f["speaker"] == "npc")
        kp_frame = next(f for f in frames if f["type"] == "narrative" and f["speaker"] == "kp")
        assert frames.index(npc_frame) < frames.index(kp_frame)
        if streamed:
            assert frames.index(npc_frame) < frames.index(streamed[0])

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

        for frame in (echo, busy, *streamed, npc_frame, kp_frame, idle, state):
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
    await services.store.state_set(ctx.chat_key, "game_clock", json.dumps({"current_time": "Night 1, 22:00"}),
    )

    state = await build_room_state(services, ctx)

    assert state["character"]["name"] == "Nora Vance"
    character_resources = {res["id"]: res for res in state["character"]["resources"]}
    assert character_resources["hp"] == {"id": "hp", "label": "HP", "value": 10, "max": 10}
    assert character_resources["san"] == {"id": "san", "label": "SAN", "value": 50, "max": 99}
    nora = next(member for member in state["party"] if member["name"] == "Nora Vance")
    party_resources = {res["id"]: res for res in nora["resources"]}
    assert party_resources["hp"] == {"id": "hp", "label": "HP", "value": 10, "max": 10}
    assert party_resources["san"] == {"id": "san", "label": "SAN", "value": 50, "max": 99}
    assert party_resources["mp"] == {"id": "mp", "label": "MP", "value": 10, "max": 10}
    assert state["clock"]["time"] == "Night 1, 22:00"


async def test_a_party_member_on_another_system_keeps_their_seat_and_their_meters():
    """Mixed-system rooms are real: a pack rulepack that declares its own `system:`
    resolves to a different canonical id than the base it extends, so one PC built on
    the module's system and one on the base land in the same room. Nothing on the wire
    needs them to agree: each member's `resources` is the generic list, labelled from
    THAT member's own pack, and a client renders each row on its own — so nobody is
    dropped for their system, and nobody loses their meters for it either."""
    services = _services()
    ctx = _room_ctx("mixed-system-state", user_id="dnd-player")
    coc = services.characters.generate_character("coc7", "Nora Vance")
    dnd = services.characters.generate_character("dnd5e", "Kael Thorn")
    await services.characters.save_character("coc-player", ctx.chat_key, coc)
    await services.characters.save_character(ctx.user_id, ctx.chat_key, dnd)

    state = await build_room_state(services, ctx)

    assert state["character"]["system"] == "dnd5e"
    party = {member["name"]: member for member in state["party"]}
    assert set(party) == {"Nora Vance", "Kael Thorn"}
    assert party["Kael Thorn"].get("resources"), "the viewer's own system renders meters"
    nora = party["Nora Vance"]["resources"]
    assert nora, "a member on another system keeps their meters too"
    # …labelled from HER pack, not the viewer's: CoC's vitals, not a d20 sheet's.
    assert {entry["id"] for entry in nora} >= {"hp", "san"}
    assert all(set(entry) == {"id", "label", "value", "max"} for entry in nora)
    roster = await services.characters.get_party_roster(ctx.chat_key)
    assert {member["name"] for member in roster} == {"Nora Vance", "Kael Thorn"}


# ---------------------------------------------------------------------------
# BUG B: history replay on join -- a joining/reconnecting player sees the
# room's recent narrative instead of an empty log.
# ---------------------------------------------------------------------------


async def test_a_check_lane_roll_never_lands_under_the_open_draft_bubble():
    """The end-of-turn check lane does not stream. Its corrective roll used to publish
    UNDER the already-open final draft, and the corrected narration then replaced that
    draft in place — narration above the roll live, roll above the narration on replay.
    A public tool event now closes an open draft first (an empty final the client drops)
    and the final reply takes a fresh id: dice, then narration, live and replayed alike."""

    def responder(messages, tools):
        called = _tools_called_this_turn(messages)
        if "roll_dice" not in called:
            # The reply STATES a roll no tool made — `dice_forged` fires and the check
            # lane asks for the real dice…
            if not any(m.get("role") == "user" and "roll" in str(m.get("content", "")).lower() for m in messages[-1:]):
                return assistant_text("Spot Hidden — 22 vs 25. You find nothing.")
            return assistant_tools(tool_call("roll_dice", expression="1d100"))
        return assistant_text("Spot Hidden — the die decides. You find nothing.")

    services = _services(responder=responder)
    toolset = build_kp_toolset(services)
    keystore = Keystore()
    key = keystore.add(room="check-lane-room", name="Nora")
    server = TuiServer(services, keystore, port=0, toolset=toolset)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Nora")
        await ws.send(json.dumps({"type": "input", "text": "I search the desk."}))
        await _recv(ws)  # echo
        await _recv(ws)  # busy
        frames = []
        while True:
            frame = await _recv(ws)
            frames.append(frame)
            if frame["type"] == "turn_status" and frame["status"] == "idle":
                break
        kinds = [f["type"] for f in frames]
        assert "dice" in kinds, kinds
        dice_at = kinds.index("dice")
        deltas = [i for i, f in enumerate(frames) if f["type"] == "narrative_delta"]
        finals = [f for f in frames if f["type"] == "narrative" and f["speaker"] == "kp"]
        # The forged draft streamed, then was CLOSED (empty final, same id) before the roll…
        assert deltas and deltas[-1] < dice_at
        draft_id = frames[deltas[0]]["id"]
        closed = next(f for f in finals if f["id"] == draft_id)
        assert closed["text"] == "" and frames.index(closed) < dice_at
        # …and the corrected narration comes AFTER the roll, under a fresh id.
        final = next(f for f in finals if f["text"])
        assert final["id"] != draft_id and frames.index(final) > dice_at
        await ws.close()
    finally:
        await server.close()


async def test_join_replays_this_turn_s_rolls_and_npc_lines_in_order():
    """A reconnecting member used to get a transcript with every roll missing.

    Only prose was ever stored, so replay could only render prose: the same scene read
    one way for whoever stayed connected and another for whoever rejoined — which is
    exactly what a keeper rebuilding a client all evening sees.
    """
    from gateway.hub import Event
    from gateway.turn import record_turn_events

    services = _services()
    keystore = Keystore()
    key = keystore.add(room="event-replay-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("event-replay-room").chat_key
        # The write order of a live turn: the player line lands when the turn starts,
        # each roll / NPC line is recorded the moment it happens (anchored to whatever
        # message the transcript ends on), the reply lands when the turn closes.
        await append_message(
            services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I ask Martha what she heard", turn=1
        )
        await record_turn_events(
            services,
            chat_key,
            [
                Event.dice(actor="Ann", kind="check", expr="1d100", total=37),
                Event.narrative(speaker="npc", name="Martha", text="I heard the gate.", fmt="markdown"),
            ],
        )
        await append_message(
            services,
            chat_key,
            DEFAULT_HISTORY_KEY,
            role="assistant",
            content="Martha's warning leaves the room quiet.",
            turn=1,
        )

        ws = await websockets.connect(url)
        await _join(ws, key, "Ann")
        await _recv(ws)  # own join presence

        frames = [await _recv(ws) for _ in range(4)]
        kinds = [(frame["type"], frame.get("speaker")) for frame in frames]
        assert kinds == [
            ("narrative", "player"),
            ("dice", None),
            ("narrative", "npc"),
            ("narrative", "kp"),
        ], kinds
        assert frames[1]["total"] == 37
        assert frames[2]["name"] == "Martha"

        await ws.close()
    finally:
        await server.close()


async def test_join_replays_typed_rolls_where_they_happened_between_the_narrations():
    """The command branch's dice (`.ra`, `r 3d6`, `.sc`) — the most common rolls at a
    table — never entered the replay lane: only the AI-Keeper branch recorded, so a
    rejoin kept the prose and lost every typed roll. Every public event is anchored to
    the message the transcript ended on when it happened, so a typed roll replays right
    after the reply it followed — and one made before the first turn sits at the top."""
    from gateway.hub import Event
    from gateway.turn import record_turn_events

    services = _services()
    keystore = Keystore()
    key = keystore.add(room="after-replay-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("after-replay-room").chat_key
        # A roll before the first AI turn: anchored to the root.
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="roll", expr="1d20", total=3)])
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I look", turn=1)
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="check", expr="1d100", total=37)])
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Fog.", turn=1)
        # A typed roll after turn 1's reply …
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="roll", expr="3d6", total=11)])
        # … and turn 2 whose reply is EMPTY (all stripped machinery) but which rolled.
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I search", turn=2)
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="check", expr="1d100", total=88)])
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="", turn=2)

        ws = await websockets.connect(url)
        await _join(ws, key, "Ann")
        await _recv(ws)  # own join presence

        frames = [await _recv(ws) for _ in range(7)]
        seen = [(f["type"], f.get("speaker"), f.get("total")) for f in frames]
        assert seen == [
            ("dice", None, 3),  # before any turn
            ("narrative", "player", None),  # turn 1: I look
            ("dice", None, 37),  # during turn 1
            ("narrative", "kp", None),  # Fog.
            ("dice", None, 11),  # typed after turn 1
            ("narrative", "player", None),  # turn 2: I search
            ("dice", None, 88),  # during turn 2 — its reply was empty, the roll still replays
        ], seen
        await ws.close()
    finally:
        await server.close()


async def test_typed_rolls_replay_even_when_no_ai_turn_has_ever_run():
    """A table that has only rolled so far — no KP turn, an empty transcript: the rolls
    are anchored to the root and a joiner sees them (they used to need an assistant
    message in the window to hang off)."""
    from gateway.hub import Event
    from gateway.turn import record_turn_events

    services = _services()
    keystore = Keystore()
    key = keystore.add(room="rolls-only-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("rolls-only-room").chat_key
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="roll", expr="1d20", total=3)])
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="roll", expr="1d6", total=5)])
        ws = await websockets.connect(url)
        await _join(ws, key, "Ann")
        await _recv(ws)  # presence
        frames = [await _recv(ws) for _ in range(2)]
        assert [(f["type"], f.get("total")) for f in frames] == [("dice", 3), ("dice", 5)]
        await ws.close()
    finally:
        await server.close()


async def test_a_companion_s_exchange_and_the_rolls_around_it_replay_in_the_live_order():
    """A companion sub-turn runs INSIDE the player's turn: the player line is already on
    the path (persisted at turn start), the KP's first roll follows it, the companion's
    exchange follows that, a second roll follows the companion, and the KP's reply
    closes. Both turns carry the same turn stamp (the counter advances mid-turn), which
    is why the lane anchors to message ids, never to stamps."""
    from gateway.hub import Event
    from gateway.turn import record_turn_events

    services = _services()
    keystore = Keystore()
    key = keystore.add(room="companion-order-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("companion-order-room").chat_key
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I look", turn=6)
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="check", expr="1d100", total=37)])
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="(Rook acts)", turn=6)
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Rook nods.", turn=6)
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="check", expr="1d100", total=64)])
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Fog.", turn=6)
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="roll", expr="3d6", total=11)])

        ws = await websockets.connect(url)
        await _join(ws, key, "Ann")
        await _recv(ws)  # presence
        frames = [await _recv(ws) for _ in range(7)]
        seen = [(f["type"], f.get("text") or f.get("total")) for f in frames]
        assert seen == [
            ("narrative", "I look"),
            ("dice", 37),  # after the player's line, before the companion spoke
            ("narrative", "(Rook acts)"),
            ("narrative", "Rook nods."),
            ("dice", 64),  # after the companion, before the KP's reply
            ("narrative", "Fog."),
            ("dice", 11),  # typed after the reply
        ], seen
        await ws.close()
    finally:
        await server.close()


async def test_a_malformed_turn_event_record_costs_that_record_not_the_join_replay():
    """One bad record (importable verbatim through a room backup) used to raise past
    the lane reader into `_replay_history`'s blanket except: the joiner got an EMPTY log
    — no prose, no media, no audio state — with nothing logged."""
    from gateway.hub import Event
    from gateway.turn import TURN_EVENT_HISTORY_KEY, record_turn_events

    services = _services()
    keystore = Keystore()
    key = keystore.add(room="malformed-lane-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("malformed-lane-room").chat_key
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I look", turn=1)
        await record_turn_events(services, chat_key, [Event.dice(actor="Ann", kind="check", expr="1d100", total=37)])
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Fog.", turn=1)
        raw = await services.store.state_get(chat_key, TURN_EVENT_HISTORY_KEY)
        lane = json.loads(raw)
        lane.insert(0, {"turn": "abc", "after_id": 7, "event": {"kind": "dice", "data": {"total": 1}}})
        lane.append("not even a record")
        await services.store.state_set(chat_key, TURN_EVENT_HISTORY_KEY, json.dumps(lane))

        ws = await websockets.connect(url)
        await _join(ws, key, "Ann")
        await _recv(ws)  # presence
        frames = [await _recv(ws) for _ in range(3)]
        assert [(f["type"], f.get("total")) for f in frames] == [("narrative", None), ("dice", 37), ("narrative", None)]
        await ws.close()
    finally:
        await server.close()


async def test_live_frames_published_during_a_join_replay_arrive_after_it():
    """Both carriers subscribe the member BEFORE replaying (subscribing after would lose
    frames), so an in-flight turn's frames — since 2.3 including its dice as they
    happen — could land between two REPLAYED lines. The member holds live events for
    the duration of its replay and flushes them, in order, right after."""
    from gateway.hub import Event

    services = _services()
    keystore = Keystore()
    key = keystore.add(room="hold-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    # Publish a LIVE event the moment replay starts, before its first line goes out.
    original = server._replay_history_body

    async def slow_replay(member, chat_key, replayed):
        await server.hub.publish(member.session_key, Event.dice(actor="Bob", kind="roll", expr="1d6", total=6))
        await original(member, chat_key, replayed)

    server._replay_history_body = slow_replay  # type: ignore[method-assign]
    url = await _start(server)
    try:
        chat_key = _room_ctx("hold-room").chat_key
        await append_turn(services, chat_key, DEFAULT_HISTORY_KEY, user_message="I look", reply="Fog.", turn=1)
        ws = await websockets.connect(url)
        await _join(ws, key, "Ann")
        await _recv(ws)  # presence
        frames = [await _recv(ws) for _ in range(3)]
        assert [(f["type"], f.get("total")) for f in frames] == [
            ("narrative", None),
            ("narrative", None),
            ("dice", 6),  # the live roll, AFTER the replayed past — not between its lines
        ]
        await ws.close()
    finally:
        await server.close()


async def test_a_roll_typed_during_the_join_replay_is_delivered_once():
    """A `.ra` typed while a member's replay runs is published live (held) AND recorded
    into the lane the replay reads; if the read caught it, the replay emitted it too.
    Same content, once — and a KP final that settled in the window is deduped WITH its
    held deltas, so the joiner is not left holding an open draft."""
    from gateway.hub import Event
    from gateway.turn import record_turn_events

    services = _services()
    keystore = Keystore()
    key = keystore.add(room="dedupe-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    original = server._replay_history_body

    async def racing_replay(member, chat_key, replayed):
        # Publish live (held) AND record into the lane, before the replay reads it —
        # the order the command branch does it in. `record_turn_events` stamps the
        # published object with its lane record id.
        roll = Event.dice(actor="Bob", kind="roll", expr="1d6", total=6)
        await server.hub.publish(member.session_key, roll)
        await record_turn_events(services, chat_key, [roll])
        # A SECOND, genuinely distinct roll with identical content, published live but
        # NOT yet recorded when the replay reads: it must still be delivered.
        await server.hub.publish(member.session_key, Event.dice(actor="Bob", kind="roll", expr="1d6", total=6))
        # A KP reply that settled meanwhile: history has it, and its stream was held.
        # The gateway stamps the live final with the persisted reply's record id.
        await server.hub.publish(member.session_key, Event.narrative_delta(speaker="kp", text="Rai", frame_id="fx"))
        await server.hub.publish(member.session_key, Event.narrative_delta(speaker="kp", text="n.", frame_id="fx"))
        await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I go on", turn=2)
        reply_id = await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Rain.", turn=2)
        final = Event.narrative(speaker="kp", text="Rain.", fmt="markdown", frame_id="fx")
        final.origin_id = reply_id
        await server.hub.publish(member.session_key, final)
        await original(member, chat_key, replayed)

    server._replay_history_body = racing_replay  # type: ignore[method-assign]
    url = await _start(server)
    try:
        chat_key = _room_ctx("dedupe-room").chat_key
        await append_turn(services, chat_key, DEFAULT_HISTORY_KEY, user_message="I look", reply="Fog.", turn=1)
        ws = await websockets.connect(url)
        await _join(ws, key, "Ann")
        await _recv(ws)  # presence
        # Replay: I look, Fog., [dice 6 anchored after Fog.], I go on, Rain. — then the
        # hold flushes: the recorded roll and the final are the replayed records
        # (dropped, the deltas of the dropped final with them), the SECOND identical
        # roll is not (delivered). The next frame is the join-time state snapshot.
        frames = [await _recv(ws) for _ in range(7)]
        assert [(f["type"], f.get("text") or f.get("total")) for f in frames] == [
            ("narrative", "I look"),
            ("narrative", "Fog."),
            ("dice", 6),
            ("narrative", "I go on"),
            ("narrative", "Rain."),
            ("dice", 6),  # the second, distinct roll — identity, not content, decides
            ("state", None),
        ]
        await ws.close()
    finally:
        await server.close()


async def test_join_replays_recent_chat_history_to_the_joiner_only():
    services = _services()
    keystore = Keystore()
    key_ann = keystore.add(room="replay-room", name="Ann")
    key_bob = keystore.add(room="replay-room", name="Bob")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("replay-room").chat_key
        # Seeded through the REAL write path — the M20 D append-only tree that every
        # `run_kp_turn` uses. Seeding the retired `room_state["chat_history"]` blob here
        # once let this test stay green while every real room's join replay read that
        # forever-empty key and delivered nothing.
        await append_turn(
            services,
            chat_key,
            DEFAULT_HISTORY_KEY,
            user_message="I open the door",
            reply="The door creaks open onto a dark hallway.",
            turn=1,
        )

        ws_ann = await websockets.connect(url)
        await _join(ws_ann, key_ann, "Ann")
        await _recv(ws_ann)  # Ann's own join presence

        replay1 = await _recv(ws_ann)
        replay2 = await _recv(ws_ann)
        state_ann = await _recv(ws_ann)
        await _recv(ws_ann)  # Ann's own join-time ui_manifest (v1.8)

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


async def test_join_replay_falls_back_to_the_pre_migration_history_blob():
    """A room that upgraded across M20 D but has not taken a turn yet still holds its
    conversation only in the old `room_state` blob (the first turn adopts the blob into
    the tree and clears it). Until that turn, a joiner must still see the story."""
    services = _services()
    keystore = Keystore()
    key_ann = keystore.add(room="legacy-replay-room", name="Ann")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        chat_key = _room_ctx("legacy-replay-room").chat_key
        history = [
            {"role": "user", "content": "I open the door"},
            {"role": "assistant", "content": "The door creaks open onto a dark hallway."},
        ]
        await services.store.state_set(chat_key, "chat_history", json.dumps(history))

        ws_ann = await websockets.connect(url)
        await _join(ws_ann, key_ann, "Ann")
        await _recv(ws_ann)  # join presence
        replay1 = await _recv(ws_ann)
        replay2 = await _recv(ws_ann)

        assert replay1["type"] == "narrative"
        assert replay1["text"] == "I open the door"
        assert replay2["text"] == "The door creaks open onto a dark hallway."
        await ws_ann.close()
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
        # 20 real turns = 40 tree records ("line 0"…"line 39"), via the same write path
        # the loop uses, so the cap is pinned on the lane joins actually read.
        for turn in range(20):
            await append_turn(
                services,
                chat_key,
                DEFAULT_HISTORY_KEY,
                user_message=f"line {2 * turn}",
                reply=f"line {2 * turn + 1}",
                turn=turn + 1,
            )

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
# Privilege-escalation regression (see `gateway.commands.rooms._privilege_level`): the
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


async def test_upload_policy_is_broadcast_and_greets_late_joiners():
    """UPSTREAM item 14 (from the studio): the upload-policy toggle used to be a
    unicast ack, so every OTHER member's client could only learn "uploads are off"
    from its first refused offer. Now the toggle broadcasts, and a joining member is
    greeted with the policy — but only in its non-default state, so the ordinary
    join sequence stays frame-identical."""
    services = _services()
    keystore = Keystore()
    keeper_key = keystore.add(room="policy", name="KP", role="keeper")
    player_key = keystore.add(room="policy", name="Ada", role="player")
    late_key = keystore.add(room="policy", name="Late", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        kp, _, _, _ = await _connect_and_join(url, keeper_key)
        player, _, _, _ = await _connect_and_join(url, player_key)

        await kp.send(json.dumps({"type": "media_set_enabled", "enabled": False}))
        assert (await _recv_until(kp, "media_enabled"))["enabled"] is False
        # The broadcast is the point: the player who never asked hears the policy too.
        assert (await _recv_until(player, "media_enabled"))["enabled"] is False

        # A member joining AFTER the toggle is greeted with the off-state (the frame
        # rides the join replay, so drain by type rather than by fixed position).
        late = await websockets.connect(url)
        assert (await _join(late, late_key))["type"] == "welcome"
        assert (await _recv_until(late, "media_enabled"))["enabled"] is False

        # Re-enabling broadcasts too, and restores the default...
        await kp.send(json.dumps({"type": "media_set_enabled", "enabled": True}))
        assert (await _recv_until(player, "media_enabled"))["enabled"] is True
        await late.close()

        # ...so a fresh join gets NO media_enabled frame: the next thing after the
        # join drain is this ping's pong, proving the default join sequence is back.
        fresh, _, _, _ = await _connect_and_join(url, late_key)
        await fresh.send(json.dumps({"type": "ping", "t": 7}))
        frame = await _recv(fresh)
        assert frame["type"] == "pong" and frame["t"] == 7
        await fresh.close()
        await kp.close()
        await player.close()
    finally:
        await server.close()
