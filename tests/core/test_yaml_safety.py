"""Tests for `core.yaml_safety`: the shared alias-bomb-rejecting YAML loader.

Covers: (a) an ordinary document (no anchors/aliases) parses byte-identically to plain
`yaml.safe_load`; (b) a trivial `&anchor`/`*alias` pair is rejected; (c) a deeply-nested
"billion laughs"-style alias bomb is rejected FAST (well under the exponential blowup a naive
`yaml.safe_load` + `str()` would suffer -- see `core.skills`/`core.rulepacks`, whose parse targets
are LLM-authored content per `agent.forge`) -- asserted with a wall-clock time bound, not just
"eventually raises," so a regression that swaps back to plain `yaml.safe_load` (which would not
raise at all, and would instead expand into the underlying alias-bomb structure) fails this test
either on the missing exception or on exceeding the time bound if `str()`-ed downstream.
"""

from __future__ import annotations

import time

import pytest
import yaml

from core.yaml_safety import NoAliasSafeLoader, safe_load_no_aliases

FAST_BOUND_SECONDS = 0.5


def _alias_bomb(name_key: str = "name", levels: int = 6, branch: int = 10) -> str:
    """A "billion laughs"-style YAML alias bomb: `levels` chained anchors, each referencing the
    previous one `branch` times, so the fully-expanded leaf count is `branch ** levels` -- a
    naive parse+`str()` (the pre-fix `core.skills`/`core.rulepacks` code path) would need to
    materialize/stringify that many nodes; our loader must reject it at the FIRST alias event
    instead, near the top of the document, regardless of how deep the bomb goes.
    """
    lines = ["a: &a [x,x,x,x,x,x,x,x,x,x]"]
    prev = "a"
    for i in range(1, levels):
        current = chr(ord("a") + i)
        refs = ",".join(f"*{prev}" for _ in range(branch))
        lines.append(f"{current}: &{current} [{refs}]")
        prev = current
    lines.append(f"{name_key}: *{prev}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# (a) Ordinary documents parse byte-identically to plain yaml.safe_load.
# ---------------------------------------------------------------------------


def test_ordinary_document_matches_plain_safe_load() -> None:
    text = "name: Test Skill\nallowed-tools: [tool_one, tool_two]\nmetadata:\n  scope: room\n"
    assert safe_load_no_aliases(text) == yaml.safe_load(text)


def test_empty_document_is_none_like_plain_safe_load() -> None:
    assert safe_load_no_aliases("") == yaml.safe_load("")


# ---------------------------------------------------------------------------
# (b) A trivial alias pair is rejected.
# ---------------------------------------------------------------------------


def test_trivial_alias_is_rejected() -> None:
    text = "base: &anchor foo\nname: *anchor\n"
    with pytest.raises(yaml.YAMLError, match="alias"):
        safe_load_no_aliases(text)


def test_bare_anchor_with_no_alias_reference_still_parses() -> None:
    """An anchor that is never referenced by an alias produces no `AliasEvent` at all, so it
    must parse exactly like plain `yaml.safe_load` -- the loader only rejects an actual alias
    USE, not merely the presence of an anchor declaration."""
    text = "name: &anchor Test Skill\n"
    assert safe_load_no_aliases(text) == {"name": "Test Skill"}


def test_loader_class_is_a_yaml_safe_loader_subclass() -> None:
    assert issubclass(NoAliasSafeLoader, yaml.SafeLoader)


# ---------------------------------------------------------------------------
# (c) A deep alias bomb is rejected fast -- not merely "eventually raises."
# ---------------------------------------------------------------------------


def test_alias_bomb_is_rejected_fast() -> None:
    bomb = _alias_bomb()
    start = time.monotonic()
    with pytest.raises(yaml.YAMLError, match="alias"):
        safe_load_no_aliases(bomb)
    elapsed = time.monotonic() - start
    assert elapsed < FAST_BOUND_SECONDS, f"alias-bomb rejection took {elapsed:.3f}s (bound {FAST_BOUND_SECONDS}s)"
