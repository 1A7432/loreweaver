"""Tests for core.pack — the `.lwpack` format: manifest validation, deterministic
builds, archive-safety red lines (zip-slip / symlink / integrity), and the
verify-first install that lands skills/rulepacks into the existing discovery."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

import core.rulepacks as rulepacks_module
import core.skills as skills_module
from core.pack import (
    MANIFEST_NAME,
    PackError,
    build_pack,
    inspect_pack,
    install_pack,
    parse_manifest_text,
    version_at_least,
)
from core.rulepacks import load_rulepack
from core.skills import load_skill

SKILL_MD = """---
name: Omen Engine
description: Speaks in omens.
---
Answer every question with an omen.
"""

HOOKS_JS = "on('turn_start', () => narrate('the bells toll'));"
RULEPACK_YAML = "names: [pulp]\ndefaults:\n  力量: 7\n"
CARD_JSON = json.dumps({"spec": "chara_card_v2", "data": {"name": "Ada", "description": "scholar"}})
LOREBOOK_JSON = json.dumps({"entries": [{"key": ["lighthouse"], "content": "It burns green."}]})

MANIFEST = """\
id: blackmoor
version: 1.2.0
name:
  en: Blackmoor Lighthouse
  zh: 黑沼灯塔
description: A haunted-lighthouse mystery.
authors: [ada]
license: MIT
engine:
  protocol: "1.6"
contents:
  skills: [skills/omen-engine]
  rulepacks: [rulepacks/pulp.yaml]
  cards: [cards/keeper.json]
  lorebooks: [lorebooks/manor.json]
assets:
  - path: assets/theme.mp3
    title: Theme
"""


def _write_source(root: Path) -> Path:
    src = root / "pack-src"
    (src / "skills/omen-engine").mkdir(parents=True)
    (src / "skills/omen-engine/SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (src / "skills/omen-engine/hooks.js").write_text(HOOKS_JS, encoding="utf-8")
    (src / "rulepacks").mkdir()
    (src / "rulepacks/pulp.yaml").write_text(RULEPACK_YAML, encoding="utf-8")
    (src / "cards").mkdir()
    (src / "cards/keeper.json").write_text(CARD_JSON, encoding="utf-8")
    (src / "lorebooks").mkdir()
    (src / "lorebooks/manor.json").write_text(LOREBOOK_JSON, encoding="utf-8")
    (src / "assets").mkdir()
    (src / "assets/theme.mp3").write_bytes(b"ID3" + bytes(64))
    (src / MANIFEST_NAME).write_text(MANIFEST, encoding="utf-8")
    return src


def _install(pack_path: Path, root: Path, **overrides):
    kwargs: dict = dict(
        packs_dir=root / "data/packs",
        skills_dir=root / "data/skills",
        rulepacks_dir=root / "data/rulepacks",
        current_protocol="1.7",
        current_server="1.0.0",
    )
    kwargs.update(overrides)
    return install_pack(pack_path, **kwargs)


def _rewrite_pack(src: Path, dst: Path, mutate) -> Path:
    """Re-write a built pack with `mutate(entries)` applied — the tamper harness."""
    with zipfile.ZipFile(src) as zin:
        entries = [(info, zin.read(info.filename)) for info in zin.infolist()]
    with zipfile.ZipFile(dst, "w") as zout:
        for info, data in mutate(entries):
            zout.writestr(info, data)
    return dst


# --- versions ---------------------------------------------------------------


def test_version_at_least_lenient_current_strict_minimum():
    assert version_at_least("1.7", "1.6")
    assert version_at_least("1.7.0", "1.7")
    assert not version_at_least("1.6", "1.7")
    # The server's own version strings carry dev/local suffixes; the leading dotted
    # prefix is what counts.
    assert version_at_least("0.5.1.dev2+gabcdef0", "0.5.0")
    assert not version_at_least("0.5.1.dev2+gabcdef0", "0.6")
    with pytest.raises(PackError):
        version_at_least("1.0", "not-a-version")


# --- manifest validation ----------------------------------------------------


def test_parse_manifest_rejects_bad_shapes():
    good = MANIFEST
    for mutation, needle in (
        (good.replace("id: blackmoor", "id: Black_Moor"), "slug"),
        (good.replace("version: 1.2.0", "version: 1.2"), "semver"),
        (good.replace("license: MIT", ""), "license"),
        (good.replace("authors: [ada]", "authors: ada"), "authors"),
        (good.replace('protocol: "1.6"', 'flux-capacitor: "1.6"'), "engine"),
        (good + "trust:\n  skills: 99\n", "hand-written"),
        (
            good.replace(
                "cards: [cards/keeper.json]",
                "cards: [cards/keeper.json, cards/keeper.json]",
            ),
            "duplicate",
        ),
        (good.replace("cards: [cards/keeper.json]", "cards: [../escape.json]"), "unsafe"),
    ):
        with pytest.raises(PackError, match=needle):
            parse_manifest_text(mutation, expect_trust=False)


def test_parse_manifest_caps_content_list_length():
    entries = ", ".join(f"rulepacks/r{index}.yaml" for index in range(65))
    text = MANIFEST.replace("rulepacks: [rulepacks/pulp.yaml]", f"rulepacks: [{entries}]")
    with pytest.raises(PackError, match="too many"):
        parse_manifest_text(text, expect_trust=False)


# --- build ------------------------------------------------------------------


def test_build_is_deterministic_and_generates_trust(tmp_path: Path):
    src = _write_source(tmp_path)
    first = build_pack(src, tmp_path / "a.lwpack")
    second = build_pack(src, tmp_path / "b.lwpack")
    assert first.path.read_bytes() == second.path.read_bytes()
    assert first.sha256 == second.sha256

    trust = first.manifest.trust
    assert trust is not None
    assert (trust.skills, trust.rulepacks, trust.cards, trust.lorebooks, trust.assets) == (1, 1, 1, 1, 1)
    assert trust.has_hooks is True
    assert trust.has_ejs is False
    assert trust.asset_bytes == 67

    asset = first.manifest.assets[0]
    assert asset.mime == "audio/mpeg"  # guessed from the extension
    assert asset.size == 67 and len(asset.sha256) == 64

    # The archive-side manifest round-trips with the generated trust block intact.
    assert inspect_pack(first.path).trust == trust


def test_build_rejects_invalid_contents(tmp_path: Path):
    src = _write_source(tmp_path)
    (src / "skills/omen-engine/extra.txt").write_text("smuggled", encoding="utf-8")
    with pytest.raises(PackError, match="unexpected files"):
        build_pack(src, tmp_path / "x.lwpack")
    (src / "skills/omen-engine/extra.txt").unlink()

    (src / "skills/omen-engine/SKILL.md").write_text("no frontmatter here", encoding="utf-8")
    with pytest.raises(PackError, match="invalid SKILL.md"):
        build_pack(src, tmp_path / "x.lwpack")
    (src / "skills/omen-engine/SKILL.md").write_text(SKILL_MD, encoding="utf-8")

    manifest = MANIFEST.replace(
        "  - path: assets/theme.mp3",
        f"  - path: assets/theme.mp3\n    sha256: {'0' * 64}",
    )
    (src / MANIFEST_NAME).write_text(manifest, encoding="utf-8")
    with pytest.raises(PackError, match="sha256 does not match"):
        build_pack(src, tmp_path / "x.lwpack")


# --- archive safety (red lines) ---------------------------------------------


def _attack_zip(path: Path, entry_name: str, *, symlink: bool = False) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        info = zipfile.ZipInfo(entry_name)
        if symlink:
            info.external_attr = 0o120777 << 16
        archive.writestr(info, "../../owned")
    return path


def test_zip_slip_and_symlink_entries_are_rejected(tmp_path: Path):
    for index, (name, symlink) in enumerate(
        (
            ("../evil.txt", False),  # classic traversal
            ("/abs/evil.txt", False),  # absolute path
            ("a\\..\\b.txt", False),  # backslash traversal
            ("skills/../../evil", False),  # nested traversal
            ("skills/link", True),  # symlink entry
        )
    ):
        attack = _attack_zip(tmp_path / f"attack-{index}.lwpack", name, symlink=symlink)
        with pytest.raises(PackError):
            inspect_pack(attack)
        with pytest.raises(PackError):
            _install(attack, tmp_path / f"victim-{index}")
        assert not (tmp_path / f"victim-{index}" / "data/skills").exists()


def test_install_rejects_tampered_asset_before_writing_anything(tmp_path: Path):
    src = _write_source(tmp_path)
    built = build_pack(src, tmp_path / "good.lwpack")

    def corrupt(entries):
        return [
            (info, b"X" * len(data) if info.filename == "assets/theme.mp3" else data)
            for info, data in entries
        ]

    tampered = _rewrite_pack(built.path, tmp_path / "evil.lwpack", corrupt)
    with pytest.raises(PackError, match="sha256 does not match"):
        _install(tampered, tmp_path)
    # Verify-first: the failed install left no trace in any target dir.
    assert not (tmp_path / "data/skills").exists()
    assert not (tmp_path / "data/rulepacks").exists()
    assert not list((tmp_path / "data/packs").glob("blackmoor*"))


def test_install_rejects_undeclared_archive_entries(tmp_path: Path):
    src = _write_source(tmp_path)
    built = build_pack(src, tmp_path / "good.lwpack")

    def smuggle(entries):
        info = zipfile.ZipInfo("assets/undeclared.bin")
        return [*entries, (info, b"ride-along")]

    tampered = _rewrite_pack(built.path, tmp_path / "smuggled.lwpack", smuggle)
    with pytest.raises(PackError, match="undeclared"):
        _install(tampered, tmp_path)


def test_install_rejects_unmet_engine_minimums(tmp_path: Path):
    src = _write_source(tmp_path)
    (src / MANIFEST_NAME).write_text(
        MANIFEST.replace('protocol: "1.6"', 'protocol: "9.9"'), encoding="utf-8"
    )
    built = build_pack(src, tmp_path / "future.lwpack")
    with pytest.raises(PackError, match="protocol"):
        _install(built.path, tmp_path)

    (src / MANIFEST_NAME).write_text(
        MANIFEST.replace('protocol: "1.6"', 'server: "999.0.0"'), encoding="utf-8"
    )
    built = build_pack(src, tmp_path / "future-server.lwpack")
    with pytest.raises(PackError, match="server"):
        _install(built.path, tmp_path)


# --- install + discovery ----------------------------------------------------


def test_pack_install_lands_in_existing_discovery(tmp_path: Path):
    src = _write_source(tmp_path)
    built = build_pack(src, tmp_path / "out.lwpack")
    report = _install(built.path, tmp_path)

    assert report.skills == ["omen-engine"]
    assert report.rulepacks == ["pulp"]
    assert report.assets == 1 and report.asset_bytes == 67
    assert report.pack_dir == tmp_path / "data/packs/blackmoor@1.2.0"
    for landed in ("cards/keeper.json", "lorebooks/manor.json", "assets/theme.mp3", MANIFEST_NAME):
        assert (report.pack_dir / landed).is_file()
    assert (tmp_path / "data/skills/omen-engine/hooks.js").is_file()

    original_skill_dir = skills_module._USER_SKILL_DIR
    original_rulepack_dir = rulepacks_module._USER_RULEPACK_DIR
    skills_module._USER_SKILL_DIR = tmp_path / "data/skills"
    rulepacks_module._USER_RULEPACK_DIR = tmp_path / "data/rulepacks"
    skills_module._discover_registry.cache_clear()
    rulepacks_module._discover_registry.cache_clear()
    rulepacks_module._alias_resolver.cache_clear()
    try:
        skill = load_skill("omen-engine")
        assert skill is not None
        assert "bells toll" in skill.hooks
        pack = load_rulepack("pulp")
        assert pack.defaults["力量"] == 7
    finally:
        skills_module._USER_SKILL_DIR = original_skill_dir
        rulepacks_module._USER_RULEPACK_DIR = original_rulepack_dir
        skills_module._discover_registry.cache_clear()
        rulepacks_module._discover_registry.cache_clear()
        rulepacks_module._alias_resolver.cache_clear()


def test_reinstall_replaces_the_pack_dir_instead_of_stacking(tmp_path: Path):
    src = _write_source(tmp_path)
    built = build_pack(src, tmp_path / "out.lwpack")
    first = _install(built.path, tmp_path)
    stale = first.pack_dir / "stale-file.txt"
    stale.write_text("left over", encoding="utf-8")

    second = _install(built.path, tmp_path)
    assert second.pack_dir == first.pack_dir
    assert not stale.exists()  # replaced wholesale, never merged


def test_builtin_collisions_are_reported_as_shadowed(tmp_path: Path):
    src = _write_source(tmp_path)
    built = build_pack(src, tmp_path / "out.lwpack")
    report = _install(
        built.path,
        tmp_path,
        builtin_skill_ids={"omen-engine"},
        builtin_rulepack_ids={"pulp"},
    )
    assert sorted(report.shadowed) == ["omen-engine", "pulp"]


# --- 拆卡 at the pack level: world vs character card kinds -------------------

WORLD_CARD_JSON = json.dumps(
    {
        "spec": "chara_card_v2",
        "data": {
            "name": "Manor",
            "description": "The estate itself.",
            "extensions": {"loreweaver_hooks": ["on('turn_start', () => {});"]},
            "character_book": {
                "entries": [{"comment": "[InitVar]", "content": '{"真凶": ["butler", "twist"]}'}]
            },
        },
    }
)


def _write_world_source(root: Path, cards_yaml: str) -> Path:
    src = root / "world-src"
    (src / "cards").mkdir(parents=True)
    (src / "cards/keeper.json").write_text(CARD_JSON, encoding="utf-8")
    (src / "cards/world.json").write_text(WORLD_CARD_JSON, encoding="utf-8")
    (src / MANIFEST_NAME).write_text(
        "id: worldpack\nversion: 1.0.0\nname: World Pack\ndescription: test\n"
        "authors: [ada]\nlicense: MIT\nengine: {}\n"
        f"contents:\n  cards:\n{cards_yaml}",
        encoding="utf-8",
    )
    return src


def test_build_rejects_world_machinery_in_a_character_labeled_card(tmp_path: Path):
    src = _write_world_source(tmp_path, "    - cards/keeper.json\n    - cards/world.json\n")
    with pytest.raises(PackError, match="kind: world"):
        build_pack(src, tmp_path / "bad.lwpack")


def test_world_card_kind_builds_counts_trust_and_survives_roundtrip(tmp_path: Path):
    cards_yaml = (
        "    - cards/keeper.json\n"
        "    - path: cards/world.json\n"
        "      kind: world\n"
        "      notes:\n"
        "        en: Import last, after the rulepack.\n"
        "        zh: 最后导入，先装规则包。\n"
    )
    src = _write_world_source(tmp_path, cards_yaml)
    built = build_pack(src, tmp_path / "world.lwpack")
    assert built.manifest.trust is not None and built.manifest.trust.world_cards == 1

    # Determinism holds with mapping-form card entries.
    again = build_pack(src, tmp_path / "world2.lwpack")
    assert again.sha256 == built.sha256

    manifest = inspect_pack(built.path)
    assert manifest.card_kind("cards/world.json") == "world"
    assert manifest.card_kind("cards/keeper.json") == "character"
    entry = next(card for card in manifest.card_entries if card.path == "cards/world.json")
    assert entry.notes["zh"] == "最后导入，先装规则包。"

    report = _install(built.path, tmp_path)
    assert report.world_cards == ["cards/world.json"]
    assert set(report.cards) == {"cards/keeper.json", "cards/world.json"}


def test_verify_reenforces_card_kind_against_a_tampered_manifest(tmp_path: Path):
    cards_yaml = "    - cards/keeper.json\n    - path: cards/world.json\n      kind: world\n"
    src = _write_world_source(tmp_path, cards_yaml)
    built = build_pack(src, tmp_path / "world.lwpack")

    def relabel(entries):
        out = []
        for info, data in entries:
            if info.filename == MANIFEST_NAME:
                text = data.decode("utf-8").replace("kind: world", "kind: character")
                data = text.encode("utf-8")
            out.append((info, data))
        return out

    tampered = _rewrite_pack(built.path, tmp_path / "tampered.lwpack", relabel)
    with pytest.raises(PackError, match="kind: world"):
        _install(tampered, tmp_path)


def test_bundled_rulepack_may_extend_a_bundled_base_and_builtin(tmp_path: Path):
    src = tmp_path / "rules-src"
    (src / "rulepacks").mkdir(parents=True)
    (src / "rulepacks/base-sys.yaml").write_text("names: [base-sys]\ndefaults:\n  力量: 40\n", encoding="utf-8")
    (src / "rulepacks/patch-sys.yaml").write_text(
        "extends: base-sys\nnames: [patch-sys]\ndefaults:\n  敏捷: 60\n", encoding="utf-8"
    )
    (src / "rulepacks/pulp-coc.yaml").write_text(
        "extends: coc7\nnames: [pulp-coc]\ndefaults:\n  幸运: 99\n", encoding="utf-8"
    )
    (src / MANIFEST_NAME).write_text(
        "id: rulespack\nversion: 1.0.0\nname: Rules\ndescription: test\nauthors: [ada]\n"
        "license: MIT\nengine: {}\ncontents:\n  rulepacks:\n"
        "    - rulepacks/base-sys.yaml\n    - rulepacks/patch-sys.yaml\n    - rulepacks/pulp-coc.yaml\n",
        encoding="utf-8",
    )
    built = build_pack(src, tmp_path / "rules.lwpack")
    report = _install(built.path, tmp_path)
    assert set(report.rulepacks) == {"base-sys", "patch-sys", "pulp-coc"}
