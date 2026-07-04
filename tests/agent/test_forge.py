"""Tests for agent.forge: the Layer B.3a skill-generation engine (`docs/plugins.md` "Layer B").

Covers: (a) happy path -- a valid LLM-generated SKILL.md is written under a tmp `_USER_SKILL_DIR`
and immediately discoverable via `core.skills.load_skill` after the engine's own
`reload_skills()` call; (b) invalid output (no frontmatter fences, or frontmatter that isn't a
YAML mapping) is rejected with `ok=False` and NOTHING written; (c) security -- a name that would
naively slugify to a path-escaping id is sanitized to a safe id (never smuggling a path separator
through) or rejected, a generated id colliding with a BUILT-IN skill id (`mature-mode`) is
rejected before any write, and `_confined_target` independently rejects a path-escaping id
outright (defense in depth, tested directly rather than only through the sanitizer); (d) with no
`_USER_SKILL_DIR` configured at all, generation fails cleanly instead of raising.

Every test that swaps `core.skills._USER_SKILL_DIR` restores it and clears the `@cache`d discovery
registry in a `finally` block, mirroring `tests/core/test_skills.py`'s convention -- never leaking
a tmp path into another test's (or the real `skills/`) discovery.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import core.skills as skills_module
from agent.forge import _confined_target, _slugify, generate_and_install_skill
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

VALID_SKILL_MD = """---
name: Grim Survival Horror
description: >
  Enable for a campaign about grinding, resource-scarce survival horror: supplies run out,
  wounds linger, and every choice costs something.
allowed-tools: []
metadata:
  scope: room
  content-rating: mature
---

# Grim survival horror

Track scarcity relentlessly: ammunition, food, and light sources are real, finite resources --
say so plainly when a character is down to their last of something.
"""

NO_FRONTMATTER = "Just a plain markdown document with no frontmatter fences at all.\n"

NOT_A_MAPPING = """---
- just
- a
- list
---

# Body
"""


def _services(content: str):
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text(content)]),
        embeddings=FakeEmbeddings(8),
    )


# ---------------------------------------------------------------------------
# (a) Happy path.
# ---------------------------------------------------------------------------


async def test_happy_path_generates_validates_writes_and_is_discoverable(tmp_path: Path) -> None:
    services = _services(VALID_SKILL_MD)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "a grim survival horror campaign")

        assert result.ok, result.error
        assert result.skill_id == "grim-survival-horror"
        assert result.name == "Grim Survival Horror"
        assert result.path == str(tmp_path / "grim-survival-horror" / "SKILL.md")
        assert Path(result.path).is_file()

        loaded = skills_module.load_skill("grim-survival-horror")
        assert loaded is not None
        assert loaded.name == "Grim Survival Horror"
        assert loaded.content_rating == "mature"
        assert "resource-scarce" in loaded.description
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


# ---------------------------------------------------------------------------
# (b) Invalid output -- rejected, nothing written.
# ---------------------------------------------------------------------------


async def test_invalid_output_no_frontmatter_writes_nothing(tmp_path: Path) -> None:
    services = _services(NO_FRONTMATTER)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "anything")

        assert not result.ok
        assert result.error.startswith("invalid_skill")
        assert list(tmp_path.iterdir()) == []
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


async def test_invalid_output_frontmatter_not_a_mapping_writes_nothing(tmp_path: Path) -> None:
    services = _services(NOT_A_MAPPING)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "anything")

        assert not result.ok
        assert list(tmp_path.iterdir()) == []
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


async def test_empty_llm_response_is_rejected(tmp_path: Path) -> None:
    services = _services("   ")

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "anything")

        assert not result.ok
        assert result.error == "empty_response"
        assert list(tmp_path.iterdir()) == []
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


class _RaisingLLM:
    """An LLM whose chat() raises — models a real backend failure (timeout / rate-limit / 401)."""

    async def chat(self, *args: object, **kwargs: object) -> None:
        raise RuntimeError("backend exploded (e.g. rate limit)")


async def test_llm_failure_is_a_clean_forge_result_not_an_uncaught_exception(tmp_path: Path) -> None:
    """A backend LLM failure during authoring must become a clean ForgeResult(ok=False), NOT an
    uncaught exception — otherwise it surfaces as a generic `error` frame and hangs the client's
    generate spinner. Nothing is written on failure."""
    services = build_services(Settings(locale="en"), llm=_RaisingLLM(), embeddings=FakeEmbeddings(8))

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "anything")

        assert not result.ok
        assert result.error.startswith("llm_failed")
        assert list(tmp_path.iterdir()) == []
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


# ---------------------------------------------------------------------------
# (c) Security: id sanitization, built-in collision rejection, path confinement.
# ---------------------------------------------------------------------------


async def test_traversal_name_is_sanitized_to_a_safe_id_never_a_path(tmp_path: Path) -> None:
    traversal_skill = VALID_SKILL_MD.replace("Grim Survival Horror", "../../etc/passwd")
    services = _services(traversal_skill)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "anything")

        if result.ok:
            # Sanitized to a safe id: no path separators/traversal survived, and the write
            # landed strictly inside the user skill dir.
            assert "/" not in result.skill_id
            assert ".." not in result.skill_id
            written = Path(result.path).resolve()
            assert written.is_relative_to(tmp_path.resolve())
        else:
            # Rejecting outright is also an acceptable outcome -- but it must be a clean
            # rejection (bad_id/invalid), never the path-confinement guard tripping, which
            # would mean sanitization let something dangerous through this far.
            assert not result.error.startswith("path_escape")
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


async def test_slugified_traversal_name_contains_no_path_characters() -> None:
    assert _slugify("../../etc/passwd") == "etcpasswd"


async def test_generated_id_colliding_with_a_built_in_is_rejected(tmp_path: Path) -> None:
    collision_skill = VALID_SKILL_MD.replace("Grim Survival Horror", "Mature Mode")
    services = _services(collision_skill)

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "anything")

        assert not result.ok
        assert result.error.startswith("bad_id")
        assert "mature-mode" in result.error
        assert list(tmp_path.iterdir()) == []  # nothing written
        # The real built-in must still be exactly what resolves -- unshadowed.
        loaded = skills_module.load_skill("mature-mode")
        assert loaded is not None
        assert loaded.content_rating == "explicit"
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


def test_confined_target_rejects_a_path_escaping_id_directly(tmp_path: Path) -> None:
    """Direct unit test of the path-confinement guard itself (defense in depth): even if a
    path-escaping id somehow bypassed `_slugify`, `_confined_target` must still refuse it."""
    with pytest.raises(ValueError):
        _confined_target(tmp_path, "../../etc/passwd")


def test_confined_target_accepts_a_safe_id(tmp_path: Path) -> None:
    target = _confined_target(tmp_path, "a-safe-id")
    assert target == (tmp_path / "a-safe-id" / "SKILL.md").resolve()


@pytest.mark.parametrize("bad_id", [".", "..", "", "a/b", "a\\b", "foo/../bar", "-leading-hyphen"])
def test_confined_target_rejects_degenerate_ids_independently(tmp_path: Path, bad_id: str) -> None:
    """The guard is self-standing: `.`/`..`/empty/path-separator ids are refused directly (not
    only via `_slugify`), so the confinement invariant holds even if sanitization regressed."""
    with pytest.raises(ValueError):
        _confined_target(tmp_path, bad_id)


async def test_pathologically_long_name_is_capped_and_installs(tmp_path: Path) -> None:
    """A very long generated name must not blow up the filesystem NAME_MAX at write time: the id
    is capped, so generation succeeds and writes cleanly instead of raising an unhandled OSError."""
    long_name = ("Endless " * 60).strip()  # slugifies to a ~480-char token before capping
    services = _services(VALID_SKILL_MD.replace("Grim Survival Horror", long_name))

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await generate_and_install_skill(services, "anything")

        assert result.ok, result.error
        assert 0 < len(result.skill_id) <= 64
        assert Path(result.path).is_file()  # wrote cleanly, no OSError
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


async def test_second_skill_with_same_id_is_uniquified_not_clobbered(tmp_path: Path) -> None:
    """Installing a second skill whose name slugs to an existing user id must NOT overwrite the
    first — it uniquifies (base-2), leaving the original file intact."""
    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        first = await generate_and_install_skill(_services(VALID_SKILL_MD), "first")
        assert first.ok
        assert first.skill_id == "grim-survival-horror"

        second = await generate_and_install_skill(_services(VALID_SKILL_MD), "second")
        assert second.ok
        assert second.skill_id == "grim-survival-horror-2"

        # Both survive; the first was never clobbered.
        assert (tmp_path / "grim-survival-horror" / "SKILL.md").is_file()
        assert (tmp_path / "grim-survival-horror-2" / "SKILL.md").is_file()
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


# ---------------------------------------------------------------------------
# (d) No data dir configured at all.
# ---------------------------------------------------------------------------


async def test_no_data_dir_configured_fails_cleanly() -> None:
    services = _services(VALID_SKILL_MD)
    assert skills_module._USER_SKILL_DIR is None  # the default in every test unless opted in

    result = await generate_and_install_skill(services, "anything")

    assert not result.ok
    assert result.error == "no_data_dir"
    assert result.skill_id == ""
    assert result.path == ""
