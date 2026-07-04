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

import pytest

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


# ---------------------------------------------------------------------------
# User data-dir discovery (Layer B.3a -- see `docs/plugins.md` "Layer B" and
# `agent.forge`, the generation engine that writes into `_USER_SKILL_DIR`).
# ---------------------------------------------------------------------------


def test_user_skill_dir_is_none_by_default() -> None:
    """Every test in this file (and every test elsewhere unless it opts in) must see the
    real, zero-regression default: no user skill dir configured at all."""
    assert skills_module._USER_SKILL_DIR is None


def test_user_skill_dir_skill_discovered_alongside_built_ins(tmp_path: Path) -> None:
    _write_skill(tmp_path, "user-skill", GOOD_SKILL)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        ids = {skill.id for skill in available_skills()}
        assert "user-skill" in ids
        assert "mature-mode" in ids  # the real built-ins are still discoverable alongside it
        loaded = load_skill("user-skill")
        assert loaded is not None
        assert loaded.name == "Test Skill"
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


def test_user_skill_dir_none_discovery_is_byte_identical_to_baseline(tmp_path: Path) -> None:
    """Setting `_USER_SKILL_DIR` and then putting it back to `None` must reproduce EXACTLY the
    same registry as never having touched it -- the additive discovery must not leave any
    residue once the user dir is unset again."""
    baseline = available_skills()

    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    skills_module._USER_SKILL_DIR = None
    skills_module._discover_registry.cache_clear()
    try:
        assert available_skills() == baseline
    finally:
        skills_module._discover_registry.cache_clear()


def test_user_skill_dir_cannot_override_a_built_in_id(tmp_path: Path) -> None:
    """A user-dir skill sharing a built-in's id must never win: the built-in's real content is
    what gets discovered, never the user-dir shadow (a generated skill must never be able to
    override e.g. `mature-mode`)."""
    shadow = """---
name: Shadow Mature Mode
description: an attempted shadow of the built-in mature-mode skill.
allowed-tools: []
metadata:
  scope: room
---

# Shadowed
"""
    _write_skill(tmp_path, "mature-mode", shadow)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        loaded = load_skill("mature-mode")
        assert loaded is not None
        assert loaded.name == "Mature mode"  # the REAL built-in, never the shadow
        assert loaded.content_rating == "explicit"
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


def test_reload_skills_picks_up_a_newly_written_skill(tmp_path: Path) -> None:
    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        assert load_skill("late-skill") is None
        _write_skill(tmp_path, "late-skill", GOOD_SKILL)
        assert load_skill("late-skill") is None  # still cached -- reload_skills() not called yet

        skills_module.reload_skills()

        loaded = load_skill("late-skill")
        assert loaded is not None
        assert loaded.name == "Test Skill"
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


def test_built_in_skill_ids_matches_the_real_skills_dir() -> None:
    ids = skills_module.built_in_skill_ids()
    assert "mature-mode" in ids
    assert "romance-relationships" in ids
    assert "skill-forge" in ids


def test_built_in_skill_ids_ignores_the_user_dir(tmp_path: Path) -> None:
    _write_skill(tmp_path, "user-only-skill", GOOD_SKILL)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    try:
        assert "user-only-skill" not in skills_module.built_in_skill_ids()
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir


def test_parse_skill_text_matches_the_on_disk_parser(tmp_path: Path) -> None:
    parsed = skills_module.parse_skill_text("in-memory-skill", GOOD_SKILL)
    assert parsed.id == "in-memory-skill"
    assert parsed.name == "Test Skill"
    assert parsed.allowed_tools == ["skill_check", "kp_note"]
    assert parsed.content_rating == "mature"


def test_parse_skill_text_rejects_malformed_frontmatter() -> None:
    with pytest.raises(ValueError):
        skills_module.parse_skill_text("bad-skill", MALFORMED_NO_FENCE)


def test_parse_skill_text_rejects_non_mapping_frontmatter() -> None:
    with pytest.raises(ValueError):
        skills_module.parse_skill_text("bad-skill", "---\n- just\n- a\n- list\n---\n\nbody\n")
