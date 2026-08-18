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


def test_the_manifest_is_parsed_once_per_file_not_once_per_listing(tmp_path, monkeypatch) -> None:
    """`list_pack_cards` is player-open, unthrottled by a turn and answered on the event
    loop; a manifest parse (and, for a dev mount, a read + classify of EVERY card) per
    call let one client stall every room by looping the frame. The classification is
    memoized on each file's identity, so a listing after the first is a stat and a walk."""
    import gateway.panels as panels_module

    data_dir = _installed_pack(tmp_path)
    calls: list[str] = []
    real = panels_module.parse_manifest_text

    def counting(text: str, **kwargs):
        calls.append(text)
        return real(text, **kwargs)

    monkeypatch.setattr(panels_module, "parse_manifest_text", counting)
    first = installed_card_entries(data_dir)
    second = installed_card_entries(data_dir)
    assert first == second
    assert len(calls) == 1

    # A saved manifest (new identity) is read again — an author's edit still lands.
    manifest = data_dir / "packs" / "mistwharf@1.0.0" / "pack.yaml"
    manifest.write_text(_MANIFEST.replace("kind: world", "kind: character"), encoding="utf-8")
    import os

    stat = manifest.stat()
    os.utime(manifest, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    entries = {entry["name"]: entry["kind"] for entry in installed_card_entries(data_dir)}
    assert entries["customs"] == "character"
    assert len(calls) == 2


def test_a_dev_mount_s_cards_resolve_for_import_by_the_ref_the_listing_shows(tmp_path) -> None:
    """The listing offered a dev mount's cards under `<packId>/cards/<file>`, but
    `.import` resolved refs only against `data_dir/packs/` — rows a click could not
    take. `resolve_pack_ref` answers for a dev home too, confined the same way."""
    from gateway.panels import _DEV_HOMES, resolve_pack_ref  # noqa: PLC0415 — the registry IS the fixture

    src = tmp_path / "src"
    (src / "cards").mkdir(parents=True)
    (src / "cards" / "plain.json").write_text(json.dumps({"name": "Plain"}), encoding="utf-8")
    (tmp_path / "outside.json").write_text("{}", encoding="utf-8")
    data_dir = tmp_path / "data"
    _DEV_HOMES["draft"] = src
    try:
        assert resolve_pack_ref(data_dir, "draft/cards/plain.json") == (src / "cards" / "plain.json").resolve()
        assert resolve_pack_ref(data_dir, "draft/../outside.json") is None
        assert resolve_pack_ref(data_dir, "draft/cards") is None  # a dir, not a card
        assert resolve_pack_ref(data_dir, "nope/cards/plain.json") is None
    finally:
        _DEV_HOMES.pop("draft", None)
    # With no dev home the same ref falls through to the installed-pack lookup.
    installed = _installed_pack(tmp_path)
    assert resolve_pack_ref(installed, "mistwharf/cards/pilot.json") is not None
