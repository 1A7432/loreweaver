"""SillyTavern character-card parser.

Supports direct JSON cards and PNG-embedded cards without external image
dependencies. The PNG path walks chunks and reads the textual metadata fields
used by SillyTavern cards.
"""

from __future__ import annotations

import base64
import json
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


@dataclass
class CharacterCard:
    name: str
    description: str = ""
    personality: str = ""
    scenario: str = ""
    first_mes: str = ""
    mes_example: str = ""
    creator_notes: str = ""
    tags: list[str] = field(default_factory=list)
    character_book: list[dict] = field(default_factory=list)
    raw: dict = field(default_factory=dict)


def parse_card_file(path: str | Path) -> CharacterCard:
    card_path = Path(path)
    return parse_card_bytes(card_path.read_bytes(), filename=card_path.name)


def parse_card_bytes(data: bytes, filename: str = "") -> CharacterCard:
    if _looks_like_json(data, filename):
        return _normalize_card(json.loads(data.decode("utf-8-sig")))

    if data.startswith(PNG_SIGNATURE):
        raw = _extract_png_card_json(data)
        return _normalize_card(raw)

    try:
        return _normalize_card(json.loads(data.decode("utf-8-sig")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("unsupported character card format") from exc


def _looks_like_json(data: bytes, filename: str) -> bool:
    if filename.lower().endswith(".json"):
        return True
    return data.lstrip().startswith((b"{", b"["))


def _extract_png_card_json(data: bytes) -> dict[str, Any]:
    offset = len(PNG_SIGNATURE)
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk_data_start = offset + 8
        chunk_data_end = chunk_data_start + length
        crc_end = chunk_data_end + 4
        if crc_end > len(data):
            break

        chunk_data = data[chunk_data_start:chunk_data_end]
        if chunk_type in {b"tEXt", b"zTXt", b"iTXt"}:
            found = _read_text_chunk(chunk_type, chunk_data)
            if found is not None:
                keyword, text = found
                if keyword in {"chara", "ccv3"}:
                    return _decode_card_payload(text)

        offset = crc_end

    raise ValueError("PNG does not contain a SillyTavern character card")


def _read_text_chunk(chunk_type: bytes, data: bytes) -> tuple[str, str] | None:
    if chunk_type == b"tEXt":
        keyword, sep, text = data.partition(b"\x00")
        if not sep:
            return None
        return _decode_png_text(keyword), _decode_png_text(text)

    if chunk_type == b"zTXt":
        keyword, sep, rest = data.partition(b"\x00")
        if not sep or len(rest) < 2:
            return None
        method = rest[0]
        if method != 0:
            return None
        return _decode_png_text(keyword), zlib.decompress(rest[1:]).decode("utf-8")

    keyword, sep, rest = data.partition(b"\x00")
    if not sep or len(rest) < 2:
        return None
    compression_flag = rest[0]
    compression_method = rest[1]
    if compression_method != 0:
        return None
    rest = rest[2:]
    _language_tag, sep, rest = rest.partition(b"\x00")
    if not sep:
        return None
    _translated_keyword, sep, text = rest.partition(b"\x00")
    if not sep:
        return None
    if compression_flag:
        text = zlib.decompress(text)
    return _decode_png_text(keyword), text.decode("utf-8")


def _decode_png_text(data: bytes) -> str:
    try:
        return data.decode("latin-1")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def _decode_card_payload(text: str) -> dict[str, Any]:
    try:
        decoded = base64.b64decode(text, validate=False)
        parsed = json.loads(decoded.decode("utf-8-sig"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("invalid embedded character card payload") from exc
    if not isinstance(parsed, dict):
        raise ValueError("embedded character card payload is not a JSON object")
    return parsed


def _normalize_card(raw: Any) -> CharacterCard:
    if not isinstance(raw, dict):
        raise ValueError("character card JSON must be an object")

    body = raw.get("data") if raw.get("spec") in {"chara_card_v2", "chara_card_v3"} else raw
    if not isinstance(body, dict):
        body = {}

    book = body.get("character_book")
    entries = book.get("entries", []) if isinstance(book, dict) else []
    if not isinstance(entries, list):
        entries = []

    tags = body.get("tags", [])
    if not isinstance(tags, list):
        tags = []

    return CharacterCard(
        name=_as_text(body.get("name")),
        description=_as_text(body.get("description")),
        personality=_as_text(body.get("personality")),
        scenario=_as_text(body.get("scenario")),
        first_mes=_as_text(body.get("first_mes")),
        mes_example=_as_text(body.get("mes_example")),
        creator_notes=_as_text(body.get("creator_notes") or body.get("creator_notes_multilingual")),
        tags=[_as_text(tag) for tag in tags if _as_text(tag)],
        character_book=[entry for entry in entries if isinstance(entry, dict)],
        raw=raw,
    )


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)
