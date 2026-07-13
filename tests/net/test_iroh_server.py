"""Offline coverage for the Iroh transport's newline framing + member send, plus (where the
optional `iroh` native dep is installed) the persisted-secret-key identity guarantees.

The full p2p round-trip needs two live endpoints + a relay (a manual/opt-in check, and
`iroh` is an optional native dep), so these unit-test the transport-agnostic framing logic
with fakes — the bug-prone part where a QUIC byte stream is cut back into protocol frames.
`net.iroh_server` imports cleanly without `iroh` installed (it is imported lazily in
`IrohServer.start`), so this always runs.
"""

import asyncio
import json
import os
import stat

import pytest

from net.iroh_server import (
    IrohMember,
    _LineReader,
    _parse_line,
    _write_bytes_chunked,
    _write_line,
    load_or_create_secret,
)


class _FakeRecv:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)

    async def read(self, _n: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""  # b"" == EOF


class _FakeSend:
    def __init__(self) -> None:
        self.written = bytearray()

    async def write_all(self, buf: bytes) -> None:
        self.written.extend(buf)


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
        await _write_line(send, {"size": 6})
        await _write_bytes_chunked(send, b"abcdef", chunk_size=2)

    asyncio.run(go())
    line, body = bytes(send.written).split(b"\n", 1)
    assert json.loads(line) == {"size": 6}
    assert body == b"abcdef"


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


def test_serve_iroh_sigterm_triggers_clean_shutdown(monkeypatch, tmp_path) -> None:
    """SIGTERM (systemd `stop`/`restart`) must cancel serve() and run the finally-close, not
    hard-kill the process — so the endpoint/store shut down cleanly on a deploy restart."""
    if os.name != "posix":
        pytest.skip("add_signal_handler / SIGTERM handling is POSIX-only")
    import signal

    import app as app_module
    from infra.i18n import get_i18n

    started = asyncio.Event()
    closed = {"value": False}

    class _FakeIrohServer:
        def __init__(self, core, *, secret_path=None) -> None:  # noqa: D401 - test stub
            pass

        async def start(self) -> str:
            return "ticket-test"

        async def serve(self) -> None:
            started.set()
            await asyncio.Event().wait()  # block until cancelled by the SIGTERM handler

        async def close(self) -> None:
            closed["value"] = True

    # `_serve_iroh` does `from net.iroh_server import IrohServer` at call time, so patch the source.
    monkeypatch.setattr("net.iroh_server.IrohServer", _FakeIrohServer)
    monkeypatch.setattr(app_module, "_announce_iroh_ticket", lambda *a, **k: None)

    async def go() -> bool:
        task = asyncio.ensure_future(
            app_module._serve_iroh(object(), get_i18n("en"), str(tmp_path / "keys.toml"))
        )
        # The signal handler is installed BEFORE serve() runs, so once `started` is set it is
        # safe to raise SIGTERM without the default disposition killing the test runner.
        await asyncio.wait_for(started.wait(), timeout=5)
        os.kill(os.getpid(), signal.SIGTERM)
        return await asyncio.wait_for(task, timeout=5)

    result = asyncio.run(go())
    assert result is True  # a clean stop returns True
    assert closed["value"] is True  # the finally-close actually ran
