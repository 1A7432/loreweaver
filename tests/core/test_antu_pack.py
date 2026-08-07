"""Guard tests for the flagship module pack content/antu (《安土》).

Beyond "the pack builds" (which runs every real engine parser), these tests
pin the module's two structural red lines as CI (全纲 §12 评测计划):

1. Sentinel zero-leak — the five keeper-ciphertext words (井髓 / 勘髓录 /
   拔营颂 / 圣街七签 / 九宫营图) may appear ONLY in worldbook entries marked
   secret, never in player-grade surfaces (public entries, opening, pregens,
   lorebooks, panels). Each sentinel has an earned channel; the pack must not
   smuggle it across projection.
2. Displacement blacklist — the 写古说今 audit (全纲 §11): no modern
   administrative vocabulary anywhere in the module's fiction-facing text.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.lorecard import parse_lorecard_bytes
from core.pack import build_pack

SRC = Path(__file__).resolve().parents[2] / "content" / "antu"

SENTINELS = ["井髓", "勘髓录", "拔营颂", "圣街七签", "九宫营图"]
BLACKLIST = ["议会", "民主", "共和", "选举", "政策", "改革", "开放"]

pytestmark = pytest.mark.skipif(not SRC.is_dir(), reason="flagship module source not checked out")


def _card() -> dict:
    return json.loads((SRC / "cards/antu.lorecard.json").read_text(encoding="utf-8"))


def _player_visible_texts(card: dict) -> list[str]:
    """Every player-grade text surface in the pack."""
    texts: list[str] = [card.get("description", ""), card.get("scenario", "")]
    texts.append(card.get("opening", ""))
    texts.extend(card.get("alternate_openings", []))
    for pg in card.get("pregens", []):
        texts.extend([pg.get("name", ""), pg.get("concept", ""), pg.get("notes", "")])
    for entry in card.get("worldbook", []):
        if not entry.get("secret"):
            texts.extend([entry.get("title", ""), entry.get("content", "")])
    for lb in (SRC / "lorebooks").glob("*.json"):
        for e in json.loads(lb.read_text(encoding="utf-8"))["entries"]:
            texts.append(e["content"])
    return texts


def test_pack_builds(tmp_path):
    # build_pack runs the real manifest/rulepack/card/panel/skill parsers,
    # including extends: resolution against the bundled coc7 base.
    built = build_pack(SRC, tmp_path / "antu.lwpack")
    assert built.manifest.id == "antu"


def test_lorecard_parses():
    card = parse_lorecard_bytes((SRC / "cards/antu.lorecard.json").read_bytes(), "antu.lorecard.json")
    assert card.card.name == "安土"
    assert card.variable_specs and card.pregens


def test_sentinels_only_in_secret_entries():
    card = _card()
    secret_blob = ""
    for entry in card.get("worldbook", []):
        blob = entry.get("title", "") + entry.get("content", "")
        if entry.get("secret"):
            secret_blob += blob
        else:
            for word in SENTINELS:
                assert word not in blob, f"sentinel {word!r} leaked into public entry {entry.get('id')}"
    # Each sentinel must actually live behind the keeper wall (no dead clue).
    for word in SENTINELS:
        assert word in secret_blob, f"sentinel {word!r} missing from keeper entries"
    for text in _player_visible_texts(card):
        for word in SENTINELS:
            assert word not in text, f"sentinel {word!r} leaked into a player-visible surface"


def test_displacement_blacklist():
    card = _card()
    texts = _player_visible_texts(card)
    texts.extend(
        e.get("content", "") for e in card.get("worldbook", []) if e.get("secret")
    )
    for text in texts:
        for word in BLACKLIST:
            assert word not in text, f"blacklisted modern term {word!r} in module text"
