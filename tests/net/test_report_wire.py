"""The HTML session report over the wire (protocol 2.4).

End to end against a real `TuiServer`: who may trigger the reveal edition, who receives
the `report` frame, who may GET which blob (and that a refused GET is indistinguishable
from an unknown hash), and that report blobs never ride a media broadcast, the media
history, join replay or a room export — and leave with the room's media at `.reset all`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json

import websockets

from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.hub import RoomHub
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from infra.media_store import AUDIENCE_KEEPER, AUDIENCE_MEMBERS
from net.keystore import Keystore
from net.room_backup import _media_store, reset_room_state, room_media_entries
from net.tui_server import TuiServer, _pack_media_message, _unpack_media_message
from tests.documents.report_fixtures import SENTINELS, seed_report_room

ROOM = "lamp"
CHAT_KEY = SessionSource(platform="tui", chat_type="group", chat_id=ROOM).chat_key()


async def _drain(ws, quiet: float = 0.6) -> list:
    """Every message that arrives until the socket has been quiet for `quiet` seconds."""
    received: list = []
    while True:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=quiet)
        except TimeoutError:
            return received
        received.append(raw if isinstance(raw, bytes) else json.loads(raw))


async def _join(url: str, key: str) -> tuple[object, list]:
    ws = await websockets.connect(url)
    await ws.send(json.dumps({"type": "join", "key": key}))
    frames = []
    while True:
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        frames.append(frame)
        if frame.get("type") == "ui_manifest":
            return ws, frames


async def _get(ws, digest: str):
    await ws.send(_pack_media_message({"op": "get", "hash": digest}))
    raw = await asyncio.wait_for(ws.recv(), timeout=5)
    if isinstance(raw, bytes):
        return _unpack_media_message(raw)
    return json.loads(raw), b""


def _of_type(frames: list, kind: str) -> list[dict]:
    return [frame for frame in frames if isinstance(frame, dict) and frame.get("type") == kind]


async def _setup(tmp_path):
    settings = Settings(locale="en", data_dir=str(tmp_path))
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(16))
    keystore = Keystore()
    keeper_key = keystore.add(room=ROOM, name="Kip", role="keeper")
    player_key = keystore.add(room=ROOM, name="Pia", role="player")
    hub = RoomHub()
    router = CommandRouter(services, keystore=keystore, hub=hub)
    server = TuiServer(services, keystore, port=0, command_router=router, hub=hub)
    await seed_report_room(services, CHAT_KEY)
    await server.start()
    return services, keystore, server, f"ws://127.0.0.1:{server.bound_port}/", keeper_key, player_key


async def test_reveal_report_is_keeper_only_end_to_end(tmp_path):
    services, keystore, server, url, keeper_key, player_key = await _setup(tmp_path)
    i18n = services.i18n.with_locale("en")
    try:
        ws_k, _ = await _join(url, keeper_key)
        ws_p, _ = await _join(url, player_key)
        await _drain(ws_k)

        # A player cannot trigger the reveal edition: the standard refusal, privately.
        await ws_p.send(json.dumps({"type": "input", "text": ".report html reveal"}))
        player_frames = await _drain(ws_p)
        keeper_frames = await _drain(ws_k)
        assert not _of_type(player_frames, "report")
        assert i18n.t("rooms.denied") in [f.get("text") for f in _of_type(player_frames, "narrative")]
        assert not _of_type(keeper_frames, "report")
        assert not [f for f in _of_type(keeper_frames, "narrative") if f.get("speaker") == "system"]
        assert await _media_store(services).list_room_records(CHAT_KEY) == []

        # The keeper can, and the frame reaches the keeper ONLY.
        await ws_k.send(json.dumps({"type": "input", "text": ".report html reveal"}))
        keeper_frames = await _drain(ws_k)
        player_frames = await _drain(ws_p)
        reports = _of_type(keeper_frames, "report")
        assert len(reports) == 1
        report = reports[0]
        assert set(report) == {"type", "hash", "name", "size", "mime", "variant"}
        assert report["variant"] == "reveal" and report["mime"] == "text/html"
        assert report["name"].endswith("-reveal.html")
        assert i18n.t("commands.report.html.sent_reveal") in [f.get("text") for f in _of_type(keeper_frames, "narrative")]
        assert not _of_type(player_frames, "report")
        assert not _of_type(player_frames, "media")
        assert report["hash"] not in json.dumps([f for f in player_frames if isinstance(f, dict)])
        assert not [f for f in _of_type(player_frames, "narrative") if f.get("speaker") in ("system", "player")]

        # The player connection cannot GET it — and cannot tell it from an unknown hash.
        refused, body = await _get(ws_p, report["hash"])
        unknown, _ = await _get(ws_p, "0" * 64)
        assert body == b""
        assert refused == unknown
        assert refused["type"] == "error" and refused["code"] == "media_not_found"

        # The keeper connection can; the bytes are the announced, sha-verified page.
        header, data = await _get(ws_k, report["hash"])
        assert header["mime"] == "text/html" and header["size"] == report["size"]
        assert hashlib.sha256(data).hexdigest() == report["hash"]
        assert SENTINELS["truth"] in data.decode("utf-8")

        # The player edition is any member's to trigger and fetch — and carries no secret.
        await ws_p.send(json.dumps({"type": "input", "text": ".团报 网页"}))
        player_frames = await _drain(ws_p)
        keeper_frames = await _drain(ws_k)
        mine = _of_type(player_frames, "report")
        assert len(mine) == 1 and mine[0]["variant"] == "player"
        assert not _of_type(keeper_frames, "report")
        _, page = await _get(ws_p, mine[0]["hash"])
        assert hashlib.sha256(page).hexdigest() == mine[0]["hash"]
        assert not [name for name, value in SENTINELS.items() if value in page.decode("utf-8")]
        _, keeper_copy = await _get(ws_k, mine[0]["hash"])
        assert keeper_copy == page

        records = {record.hash: record.audience for record in await _media_store(services).list_room_records(CHAT_KEY)}
        assert records == {report["hash"]: AUDIENCE_KEEPER, mine[0]["hash"]: AUDIENCE_MEMBERS}

        # Never in the media history a join replays, never in a late joiner's replay.
        history = await services.store.state_get(CHAT_KEY, "media_history")
        assert not history or report["hash"] not in history and mine[0]["hash"] not in history
        late_key = keystore.add(room=ROOM, name="Lou", role="keeper")
        ws_late, joined = await _join(url, late_key)
        joined += await _drain(ws_late)
        dumped = json.dumps([f for f in joined if isinstance(f, dict)])
        assert report["hash"] not in dumped and mine[0]["hash"] not in dumped
        assert not _of_type(joined, "report") and not _of_type(joined, "media")

        # Never in a room export (the snapshot carries listed media only).
        exported = {entry["hash"] for entry in await room_media_entries(services, CHAT_KEY)}
        assert report["hash"] not in exported and mine[0]["hash"] not in exported

        for ws in (ws_k, ws_p, ws_late):
            await ws.close()
    finally:
        await server.close()


async def test_report_blobs_live_and_die_with_the_room_media_family(tmp_path):
    services, _keystore, server, url, keeper_key, _player_key = await _setup(tmp_path)
    try:
        ws_k, _ = await _join(url, keeper_key)
        await ws_k.send(json.dumps({"type": "input", "text": ".report html reveal"}))
        report = _of_type(await _drain(ws_k), "report")[0]
        await ws_k.close()
    finally:
        await server.close()

    media = _media_store(services)
    image = await media.register_blob(room=CHAT_KEY, data=b"\x89PNG\r\n\x1a\nmap", mime="image/png", name="m.png", uploader="k")
    # `room_media` dies at `.reset all`; a story reset keeps the media table whole.
    await reset_room_state(services, CHAT_KEY, scope="story")
    assert {record.hash for record in await media.list_room_records(CHAT_KEY)} == {image.hash, report["hash"]}
    await reset_room_state(services, CHAT_KEY, scope="all")
    assert await media.list_room_records(CHAT_KEY) == []
    assert not media._path(CHAT_KEY, report["hash"]).exists()


async def test_local_cli_writes_the_file_instead(tmp_path):
    from agent.context import AgentCtx, LocalFs

    services = build_services(Settings(locale="en", data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(16))
    chat_key = "cli:dm:local"
    await seed_report_room(services, chat_key)
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key=chat_key, user_id="op", platform="cli", locale="en", fs=LocalFs(tmp_path))
    reply = await router.dispatch_reply(ctx, ".report html reveal")
    assert reply is not None and not reply.error and reply.private
    assert not reply.events  # no byte channel: no report frame
    saved = list((tmp_path / "shared").glob("loreweaver-report-*-reveal.html"))
    assert len(saved) == 1
    assert SENTINELS["margin"] in saved[0].read_text(encoding="utf-8")
    assert await _media_store(services).list_room_records(chat_key) == []
