"""Offline coverage for the Iroh transport's newline framing + member send, plus (where the
optional `iroh` native dep is installed) the persisted-secret-key identity guarantees.

The full p2p round-trip needs two live endpoints + a relay (a manual/opt-in check, and
`iroh` is an optional native dep), so these unit-test the transport-agnostic framing logic
with fakes — the bug-prone part where a QUIC byte stream is cut back into protocol frames.
`net.iroh_server` imports cleanly without `iroh` installed (it is imported lazily in
`IrohServer.start`), so this always runs.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import stat
import subprocess
import sys
import textwrap
import threading
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.hub import Event
from net.iroh_server import (
    IrohMember,
    IrohServer,
    _close_transport,
    _LineReader,
    _parse_line,
    _write_bytes_chunked,
    _write_line,
    load_or_create_secret,
)
from net.keystore import KeyEntry, Keystore


class _FakeRecv:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)

    async def read(self, _n: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""  # b"" == EOF


class _FakeSend:
    def __init__(self) -> None:
        self.written = bytearray()
        self.finished = False

    async def write_all(self, buf: bytes) -> None:
        self.written.extend(buf)

    async def finish(self) -> None:
        self.finished = True


class _FailSend:
    async def write_all(self, _buf: bytes) -> None:
        raise ConnectionError("stream reset")


class _HangRecv:
    def __init__(self) -> None:
        self.entered = asyncio.Event()

    async def read(self, _n: int) -> bytes:
        self.entered.set()
        await asyncio.Event().wait()
        return b""


class _FakeBi:
    def __init__(self, send: _FakeSend, recv: object) -> None:
        self._send = send
        self._recv = recv

    def send(self) -> _FakeSend:
        return self._send

    def recv(self) -> object:
        return self._recv


class _FakeConn:
    def __init__(self, send: _FakeSend, recv: object) -> None:
        self._bi = _FakeBi(send, recv)
        self.close_calls: list[tuple[int, bytes]] = []

    async def accept_bi(self) -> _FakeBi:
        return self._bi

    def close(self, error_code: int = 0, reason: bytes = b"") -> None:
        self.close_calls.append((error_code, reason))


class _FakeIncoming:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def accept(self) -> _FakeIncoming:
        return self

    async def connect(self) -> _FakeConn:
        return self._conn


class _FakeTui:
    update_command = ""


class _FakeSettings:
    locale = "en"
    tui = _FakeTui()


class _FakeServices:
    settings = _FakeSettings()
    imagegen = None


class _SpyHub:
    def __init__(self) -> None:
        self.subscribed = 0

    async def subscribe(self, *_a, **_k) -> None:
        self.subscribed += 1


class _FakeCore:
    def __init__(self, *, join_timeout: float = 1.0, authorized: bool = True, keys: dict | None = None) -> None:
        entries = keys if keys is not None else {"good": KeyEntry(key="good", room="room", name="Alice", role="player")}
        self.keystore = Keystore(entries)
        self.join_timeout = join_timeout
        self.services = _FakeServices()
        self._authorized = authorized
        self.hub = _SpyHub()

    def _refresh_member_authorization(self, _member) -> bool:
        return self._authorized


def _written_frames(send: _FakeSend) -> list[dict]:
    raw = bytes(send.written)
    if not raw:
        return []
    return [json.loads(line) for line in raw.split(b"\n") if line]


def _member(send: _FakeSend | None = None, **overrides) -> IrohMember:
    fields = dict(
        send=send or _FakeSend(),
        id="i",
        user_key="u",
        name="n",
        role="player",
        room="r",
        session_key="s",
        locale="en",
    )
    fields.update(overrides)
    return IrohMember(**fields)


def test_linereader_splits_frames_across_chunk_boundaries() -> None:
    # Two frames cut awkwardly across chunk boundaries, then a trailing partial with no newline.
    reader = _LineReader(_FakeRecv([b'{"a":1}\n{"b"', b':2}\n', b'{"c":3}']))

    async def go() -> list[bytes | None]:
        return [await reader.readline(), await reader.readline(), await reader.readline()]

    lines = asyncio.run(go())
    assert lines[0] == b'{"a":1}'
    assert lines[1] == b'{"b":2}'
    assert lines[2] is None  # incomplete trailing frame at EOF is dropped


def test_linereader_eof_returns_none() -> None:
    reader = _LineReader(_FakeRecv([]))
    assert asyncio.run(reader.readline()) is None


def test_parse_line() -> None:
    assert _parse_line(b'{"type":"join","key":"k"}') == {"type": "join", "key": "k"}
    assert _parse_line(b"not json") is None
    assert _parse_line(b"[1,2]") is None  # a JSON array is not a frame object


def test_irohmember_send_frame_is_newline_json() -> None:
    send = _FakeSend()
    member = IrohMember(
        send=send, id="i", user_key="u", name="n", role="player", room="r", session_key="s", locale="en"
    )
    asyncio.run(member.send_frame({"type": "pong", "t": 1}))
    assert send.written.endswith(b"\n")
    assert json.loads(send.written[:-1]) == {"type": "pong", "t": 1}


def test_media_linereader_preserves_body_bytes_after_header() -> None:
    reader = _LineReader(_FakeRecv([b'{"op":"put","upload_id":"u"}\nabc', b"def"]))

    async def go() -> tuple[bytes | None, bytes]:
        return await reader.readline(), await reader.read_exact(6)

    header, body = asyncio.run(go())
    assert json.loads(header or b"{}") == {"op": "put", "upload_id": "u"}
    assert body == b"abcdef"


def test_write_line_and_bytes_chunked_for_media_stream() -> None:
    send = _FakeSend()

    async def go() -> None:
        written = await _write_line(send, {"size": 6})
        assert written is True
        await _write_bytes_chunked(send, b"abcdef", chunk_size=2)

    asyncio.run(go())
    line, body = bytes(send.written).split(b"\n", 1)
    assert json.loads(line) == {"size": 6}
    assert body == b"abcdef"


def test_write_line_reports_handshake_write_failure() -> None:
    """The handshake helper must surface a dead stream so the caller can close the QUIC conn."""

    async def go() -> bool:
        return await _write_line(_FailSend(), {"type": "error", "code": "bad_key"})

    assert asyncio.run(go()) is False


# --- persisted secret key (stable NodeId / ticket across restarts) ---------
#
# These need the real `iroh` native dep (`SecretKey` isn't fakeable), so each test opts in
# via `pytest.importorskip` rather than gating the whole module — the framing tests above
# must keep running in the default offline suite even where `iroh` isn't installed.


def test_load_or_create_secret_creates_file_and_is_stable(tmp_path) -> None:
    pytest.importorskip("iroh")
    secret_path = tmp_path / "iroh-secret.key"
    assert not secret_path.exists()

    key1 = load_or_create_secret(secret_path)
    assert secret_path.exists()
    if os.name == "posix":
        mode = stat.S_IMODE(secret_path.stat().st_mode)
        assert mode == 0o600

    contents_after_first = secret_path.read_bytes()

    # A second call reuses the persisted key: same identity, unchanged file.
    if os.name == "posix":
        os.chmod(secret_path, 0o644)  # simulate a file created by an older release
    key2 = load_or_create_secret(secret_path)
    assert key2.to_bytes() == key1.to_bytes()
    assert secret_path.read_bytes() == contents_after_first
    if os.name == "posix":
        assert stat.S_IMODE(secret_path.stat().st_mode) == 0o600


def test_load_or_create_secret_self_heals_from_corrupt_file(tmp_path) -> None:
    pytest.importorskip("iroh")
    secret_path = tmp_path / "iroh-secret.key"
    secret_path.write_bytes(b"garbage")

    key = load_or_create_secret(secret_path)  # must not raise
    assert secret_path.read_bytes() != b"garbage"

    # The regenerated key is then stable across subsequent calls.
    key_again = load_or_create_secret(secret_path)
    assert key_again.to_bytes() == key.to_bytes()


def test_load_or_create_secret_same_path_yields_same_public_identity(tmp_path) -> None:
    """The property that guarantees a stable ticket: the same persisted secret always
    derives the same public key (the NodeId embedded in the ticket)."""
    pytest.importorskip("iroh")
    secret_path = tmp_path / "iroh-secret.key"

    key_a = load_or_create_secret(secret_path)
    key_b = load_or_create_secret(secret_path)
    assert str(key_a.public()) == str(key_b.public())


def test_load_or_create_secret_degrades_when_dir_unwritable(tmp_path) -> None:
    """A read-only/permission-denied data dir must NOT brick startup: the helper returns an
    in-memory key (unpersisted) instead of raising, so systemd can't crash-loop on it."""
    pytest.importorskip("iroh")
    if os.name != "posix" or (hasattr(os, "geteuid") and os.geteuid() == 0):
        pytest.skip("needs POSIX perms and a non-root euid (root bypasses the 0o500 write bit)")
    ro_dir = tmp_path / "ro"
    ro_dir.mkdir()
    os.chmod(ro_dir, 0o500)  # r-x, no write
    secret_path = ro_dir / "iroh-secret.key"
    try:
        key = load_or_create_secret(secret_path)  # must NOT raise
        assert key is not None
        assert not secret_path.exists()  # persistence failed, but startup survived
    finally:
        os.chmod(ro_dir, 0o700)  # restore so pytest's tmp cleanup can remove it


def test_iroh_server_start_passes_secret_key_as_bytes(monkeypatch, tmp_path) -> None:
    """Regression: `EndpointOptions.secret_key` is a uniffi-generated `Optional[bytes]` field,
    despite `SecretKey.generate()`/`load_or_create_secret` returning a `SecretKey` object.
    Passing the object itself type-checks fine at `EndpointOptions(...)` construction (uniffi
    validates lazily) but raises `TypeError: a bytes-like object is required, not 'SecretKey'`
    inside the real `Endpoint.bind()` — never caught offline before because every other test
    here stops short of an actual bind. This fakes `Endpoint.bind`/`EndpointTicket.from_addr`
    to capture what `IrohServer.start()` actually constructs, with no real network/relay."""
    pytest.importorskip("iroh")
    import iroh

    from net.iroh_server import IrohServer

    captured: dict[str, object] = {}

    class _FakeEndpoint:
        async def online(self) -> None:
            return None

        def addr(self):
            return None

    async def _fake_bind(_cls, options):
        captured["options"] = options
        return _FakeEndpoint()

    monkeypatch.setattr(iroh.Endpoint, "bind", classmethod(_fake_bind))
    monkeypatch.setattr(iroh.EndpointTicket, "from_addr", classmethod(lambda _cls, _addr: "ticket-fake"))

    server = IrohServer(object(), secret_path=tmp_path / "iroh-secret.key")
    ticket = asyncio.run(server.start())

    assert ticket == "ticket-fake"
    assert isinstance(captured["options"].secret_key, bytes)


@pytest.mark.parametrize("signame", ["SIGTERM", "SIGINT"])
def test_serve_iroh_stop_signal_triggers_clean_shutdown(signame, monkeypatch, tmp_path) -> None:
    """SIGTERM (systemd `stop`/`restart`) and SIGINT (Ctrl-C, `kill -INT`) must both cancel
    serve() and run the finally-close, not hard-kill the process — so the endpoint/store shut
    down cleanly on a deploy restart and a Ctrl-C closes every client's connection."""
    if os.name != "posix":
        pytest.skip("add_signal_handler / signal handling is POSIX-only")

    import app as app_module
    from infra.i18n import get_i18n

    started = asyncio.Event()
    closed = {"value": False}

    class _FakeIrohServer:
        direct_port = 0
        port_changed_from = 0

        def __init__(self, core, *, secret_path=None, port=0) -> None:  # noqa: D401 - test stub
            pass

        async def start(self) -> str:
            return "ticket-test"

        async def serve(self) -> None:
            started.set()
            await asyncio.Event().wait()  # block until cancelled by the signal handler

        async def close(self) -> None:
            closed["value"] = True

    # `_serve_iroh` does `from net.iroh_server import IrohServer` at call time, so patch the source.
    monkeypatch.setattr("net.iroh_server.IrohServer", _FakeIrohServer)
    monkeypatch.setattr(app_module, "_announce_iroh_ticket", lambda *a, **k: None)

    async def go() -> bool:
        core = SimpleNamespace(services=SimpleNamespace(settings=SimpleNamespace(tui=SimpleNamespace(iroh_port=0))))
        task = asyncio.ensure_future(app_module._serve_iroh(core, get_i18n("en"), str(tmp_path / "keys.toml")))
        # The signal handler is installed BEFORE serve() runs, so once `started` is set it is
        # safe to raise the signal without the default disposition killing the test runner.
        await asyncio.wait_for(started.wait(), timeout=5)
        os.kill(os.getpid(), getattr(signal, signame))
        return await asyncio.wait_for(task, timeout=5)

    # Start SIGINT ignored, as a process launched with a shell `&` has it: asyncio.run then installs
    # no SIGINT handling of its own, so only `_serve_iroh`'s explicit handler can make it stop.
    previous = signal.getsignal(signal.SIGINT)
    if signame == "SIGINT":
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        result = asyncio.run(go())
        if signame == "SIGINT":
            # Handlers are handed back before close(): a later Ctrl-C is Python's default again.
            assert signal.getsignal(signal.SIGINT) is signal.default_int_handler
    finally:
        signal.signal(signal.SIGINT, previous)
    assert result is True  # a clean stop returns True
    assert closed["value"] is True  # the finally-close actually ran


# A real child process running the real `app._run_serve` -> `_serve_iroh` -> signal wiring over a
# fake IrohServer. SIGINT cannot be exercised in-process the way SIGTERM can (the SECOND one must
# raise KeyboardInterrupt, and an inherited SIG_IGN is process-start state), so these spawn it.
_SERVE_CHILD = textwrap.dedent(
    """
    import argparse, asyncio, signal, sys

    import app
    import net.iroh_server
    from infra.i18n import get_i18n

    mode, sigint_disposition, keys = sys.argv[1], sys.argv[2], sys.argv[3]
    # What the process inherited at start: a shell `&` hands SIGINT over ignored.
    signal.signal(signal.SIGINT, signal.SIG_IGN if sigint_disposition == "ignored" else signal.default_int_handler)


    class _Store:
        def close(self):
            print("store-closed", flush=True)


    class _Core:
        class services:
            store = _Store()

            class settings:
                class tui:
                    iroh_port = 0


    class _FakeIroh:
        direct_port = 0
        port_changed_from = 0

        def __init__(self, core, *, secret_path=None, port=0):
            pass

        async def start(self):
            return "ticket-test"

        async def serve(self):
            print("serving", flush=True)
            await asyncio.Event().wait()

        async def close(self):
            print("closing", flush=True)
            if mode == "hang":
                await asyncio.Event().wait()  # a close that never returns
            print("closed", flush=True)


    net.iroh_server.IrohServer = _FakeIroh
    app.build_tui_server = lambda *a, **k: _Core()
    app._bootstrap_keystore = lambda *a, **k: None
    app._announce_iroh_ticket = lambda *a, **k: None
    app._uses_demo_llm = lambda services: False
    ns = argparse.Namespace(keys=keys, host="127.0.0.1", port=0)
    sys.exit(app._run_serve(None, get_i18n("en"), ns))
    """
)


def _spawn_serve_child(tmp_path: Path, mode: str, sigint_disposition: str):
    script = tmp_path / "serve_child.py"
    script.write_text(_SERVE_CHILD)
    repo_root = Path(__file__).resolve().parents[2]
    proc = subprocess.Popen(
        [sys.executable, str(script), mode, sigint_disposition, str(tmp_path / "keys.toml")],
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    watchdog = threading.Timer(20, proc.kill)  # never hang the suite on a regression
    watchdog.daemon = True
    watchdog.start()
    return proc, watchdog


def _read_until(proc, marker: str) -> list[str]:
    lines: list[str] = []
    for line in proc.stdout:
        lines.append(line.strip())
        if line.strip() == marker:
            return lines
    raise AssertionError(f"child exited before printing {marker!r}: {lines}\n{proc.stderr.read()}")


@pytest.mark.parametrize("sigint_disposition", ["default", "ignored"])
def test_serve_sigint_closes_cleanly_even_when_inherited_ignored(tmp_path, sigint_disposition) -> None:
    """ONE SIGINT runs the whole clean shutdown (close, then store, exit 0). `ignored` is the
    shell-`&` case: the process starts with SIGINT=SIG_IGN, where asyncio.run installs no handler
    of its own, so only `_serve_iroh`'s explicit one makes the signal do anything."""
    if os.name != "posix":
        pytest.skip("POSIX signals")
    proc, watchdog = _spawn_serve_child(tmp_path, "clean", sigint_disposition)
    try:
        _read_until(proc, "serving")
        proc.send_signal(signal.SIGINT)
        rest = [line.strip() for line in proc.stdout]
        assert proc.wait(timeout=30) == 0
    finally:
        watchdog.cancel()
        proc.kill()
        proc.wait()
    assert rest == ["closing", "closed", "store-closed"]


def test_serve_second_sigint_during_a_hung_close_forces_exit(tmp_path) -> None:
    """The escape hatch: a close() that never returns is abandoned by a SECOND SIGINT, which
    raises KeyboardInterrupt into `_run_serve` — the store is still closed and the exit is 0."""
    if os.name != "posix":
        pytest.skip("POSIX signals")
    proc, watchdog = _spawn_serve_child(tmp_path, "hang", "default")
    try:
        _read_until(proc, "serving")
        proc.send_signal(signal.SIGINT)
        _read_until(proc, "closing")  # handlers are already handed back by the time close() runs
        proc.send_signal(signal.SIGINT)
        rest = [line.strip() for line in proc.stdout]
        assert proc.wait(timeout=30) == 0
    finally:
        watchdog.cancel()
        proc.kill()
        proc.wait()
    assert rest == ["store-closed"]  # never "closed": the hung close was abandoned


# --- lifecycle: close drain + join-handshake fatals (deterministic fakes) ----


def test_close_awaits_endpoint_and_settles_cancelled_child_tasks() -> None:
    """`endpoint.close()` is async and must be awaited AFTER cancelled children settle.

    A bare `endpoint.close()` (the previous bug) leaves `RuntimeWarning: coroutine
    Endpoint.close was never awaited` and cleanup racing past `close()`'s return.
    """
    order: list[str] = []
    started = asyncio.Event()

    async def child() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await asyncio.sleep(0)
            order.append("child_settled")
            raise

    class _FakeEndpoint:
        async def close(self) -> None:
            order.append("endpoint_close")

    async def go() -> None:
        server = IrohServer(object())
        endpoint = _FakeEndpoint()
        server._endpoint = endpoint
        task = asyncio.create_task(child())
        server._tasks.add(task)
        task.add_done_callback(server._tasks.discard)
        await started.wait()
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            await server.close()
        assert task.done()
        assert task not in server._tasks
        assert server._endpoint is None

    asyncio.run(go())
    assert order == ["child_settled", "endpoint_close"]


def test_close_twice_is_idempotent_without_warnings() -> None:
    async def go() -> None:
        endpoint = AsyncMock()
        server = IrohServer(object())
        server._endpoint = endpoint
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            await server.close()
            await server.close()
        endpoint.close.assert_awaited_once()
        assert server._endpoint is None

    asyncio.run(go())


def test_close_unblocks_serve_accept_loop() -> None:
    """After `await endpoint.close()`, `accept_next()` returns None and `serve()` exits."""

    class _FakeEndpoint:
        def __init__(self) -> None:
            self.entered = asyncio.Event()
            self._closed = asyncio.Event()
            self.close_awaited = False

        async def accept_next(self):
            self.entered.set()
            await self._closed.wait()
            return None

        async def close(self) -> None:
            self.close_awaited = True
            self._closed.set()

    async def go() -> None:
        endpoint = _FakeEndpoint()
        server = IrohServer(object())
        server._endpoint = endpoint
        serve_task = asyncio.create_task(server.serve())
        await endpoint.entered.wait()
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            await server.close()
        await asyncio.wait_for(serve_task, timeout=1)
        assert serve_task.done()
        assert endpoint.close_awaited

    asyncio.run(go())


def test_authenticate_timeout_writes_join_timeout() -> None:
    async def go() -> None:
        recv = _HangRecv()
        send = _FakeSend()
        server = IrohServer(_FakeCore(join_timeout=0.05))
        member = await server._authenticate(_LineReader(recv), send)
        assert member is None
        frames = _written_frames(send)
        assert frames[0]["type"] == "error"
        assert frames[0]["code"] == "join_timeout"

    asyncio.run(go())


def test_authenticate_propagates_cancellation() -> None:
    async def go() -> None:
        recv = _HangRecv()
        send = _FakeSend()
        server = IrohServer(_FakeCore(join_timeout=10))
        task = asyncio.create_task(server._authenticate(_LineReader(recv), send))
        await recv.entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert bytes(send.written) == b""

    asyncio.run(go())


def test_authenticate_other_read_error_fails_cleanly() -> None:
    class _BoomReader:
        async def readline(self) -> bytes:
            raise RuntimeError("recv exploded")

    async def go() -> None:
        send = _FakeSend()
        server = IrohServer(_FakeCore())
        member = await server._authenticate(_BoomReader(), send)
        assert member is None
        assert bytes(send.written) == b""

    asyncio.run(go())


def test_handle_timeout_writes_join_timeout_and_closes_conn() -> None:
    async def go() -> None:
        send = _FakeSend()
        conn = _FakeConn(send, _HangRecv())
        server = IrohServer(_FakeCore(join_timeout=0.05))
        await server._handle(_FakeIncoming(conn))
        frames = _written_frames(send)
        assert frames[0]["code"] == "join_timeout"
        assert conn.close_calls
        assert send.finished

    asyncio.run(go())


def test_handle_bad_key_writes_error_and_closes_conn() -> None:
    async def go() -> None:
        send = _FakeSend()
        conn = _FakeConn(send, _FakeRecv([b'{"type":"join","key":"nope"}\n']))
        server = IrohServer(_FakeCore())
        await server._handle(_FakeIncoming(conn))
        frames = _written_frames(send)
        assert frames[0]["code"] == "bad_key"
        assert conn.close_calls
        assert send.finished

    asyncio.run(go())


def test_handle_bad_frame_writes_error_and_closes_conn() -> None:
    async def go() -> None:
        send = _FakeSend()
        conn = _FakeConn(send, _FakeRecv([b'{"type":"ping","t":1}\n']))
        server = IrohServer(_FakeCore())
        await server._handle(_FakeIncoming(conn))
        frames = _written_frames(send)
        assert frames[0]["code"] == "bad_frame"
        assert conn.close_calls
        assert send.finished

    asyncio.run(go())


def test_handle_live_authorization_failure_closes_conn() -> None:
    async def go() -> None:
        send = _FakeSend()
        conn = _FakeConn(send, _FakeRecv([b'{"type":"join","key":"good"}\n']))
        server = IrohServer(_FakeCore(authorized=False))
        await server._handle(_FakeIncoming(conn))
        frames = _written_frames(send)
        assert frames[0]["type"] == "welcome"
        assert frames[1]["code"] == "forbidden"
        assert conn.close_calls
        assert send.finished

    asyncio.run(go())


def test_deliver_revocation_closes_transport() -> None:
    async def go() -> None:
        send = _FakeSend()
        conn = _FakeConn(send, _FakeRecv([]))
        member = _member(send, conn=conn)
        member.authorize = lambda: False
        with pytest.raises(PermissionError):
            await member.deliver(Event.system("info", "x"))
        assert _written_frames(send)[0]["code"] == "forbidden"
        assert conn.close_calls
        assert send.finished

    asyncio.run(go())


def test_close_transport_cancel_during_finish_closes_conn_and_reraises() -> None:
    """A cancelled `finish()` must still `conn.close`, then propagate CancelledError
    — not `RuntimeError: No active exception to reraise` from a bare `raise`."""

    class _HangFinishSend:
        def __init__(self) -> None:
            self.entered = asyncio.Event()

        async def finish(self) -> None:
            self.entered.set()
            await asyncio.Event().wait()

    async def go() -> None:
        send = _HangFinishSend()
        conn = _FakeConn(_FakeSend(), _FakeRecv([]))
        task = asyncio.create_task(_close_transport(conn, send))
        await send.entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert conn.close_calls

    asyncio.run(go())


def test_welcome_write_failure_returns_none_and_does_not_subscribe() -> None:
    async def go() -> None:
        core = _FakeCore()
        server = IrohServer(core)
        member = await server._authenticate(
            _LineReader(_FakeRecv([b'{"type":"join","key":"good"}\n'])),
            _FailSend(),
        )
        assert member is None

        conn = _FakeConn(_FailSend(), _FakeRecv([b'{"type":"join","key":"good"}\n']))
        await server._handle(_FakeIncoming(conn))
        assert core.hub.subscribed == 0
        assert conn.close_calls

    asyncio.run(go())
