"""Pinned studio→engine round-trip: the three fixture files were produced by the REAL
loreweaver-studio exporters (`exportSillyTavernCard` release flavor, `embedCardIntoPng`,
`exportNativeBundle`) from a neutral synthetic project ("回廊公寓"). They pin the
cross-repo contract in CI: if either side drifts — the studio's emitted shape or the
engine's parsers — one of these breaks. Regenerate with the studio's exporters, never
by hand (`bun scripts/gen_studio_export_fixture.ts` in the studio repo; the studio CI's
roundtrip job byte-diffs a fresh regeneration against this file).

`studio_export.lorecard.json` is real lorecard format-v1 exporter output (it replaced
the hand-migrated placeholder that held the v1 contract ahead of the studio's v1
exporter)."""

from __future__ import annotations

import struct
from pathlib import Path

from core.card_split import detect_world_payloads
from core.charcard import parse_card_bytes, parse_card_file
from core.lorecard import parse_lorecard_bytes
from core.mvu_compat import is_initvar_entry, parse_initvar

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def _titles(card) -> list[str]:
    return [str(entry.get("comment") or entry.get("name") or "") for entry in card.character_book]


def test_studio_png_release_card_parses_and_splits_world_kind():
    card = parse_card_file(FIXTURES / "studio_export.png")
    assert card.name == "回廊公寓"
    titles = _titles(card)
    assert "[InitVar]" in titles and "变量更新规则" in titles and "管理员的秘密" in titles

    initvar = next(e for e in card.character_book if is_initvar_entry(str(e.get("comment") or "")))
    tree = parse_initvar(initvar.get("content") or "")
    assert tree is not None
    assert tree["世界"]["公寓"]["五层可见"] is False  # YAML-form InitVar, nested CJK intact

    conditioned = next(e for e in card.character_book if (e.get("comment") or "") == "住户名册")
    assert str(conditioned.get("content", "")).startswith("@@if 世界.日 >= 2")

    payloads = detect_world_payloads(card)
    assert payloads.initvar_entries == 1
    assert payloads.any  # machinery present → world-kind card by construction


def test_studio_png_carries_exactly_one_chara_and_one_ccv3_chunk():
    data = (FIXTURES / "studio_export.png").read_bytes()
    keywords = []
    pos = 8
    while pos + 8 <= len(data):
        length, chunk_type = struct.unpack(">I4s", data[pos : pos + 8])
        if chunk_type in (b"tEXt", b"zTXt", b"iTXt"):
            keywords.append(data[pos + 8 : pos + 8 + length].split(b"\x00", 1)[0].decode("latin1"))
        pos += 12 + length
    assert sorted(keywords) == ["ccv3", "chara"]


def test_studio_st_json_release_flavor_parses_identically():
    card = parse_card_bytes((FIXTURES / "studio_export.st.json").read_bytes(), "studio_export.st.json")
    assert card.name == "回廊公寓"
    assert "管理员的秘密" in _titles(card)


def test_studio_native_bundle_parses_with_typed_specs_and_secrecy():
    lorecard = parse_lorecard_bytes(
        (FIXTURES / "studio_export.lorecard.json").read_bytes(), "studio_export.lorecard.json"
    )
    assert lorecard.card.name == "回廊公寓"
    specs = {spec["id"]: spec for spec in lorecard.variable_specs}
    assert "理智" in specs and specs["理智"]["kind"] == "number"
    secret = next(e for e in lorecard.card.character_book if (e.get("comment") or "") == "管理员的秘密")
    assert secret.get("secret") is True
    conditioned = next(e for e in lorecard.card.character_book if (e.get("comment") or "") == "住户名册")
    assert str(conditioned.get("content", "")).startswith("@@if")
