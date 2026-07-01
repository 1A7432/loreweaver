from __future__ import annotations

import base64
import json
import struct
import zlib
from types import SimpleNamespace

import pytest

from core.char_from_persona import build_sheet_from_persona
from core.character_manager import CharacterManager
from core.charcard import parse_card_bytes
from core.dice_engine import seed_dice
from infra.llm import FakeLLM, assistant_text
from infra.store import Store


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    head = struct.pack(">I", len(payload)) + kind + payload
    crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return head + struct.pack(">I", crc)


def _v2_png_card() -> bytes:
    raw = {
        "spec": "chara_card_v2",
        "data": {
            "name": "Ada",
            "description": "A scholar of forbidden lore",
            "character_book": {"entries": [{"keys": ["arkham"], "content": "A cursed town"}]},
        },
    }
    encoded = base64.b64encode(json.dumps(raw).encode("utf-8"))
    text = b"chara\x00" + encoded
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"tEXt", text) + _png_chunk(b"IEND", b"")


def test_parse_sillytavern_v2_png_and_v1_json():
    card = parse_card_bytes(_v2_png_card(), filename="ada.png")

    assert card.name == "Ada"
    assert card.description == "A scholar of forbidden lore"
    assert len(card.character_book) == 1
    assert card.character_book[0]["keys"] == ["arkham"]

    v1 = parse_card_bytes(json.dumps({"name": "Bert", "description": "A valet"}).encode(), filename="bert.json")
    assert v1.name == "Bert"
    assert v1.description == "A valet"


@pytest.mark.asyncio
async def test_build_sheet_from_persona_coc7_is_rule_legal_and_biased():
    seed_dice(2026)
    manager = CharacterManager(Store(":memory:"))
    llm = FakeLLM(
        script=[
            assistant_text(
                json.dumps(
                    {
                        "occupation": "Professor",
                        "attribute_emphasis": ["INT", "EDU"],
                        "signature_skills": ["Library Use", "Occult"],
                        "backstory": "A professor chasing forbidden marginalia.",
                    }
                )
            )
        ]
    )
    services = SimpleNamespace(characters=manager, llm=llm)
    card = parse_card_bytes(
        json.dumps({"name": "Ada", "description": "A scholar of forbidden lore"}).encode(),
        filename="ada.json",
    )

    sheet = await build_sheet_from_persona(services, card, "coc7")

    assert sheet.name == "Ada"
    assert sheet.system == "CoC"
    assert sheet.occupation == "Professor"

    rolled_attrs = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"]
    for attr in rolled_attrs:
        low = 40 if attr in {"SIZ", "INT", "EDU"} else 15
        assert low <= sheet.attributes[attr] <= 90

    ranked = sorted((sheet.attributes[attr], attr) for attr in rolled_attrs)
    top_attrs = {attr for _value, attr in ranked[-4:]}
    assert {"INT", "EDU"}.issubset(top_attrs)
    assert sheet.skills["图书馆"] >= 60
    assert sheet.skills["神秘学"] >= 60
    assert sheet.attributes["SAN"] == sheet.attributes["POW"]
    assert sheet.attributes["IDEA"] == sheet.attributes["INT"]
