"""`pack_cards` entries carry the card's 拆卡 kind (protocol 2.3).

Without it every picker hard-coded `.import <ref> pc`: a keeper clicking the module's
own world card got a player character named after the module and a name collision.
The classification already existed in the built manifest (`core.pack.PackCard.kind`,
stamped from real payload detection); it simply never reached the wire.
"""

from __future__ import annotations

import json
from pathlib import Path

from gateway.panels import installed_card_entries

_MANIFEST = """\
manifest_version: 2
id: mistwharf
version: 1.0.0
name: {en: Mistwharf}
description: {en: test}
authors: [ada]
license: MIT
engine: {}
contents:
  cards:
    - {path: cards/customs.json, kind: world}
    - {path: cards/pilot.json, kind: character}
files:
  - {path: cards/customs.json, sha256: 912d28fedb280489e596cd0f0679836918e1e620178e395a643b0b91c82af282, size: 29}
  - {path: cards/pilot.json, sha256: 1abb6346ad936135bae5bb220993f1f6ef661b1ceedf8565c9b5729336f175c7, size: 17}
trust: {cards: 2}
"""


def _installed_pack(tmp_path: Path) -> Path:
    home = tmp_path / "data" / "packs" / "mistwharf@1.0.0"
    (home / "cards").mkdir(parents=True)
    (home / "pack.yaml").write_text(_MANIFEST, encoding="utf-8")
    (home / "cards" / "customs.json").write_text(json.dumps({"name": "Mistwharf Customs"}), encoding="utf-8")
    (home / "cards" / "pilot.json").write_text(json.dumps({"name": "Pilot"}), encoding="utf-8")
    return tmp_path / "data"


def test_each_listed_card_reports_the_manifest_s_kind(tmp_path) -> None:
    entries = installed_card_entries(_installed_pack(tmp_path))

    by_name = {entry["name"]: entry for entry in entries}
    assert by_name["customs"]["kind"] == "world"
    assert by_name["pilot"]["kind"] == "character"
    # The ref is still exactly what `.import` accepts — the verb is what `kind` decides.
    assert by_name["customs"]["ref"] == "mistwharf/cards/customs.json"


def test_a_pack_with_no_readable_manifest_falls_back_to_character(tmp_path) -> None:
    """The pre-2.3 assumption is the safe default: an unreadable manifest must not
    make the picker refuse every card, and `character` is the verb it already sent."""
    data_dir = tmp_path / "data"
    home = data_dir / "packs" / "broken@1.0.0"
    (home / "cards").mkdir(parents=True)
    (home / "pack.yaml").write_text("id: [broken", encoding="utf-8")
    (home / "cards" / "pilot.json").write_text(json.dumps({"name": "Pilot"}), encoding="utf-8")

    entries = installed_card_entries(data_dir)

    assert [entry["kind"] for entry in entries] == ["character"]


def test_a_dev_mount_classifies_its_cards_from_the_payload(tmp_path) -> None:
    """A source tree has no stamped kind — detection runs at build time — so the
    listing runs the same detector `--pack` does. An author's dev room must not see
    every card of theirs mislabelled as a character."""
    from gateway.panels import _DEV_HOMES  # noqa: PLC0415 — the registry IS the fixture

    src = tmp_path / "src"
    (src / "cards").mkdir(parents=True)
    (src / "cards" / "plain.json").write_text(
        json.dumps({"name": "Plain", "description": "a person"}), encoding="utf-8"
    )
    # Machinery (an [InitVar] declaration entry) is what makes a card a world card.
    (src / "cards" / "machinery.json").write_text(
        json.dumps(
            {
                "name": "Machinery",
                "description": "a module",
                "character_book": {
                    "entries": [{"keys": ["[InitVar]"], "content": "day: 1", "comment": "[InitVar]"}]
                },
            }
        ),
        encoding="utf-8",
    )
    (src / "pack.yaml").write_text(
        "manifest_version: 2\nid: draft\nversion: 0.1.0\nname: {en: Draft}\n"
        "description: {en: test}\nauthors: [ada]\nlicense: MIT\nengine: {}\n"
        "contents: {cards: [cards/plain.json, cards/machinery.json]}\n",
        encoding="utf-8",
    )
    _DEV_HOMES["draft"] = src
    try:
        entries = {entry["name"]: entry["kind"] for entry in installed_card_entries(tmp_path / "data")}
    finally:
        _DEV_HOMES.pop("draft", None)

    assert entries["plain"] == "character"
    assert entries["machinery"] == "world"
