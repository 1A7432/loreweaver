"""Tests for the KP-skills data-plugin foundation (core/skills.py).

Covers: (a) discovery + parse of a `skills/<id>/SKILL.md` fixture (frontmatter
+ body) against a temporary `_SKILL_DIR`, (b) a malformed skill (no frontmatter
fences) is logged and skipped without breaking discovery of the others, (c)
`available_skills()` sorts by id, (d) `load_skill(unknown)` is `None`.

Every test that swaps `core.skills._SKILL_DIR` restores it and clears the
`@cache`d registry in a `finally` block, so no test leaks a tmp path into
another test's (or the real `skills/`) discovery.
"""

from __future__ import annotations

from pathlib import Path

import core.skills as skills_module
from core.skills import Skill, available_skills, load_skill


def _write_skill(root: Path, skill_id: str, content: str) -> None:
    skill_dir = root / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")


GOOD_SKILL = """---
name: Test Skill
description: A skill used purely for testing discovery.
allowed-tools: [skill_check, kp_note]
metadata:
  scope: room
  systems: [coc7]
  content-rating: mature
---

# Test Skill Body

This is the markdown body folded into the KP prompt.
"""

MALFORMED_NO_FENCE = """name: Malformed
description: missing the frontmatter fences entirely.

Just a body, no frontmatter.
"""


def test_discovers_and_parses_a_fixture_skill_frontmatter_and_body(tmp_path: Path) -> None:
    _write_skill(tmp_path, "test-skill", GOOD_SKILL)

    original_dir = skills_module._SKILL_DIR
    skills_module._SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        skill = load_skill("test-skill")
        assert skill is not None
        assert skill == Skill(
            id="test-skill",
            name="Test Skill",
            description="A skill used purely for testing discovery.",
            allowed_tools=["skill_check", "kp_note"],
            scope="room",
            systems=["coc7"],
            content_rating="mature",
            body="# Test Skill Body\n\nThis is the markdown body folded into the KP prompt.",
        )
    finally:
        skills_module._SKILL_DIR = original_dir
        skills_module._discover_registry.cache_clear()


def test_malformed_skill_is_skipped_but_good_skill_still_discovered(tmp_path: Path) -> None:
    _write_skill(tmp_path, "good-skill", GOOD_SKILL)
    _write_skill(tmp_path, "malformed-skill", MALFORMED_NO_FENCE)
    # A directory with no SKILL.md at all must also be tolerated.
    (tmp_path / "empty-dir").mkdir()

    original_dir = skills_module._SKILL_DIR
    skills_module._SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        ids = [skill.id for skill in available_skills()]
        assert ids == ["good-skill"]  # malformed + no-SKILL.md dirs never surface
        assert load_skill("malformed-skill") is None
        assert load_skill("empty-dir") is None
    finally:
        skills_module._SKILL_DIR = original_dir
        skills_module._discover_registry.cache_clear()


def test_available_skills_sorted_by_id(tmp_path: Path) -> None:
    _write_skill(tmp_path, "zeta-skill", GOOD_SKILL)
    _write_skill(tmp_path, "alpha-skill", GOOD_SKILL)

    original_dir = skills_module._SKILL_DIR
    skills_module._SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        ids = [skill.id for skill in available_skills()]
        assert ids == ["alpha-skill", "zeta-skill"]
    finally:
        skills_module._SKILL_DIR = original_dir
        skills_module._discover_registry.cache_clear()


def test_load_skill_unknown_id_is_none() -> None:
    assert load_skill("definitely-not-a-real-skill-id") is None


def test_real_mature_mode_skill_exists_and_is_explicit_rated() -> None:
    """The one built-in B.1 skill must actually be discoverable from the real
    `skills/` directory (not just under a tmp fixture) with the mature-mode gate."""
    skill = load_skill("mature-mode")
    assert skill is not None
    assert skill.content_rating == "explicit"
    assert skill.scope == "room"
    assert skill.body.strip()
