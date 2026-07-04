"""Tests for the KP-skills data-plugin foundation (core/skills.py).

Covers: (a) discovery + parse of a `skills/<id>/SKILL.md` fixture (frontmatter
+ body) against a temporary `_SKILL_DIR`, (b) a malformed skill (no frontmatter
fences) is logged and skipped without breaking discovery of the others, (c)
`available_skills()` sorts by id, (d) `load_skill(unknown)` is `None`, (e) the
built-in `romance-relationships` skill (Layer B.2) is discoverable and
mature-rated, and (f) `unlocked_tools_for` -- the Layer B.2 allowed-tools union
helper `agent.loop.run_kp_turn` feeds into `Toolset.schemas`/`Toolset.dispatch`.

Every test that swaps `core.skills._SKILL_DIR` restores it and clears the
`@cache`d registry in a `finally` block, so no test leaks a tmp path into
another test's (or the real `skills/`) discovery.
"""

from __future__ import annotations

import json
from pathlib import Path

import core.skills as skills_module
from core.skills import Skill, available_skills, load_skill, unlocked_tools_for


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


def test_real_romance_relationships_skill_exists_and_is_mature_rated() -> None:
    """The Layer B.2 built-in skill: real `skills/romance-relationships/SKILL.md`
    must be discoverable, prompt-only (no allowed-tools yet), and mature-rated."""
    skill = load_skill("romance-relationships")
    assert skill is not None
    assert skill.content_rating == "mature"
    assert skill.scope == "room"
    assert skill.systems == ["coc7"]
    assert skill.allowed_tools == []
    assert skill.body.strip()


# ---------------------------------------------------------------------------
# unlocked_tools_for — Layer B.2 allowed-tools union helper.
# ---------------------------------------------------------------------------


class _FakeStore:
    """Minimal duck-typed store: an async `get(store_key=...)` over an in-memory
    dict, matching the shape `unlocked_tools_for` (and `infra.store.Store`) expect."""

    def __init__(self, values: dict[str, str] | None = None) -> None:
        self._values = dict(values or {})

    async def get(self, user_key: str = "", store_key: str = "") -> str | None:
        return self._values.get(store_key)


SKILL_A = """---
name: Skill A
description: A fixture skill exposing tool_one and tool_two.
allowed-tools: [tool_one, tool_two]
metadata:
  scope: room
---

# Skill A
"""

SKILL_B = """---
name: Skill B
description: A fixture skill exposing tool_two and tool_three.
allowed-tools: [tool_two, tool_three]
metadata:
  scope: room
---

# Skill B
"""


async def test_unlocked_tools_for_unions_allowed_tools_across_enabled_skills(tmp_path: Path) -> None:
    _write_skill(tmp_path, "skill-a", SKILL_A)
    _write_skill(tmp_path, "skill-b", SKILL_B)

    original_dir = skills_module._SKILL_DIR
    skills_module._SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        store = _FakeStore({"skills_enabled.chat-union": json.dumps(["skill-a", "skill-b"])})
        unlocked = await unlocked_tools_for(store, "chat-union")
        assert unlocked == {"tool_one", "tool_two", "tool_three"}
    finally:
        skills_module._SKILL_DIR = original_dir
        skills_module._discover_registry.cache_clear()


async def test_unlocked_tools_for_no_enabled_skills_flag_is_empty() -> None:
    store = _FakeStore()
    assert await unlocked_tools_for(store, "chat-no-flag") == set()


async def test_unlocked_tools_for_unknown_skill_id_is_empty() -> None:
    store = _FakeStore({"skills_enabled.chat-unknown": json.dumps(["definitely-not-a-real-skill"])})
    assert await unlocked_tools_for(store, "chat-unknown") == set()


async def test_unlocked_tools_for_corrupt_flag_degrades_to_empty() -> None:
    store = _FakeStore({"skills_enabled.chat-corrupt": "not valid json"})
    assert await unlocked_tools_for(store, "chat-corrupt") == set()
