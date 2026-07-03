"""Offline coverage for the Iroh transport's newline framing + member send.

The full p2p round-trip needs two live endpoints + a relay (a manual/opt-in check, and
`iroh` is an optional native dep), so these unit-test the transport-agnostic framing logic
with fakes — the bug-prone part where a QUIC byte stream is cut back into protocol frames.
`net.iroh_server` imports cleanly without `iroh` installed (it is imported lazily in
`IrohServer.start`), so this always runs.
"""

import asyncio
import json

from net.iroh_server import IrohMember, _LineReader, _parse_line


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
