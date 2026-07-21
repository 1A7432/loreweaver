"""Tests for agent.forge's rulepack generator (Layer B.3b -- `docs/plugins.md` "Layer B").

Covers: (a) happy path -- a valid LLM-generated rulepack YAML is written under a tmp
`_USER_RULEPACK_DIR` and immediately loadable via `core.rulepacks.load_rulepack`/discoverable via
`available_systems()` after the engine's own `reload_rulepacks()` call; (b) invalid output (a
non-mapping YAML root, or a `derived:` spec that doesn't compile through the safe DSL) is rejected
with `ok=False` and NOTHING written; (c) security -- a generated id colliding with a BUILT-IN
system id (`coc7`) is rejected before any write, unshadowing the real built-in, and a
traversal-shaped name sanitizes to a safe id / never escapes `_USER_RULEPACK_DIR`; (d) a second
pack landing on the same id is uniquified rather than clobbering the first; (e) with no
`_USER_RULEPACK_DIR` configured at all, generation fails cleanly instead of raising.

Every test that swaps `core.rulepacks._USER_RULEPACK_DIR` restores it and clears BOTH cached
lookups (`_discover_registry`/`_alias_resolver`) in a `finally` block, mirroring
`tests/core/test_rulepacks.py`'s convention -- never leaking a tmp path into another test's (or
the real `rulepacks/`) discovery.
"""

from __future__ import annotations

import time
from pathlib import Path

import core.rulepacks as rulepacks_module
from agent.forge import _MAX_FORGE_CONTENT_BYTES, generate_and_install_rulepack
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

# Wall-clock bound for rejecting an alias-bomb/oversized generated rulepack (see the two tests
# near the bottom of this file): both rejections happen BEFORE any YAML parse call, so they must
# stay fast regardless of how deep/large the (rejected) content is.
_FAST_REJECTION_BOUND_SECONDS = 1.0


def _alias_bomb_rulepack_yaml(levels: int = 6, branch: int = 10) -> str:
    """A "billion laughs"-style YAML alias bomb assigned to `names:` -- the shape
    `generate_and_install_rulepack` would receive as a malicious/runaway LLM response."""
    lines = ["a: &a [x,x,x,x,x,x,x,x,x,x]"]
    prev = "a"
    for i in range(1, levels):
        current = chr(ord("a") + i)
        refs = ",".join(f"*{prev}" for _ in range(branch))
        lines.append(f"{current}: &{current} [{refs}]")
        prev = current
    lines.append(f"names: *{prev}")
    return "\n".join(lines)

VALID_RULEPACK_YAML = """
names: [pulp-adventure, pulp]
set_keys: [pulp]
defaults:
  力量: 10
  敏捷: 10
  意志: 10
  生命值: 20
alias:
  力量: [STR, strength]
st_show:
  top: [力量, 敏捷, 意志, 生命值]
  itemsPerLine: 4
creation_constraints:
  method: point-buy
  points: 12
derived:
  生命值上限:
    half_of: 意志
  负重上限:
    floor_div:
      of: 力量
      by: 2
"""

NOT_A_MAPPING = "- just\n- a\n- list\n"

# A pack whose OWN id (my-custom-pack) is fine, but which tries to CLAIM a built-in's alias in its
# names: -- must be rejected pre-write so it can't half-shadow coc7 with a dead alias.
CLAIMS_BUILT_IN_ALIAS_YAML = """
names: [my-custom-pack, coc7]
set_keys: [mine]
defaults:
  力量: 999
alias:
  力量: [STR]
"""

BAD_DERIVED_YAML = """
names: [broken-pack]
defaults:
  力量: 10
derived:
  stat:
    bogus_key: 1
"""


def _services(content: str):
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text(content)]),
        embeddings=FakeEmbeddings(8),
    )


def _clear_rulepack_caches() -> None:
    rulepacks_module._discover_registry.cache_clear()
    rulepacks_module._alias_resolver.cache_clear()


# ---------------------------------------------------------------------------
# (a) Happy path.
# ---------------------------------------------------------------------------


async def test_happy_path_generates_validates_writes_and_is_discoverable(tmp_path: Path) -> None:
    services = _services(VALID_RULEPACK_YAML)

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        result = await generate_and_install_rulepack(services, "a pulp adventure system")

        assert result.ok, result.error
        assert result.skill_id == "pulp-adventure"
        assert result.name == "pulp-adventure"
        assert result.path == str(tmp_path / "pulp-adventure.yaml")
        assert Path(result.path).is_file()

        assert "pulp-adventure" in rulepacks_module.available_systems()
        pack = rulepacks_module.load_rulepack("pulp")  # resolves via a declared set_key
        assert pack.system == "pulp-adventure"
        assert pack.defaults["力量"] == 10
        assert pack.compute_derived(pack.defaults)["生命值上限"] == 5  # half_of 意志(10)
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


# ---------------------------------------------------------------------------
# (b) Invalid output -- rejected, nothing written.
# ---------------------------------------------------------------------------


async def test_invalid_output_non_mapping_root_writes_nothing(tmp_path: Path) -> None:
    services = _services(NOT_A_MAPPING)

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        result = await generate_and_install_rulepack(services, "anything")

        assert not result.ok
        assert result.error.startswith("invalid_rulepack")
        assert list(tmp_path.iterdir()) == []
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


async def test_invalid_derived_spec_writes_nothing(tmp_path: Path) -> None:
    """A `derived:` entry that doesn't compile through the safe DSL/named-computer vocabulary must
    be rejected -- the probe parse (which compiles `derived:` eagerly) catches this before any
    write, exactly like a bad `derived:` in a hand-authored rulepack file would be skipped by
    real discovery."""
    services = _services(BAD_DERIVED_YAML)

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        result = await generate_and_install_rulepack(services, "anything")

        assert not result.ok
        assert result.error.startswith("invalid_rulepack")
        assert list(tmp_path.iterdir()) == []
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


async def test_empty_llm_response_is_rejected(tmp_path: Path) -> None:
    services = _services("   ")

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        result = await generate_and_install_rulepack(services, "anything")

        assert not result.ok
        assert result.error == "empty_response"
        assert list(tmp_path.iterdir()) == []
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


# ---------------------------------------------------------------------------
# (c) Security: built-in collision rejection, path confinement.
# ---------------------------------------------------------------------------


async def test_generated_id_colliding_with_a_built_in_is_rejected(tmp_path: Path) -> None:
    collision_pack = VALID_RULEPACK_YAML.replace("pulp-adventure, pulp", "coc7")
    services = _services(collision_pack)

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        result = await generate_and_install_rulepack(services, "anything")

        assert not result.ok
        assert result.error.startswith("bad_id")
        assert "coc7" in result.error
        assert list(tmp_path.iterdir()) == []  # nothing written

        # The real built-in must still be exactly what resolves -- unshadowed.
        real_coc7 = rulepacks_module.load_rulepack("coc7")
        assert real_coc7.defaults["力量"] == 50
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


async def test_traversal_name_is_sanitized_to_a_safe_id_never_a_path(tmp_path: Path) -> None:
    traversal_pack = VALID_RULEPACK_YAML.replace("pulp-adventure, pulp", '"../../etc/passwd"')
    services = _services(traversal_pack)

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        result = await generate_and_install_rulepack(services, "anything")

        if result.ok:
            assert "/" not in result.skill_id
            assert ".." not in result.skill_id
            written = Path(result.path).resolve()
            assert written.is_relative_to(tmp_path.resolve())
        else:
            # Rejecting outright is also acceptable -- but never via the confinement guard
            # tripping, which would mean sanitization let something dangerous through this far.
            assert not result.error.startswith("path_escape")
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


# ---------------------------------------------------------------------------
# (d) Uniquify rather than clobber.
# ---------------------------------------------------------------------------


async def test_second_pack_with_same_id_is_uniquified_not_clobbered(tmp_path: Path) -> None:
    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        first = await generate_and_install_rulepack(_services(VALID_RULEPACK_YAML), "first")
        assert first.ok, first.error
        assert first.skill_id == "pulp-adventure"

        second = await generate_and_install_rulepack(_services(VALID_RULEPACK_YAML), "second")
        assert second.ok, second.error
        assert second.skill_id == "pulp-adventure-2"

        assert (tmp_path / "pulp-adventure.yaml").is_file()
        assert (tmp_path / "pulp-adventure-2.yaml").is_file()
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


async def test_generated_pack_claiming_a_built_in_alias_is_rejected(tmp_path: Path) -> None:
    """A pack with a fresh id but a `names:`/`set_keys:` claiming a built-in's alias (e.g. coc7) is
    rejected before any write — making the built-in-wins invariant explicit, not scan-order luck."""
    services = _services(CLAIMS_BUILT_IN_ALIAS_YAML)

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        result = await generate_and_install_rulepack(services, "anything")

        assert not result.ok
        assert result.error.startswith("bad_id")
        assert list(tmp_path.iterdir()) == []  # nothing written

        # coc7 still resolves to the real built-in, unshadowed by the rejected claim.
        coc = rulepacks_module.load_rulepack("coc7")
        assert coc.system == "coc7"
        assert coc.defaults["力量"] == 50
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


# ---------------------------------------------------------------------------
# (e) No data dir configured at all.
# ---------------------------------------------------------------------------


async def test_no_data_dir_configured_fails_cleanly() -> None:
    services = _services(VALID_RULEPACK_YAML)
    assert rulepacks_module._USER_RULEPACK_DIR is None  # the default in every test unless opted in

    result = await generate_and_install_rulepack(services, "anything")

    assert not result.ok
    assert result.error == "no_data_dir"
    assert result.skill_id == ""
    assert result.path == ""


# ---------------------------------------------------------------------------
# (f) Alias-bomb / oversized LLM output -- regression tests for the CPU/memory-exhaustion finding.
# ---------------------------------------------------------------------------


async def test_alias_bomb_generated_rulepack_is_rejected_fast_and_writes_nothing(tmp_path: Path) -> None:
    """A malicious/runaway LLM response whose `names:` aliases a deeply-nested anchor chain must
    be rejected -- via `core.yaml_safety.NoAliasSafeLoader`, reached through
    `core.rulepacks.parse_rulepack_text` -- fast, not parsed and then blown up by
    `_build_rulepack`'s `[str(name) for name in data.get("names")]`. Before the fix, this would
    neither fail nor stay within the time bound (plain `yaml.safe_load` resolves the alias, and
    `str()` on it explodes)."""
    services = _services(_alias_bomb_rulepack_yaml())

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        start = time.monotonic()
        result = await generate_and_install_rulepack(services, "anything")
        elapsed = time.monotonic() - start

        assert not result.ok
        assert result.error.startswith("invalid_rulepack")
        assert list(tmp_path.iterdir()) == []
        assert elapsed < _FAST_REJECTION_BOUND_SECONDS, (
            f"alias-bomb rulepack generation took {elapsed:.3f}s (bound {_FAST_REJECTION_BOUND_SECONDS}s)"
        )
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()


async def test_oversized_generated_rulepack_content_is_refused_before_parsing(tmp_path: Path) -> None:
    """LLM-authored rulepack YAML over `_MAX_FORGE_CONTENT_BYTES` must be refused BEFORE any YAML
    parse call -- a hard byte cap independent of the alias-bomb rejection, guarding against a
    merely large (non-aliased) document costing real CPU/memory on the shared event loop."""
    oversized = VALID_RULEPACK_YAML + ("\n# " + ("x" * (_MAX_FORGE_CONTENT_BYTES + 1)))
    services = _services(oversized)

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    _clear_rulepack_caches()
    try:
        start = time.monotonic()
        result = await generate_and_install_rulepack(services, "anything")
        elapsed = time.monotonic() - start

        assert not result.ok
        assert result.error.startswith("invalid_rulepack")
        assert str(_MAX_FORGE_CONTENT_BYTES) in result.error
        assert list(tmp_path.iterdir()) == []
        assert elapsed < _FAST_REJECTION_BOUND_SECONDS, (
            f"oversized rulepack rejection took {elapsed:.3f}s (bound {_FAST_REJECTION_BOUND_SECONDS}s)"
        )
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        _clear_rulepack_caches()
