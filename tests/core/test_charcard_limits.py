"""Resource-exhaustion guards + compressed-chunk coverage for the card parser.

Covers the previously-untested zTXt/iTXt PNG text chunks and pins the two
denial-of-service fixes: a bounded card-file read (an `.import /dev/zero` or a
huge file is refused) and a capped zlib inflate (a text-chunk bomb raises
instead of exhausting memory).
"""

from __future__ import annotations

import base64
import json
import os
import struct
import zlib

import pytest

from core.charcard import (
    MAX_CARD_FILE_BYTES,
    MAX_DECOMPRESSED_BYTES,
    parse_card_bytes,
    parse_card_file,
)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    head = struct.pack(">I", len(payload)) + kind + payload
    crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return head + struct.pack(">I", crc)


def _card_payload() -> bytes:
    raw = {"spec": "chara_card_v2", "data": {"name": "Ada", "description": "scholar"}}
    return base64.b64encode(json.dumps(raw).encode("utf-8"))


def _ztxt_payload(text: bytes, keyword: bytes = b"chara") -> bytes:
    return keyword + b"\x00" + b"\x00" + zlib.compress(text)


def _itxt_payload(text: bytes, *, compressed: bool, keyword: bytes = b"chara") -> bytes:
    flag = b"\x01" if compressed else b"\x00"
    body = zlib.compress(text) if compressed else text
    return keyword + b"\x00" + flag + b"\x00" + b"\x00" + b"\x00" + body


def _png(chunk_type: bytes, payload: bytes) -> bytes:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        PNG_SIGNATURE
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(chunk_type, payload)
        + _png_chunk(b"IEND", b"")
    )


def test_ztxt_compressed_chunk_parses():
    card = parse_card_bytes(_png(b"zTXt", _ztxt_payload(_card_payload())), filename="ada.png")
    assert card.name == "Ada"
    assert card.description == "scholar"


def test_itxt_compressed_chunk_parses():
    card = parse_card_bytes(
        _png(b"iTXt", _itxt_payload(_card_payload(), compressed=True)), filename="ada.png"
    )
    assert card.name == "Ada"


def test_itxt_uncompressed_chunk_parses():
    card = parse_card_bytes(
        _png(b"iTXt", _itxt_payload(_card_payload(), compressed=False)), filename="ada.png"
    )
    assert card.name == "Ada"


def test_ztxt_zlib_bomb_is_rejected():
    # ~5MB of zeros compresses to a few KB; without the cap this inflates in full.
    bomb = zlib.compress(b"\x00" * (MAX_DECOMPRESSED_BYTES + 1024))
    data = _png(b"zTXt", b"chara\x00\x00" + bomb)
    with pytest.raises(ValueError, match="exceeds the size limit"):
        parse_card_bytes(data, filename="bomb.png")


def test_itxt_zlib_bomb_is_rejected():
    bomb = zlib.compress(b"\x00" * (MAX_DECOMPRESSED_BYTES + 1024))
    payload = b"chara\x00" + b"\x01" + b"\x00" + b"\x00" + b"\x00" + bomb
    data = _png(b"iTXt", payload)
    with pytest.raises(ValueError, match="exceeds the size limit"):
        parse_card_bytes(data, filename="bomb.png")


def test_oversize_card_file_is_rejected(tmp_path):
    big = tmp_path / "big.png"
    # Sparse file: st_size trips the guard without allocating the bytes.
    with big.open("wb") as handle:
        handle.seek(MAX_CARD_FILE_BYTES + 1)
        handle.write(b"\x00")
    with pytest.raises(ValueError, match="exceeds the size limit"):
        parse_card_file(big)


@pytest.mark.skipif(not os.path.exists("/dev/zero"), reason="no /dev/zero on this platform")
def test_character_device_is_rejected():
    # `.import /dev/zero`: st_size is 0 but the stream never ends -> must be refused.
    with pytest.raises(ValueError, match="not a regular file"):
        parse_card_file("/dev/zero")
