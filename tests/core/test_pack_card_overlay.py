"""M26 §5.5/§10.8/§10.14 — a pack that ADOPTS a foreign card ships its annotations.

The overlay is data, not machinery: it rides the same build/verify rails as every other
declared file, it is disclosed on the trust card, and it cannot turn a character card into
a world card.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from core.pack import (
    MANIFEST_NAME,
    PackError,
    build_pack,
    inspect_pack,
    install_pack,
    installed_pack_card_overlay,
)

CHARACTER_CARD = json.dumps({"spec": "chara_card_v2", "data": {"name": "Ada", "description": "scholar"}})

WORLD_CARD = json.dumps(
    {
        "spec": "chara_card_v2",
        "data": {
            "name": "残堇",
            "description": "The estate itself.",
            "character_book": {
                "entries": [
                    {"comment": "[InitVar]", "content": '{"配置": {"难度": "标准"}}'},
                    {"comment": "难度·轻松", "content": "线索自己走到面前。", "enabled": False, "keys": []},
                    {"comment": "难度·残酷", "content": "线索会骗人。", "enabled": False, "keys": []},
                    {"comment": "回复模板", "content": "先写环境。", "enabled": False, "keys": ["模板"]},
                ]
            },
        },
    }
)

OVERLAY_YAML = """\
format: loreweaver.lore-overlay/1
entries:
  难度·轻松: {condition: '配置.难度 == "轻松"'}
  难度·残酷: {condition: '配置.难度 == "残酷"'}
  回复模板: {enabled: false}
setup:
  - {path: 配置.难度, options: [轻松, 标准, 残酷], labels: {en: Difficulty, zh: 难度}}
expose: [配置]
"""


def _source(root: Path, *, cards_yaml: str, overlay: str = OVERLAY_YAML) -> Path:
    src = root / "overlay-src"
    (src / "cards").mkdir(parents=True)
    (src / "cards/keeper.json").write_text(CHARACTER_CARD, encoding="utf-8")
    (src / "cards/world.json").write_text(WORLD_CARD, encoding="utf-8")
    (src / "cards/world.overlay.yaml").write_text(overlay, encoding="utf-8")
    (src / MANIFEST_NAME).write_text(
        "id: overlaypack\nversion: 1.0.0\nname: Overlay Pack\ndescription: test\n"
        "authors: [ada]\nlicense: MIT\nengine: {}\n"
        f"contents:\n  cards:\n{cards_yaml}",
        encoding="utf-8",
    )
    return src


_WITH_OVERLAY = "    - path: cards/world.json\n      overlay: cards/world.overlay.yaml\n"


def _install(pack_path: Path, root: Path):
    return install_pack(
        pack_path,
        packs_dir=root / "data/packs",
        skills_dir=root / "data/skills",
        rulepacks_dir=root / "data/rulepacks",
        presets_dir=root / "data/presets",
        current_protocol="1.7",
        current_server="1.0.0",
    )


def test_a_declared_overlay_ships_and_round_trips(tmp_path: Path):
    src = _source(tmp_path, cards_yaml=_WITH_OVERLAY)

    built = build_pack(src, tmp_path / "overlay.lwpack")

    entry = next(card for card in built.manifest.card_entries if card.path == "cards/world.json")
    assert entry.overlay == "cards/world.overlay.yaml"
    assert built.manifest.trust is not None and built.manifest.trust.overlays == 1
    with zipfile.ZipFile(built.path) as archive:
        assert "cards/world.overlay.yaml" in archive.namelist()
    # The built manifest carries it, so a re-read sees the same declaration.
    reread = inspect_pack(built.path)
    assert reread.card_entries[0].overlay == "cards/world.overlay.yaml"
    # And the build stays byte-deterministic with the new mapping key.
    assert build_pack(src, tmp_path / "overlay2.lwpack").sha256 == built.sha256


def test_an_overlay_does_not_make_a_character_card_a_world_card(tmp_path: Path):
    """Annotations are not machinery: the kind still comes from the real payload."""
    src = _source(
        tmp_path,
        cards_yaml="    - path: cards/keeper.json\n      overlay: cards/world.overlay.yaml\n",
    )

    built = build_pack(src, tmp_path / "annotated.lwpack")

    assert built.manifest.card_kind("cards/keeper.json") == "character"
    assert built.manifest.trust is not None
    assert built.manifest.trust.world_cards == 0 and built.manifest.trust.overlays == 1


@pytest.mark.parametrize(
    "overlay",
    [
        "format: loreweaver.lore-overlay/2\nentries: {}\n",
        "format: loreweaver.lore-overlay/1\nentries:\n  A: {condition: 'Object.keys(x)'}\n",
        "format: loreweaver.lore-overlay/1\nentries:\n  A: {condition: '" + "x" * 600 + " == 1'}\n",
        "format: loreweaver.lore-overlay/1\nsetup:\n  - {path: p, options: ["
        + ", ".join(str(index) for index in range(21))
        + "]}\n",
    ],
)
def test_a_structurally_bad_overlay_fails_the_build(tmp_path: Path, overlay: str):
    src = _source(tmp_path, cards_yaml=_WITH_OVERLAY, overlay=overlay)

    with pytest.raises(PackError):
        build_pack(src, tmp_path / "bad.lwpack")


def test_an_unknown_title_is_a_build_WARNING_not_a_failure(tmp_path: Path):
    """Cards get revised; refusing the build for a renamed entry would make shipping an
    overlay a liability."""
    src = _source(
        tmp_path,
        cards_yaml=_WITH_OVERLAY,
        overlay="format: loreweaver.lore-overlay/1\nentries:\n  没有这条: {enabled: true}\n",
    )

    built = build_pack(src, tmp_path / "warned.lwpack")

    assert len(built.warnings) == 1 and "没有这条" in built.warnings[0]


def test_install_refuses_an_archive_whose_overlay_is_missing(tmp_path: Path):
    src = _source(tmp_path, cards_yaml=_WITH_OVERLAY)
    built = build_pack(src, tmp_path / "overlay.lwpack")
    tampered = tmp_path / "tampered.lwpack"
    with zipfile.ZipFile(built.path) as source, zipfile.ZipFile(tampered, "w") as sink:
        for name in source.namelist():
            if name == "cards/world.overlay.yaml":
                continue
            sink.writestr(name, source.read(name))

    with pytest.raises(PackError):
        _install(tampered, tmp_path)


def test_installed_pack_card_overlay_finds_it_only_inside_the_pack_home(tmp_path: Path):
    src = _source(tmp_path, cards_yaml=_WITH_OVERLAY + "    - cards/keeper.json\n")
    built = build_pack(src, tmp_path / "overlay.lwpack")
    report = _install(built.path, tmp_path)
    home = report.pack_dir
    assert home is not None

    found = installed_pack_card_overlay(tmp_path / "data", home / "cards/world.json")
    assert found is not None and found.read_text(encoding="utf-8").startswith("format:")

    # A card in the same pack that declares no overlay gets none...
    assert installed_pack_card_overlay(tmp_path / "data", home / "cards/keeper.json") is None
    # ...and neither does a copy of the same card outside any pack home (an attachment).
    loose = tmp_path / "loose.json"
    loose.write_text(WORLD_CARD, encoding="utf-8")
    assert installed_pack_card_overlay(tmp_path / "data", loose) is None
