"""The four documents that describe `constant` must agree with the code that enforces it.

M26 §9: `core.worldbook._normalize_import_entry` has kept `constant` for a KEEPER world
import since commit 4cf1551 (2026-08-05) — module rules and timelines are constant
entries, and stripping the flag left every imported module rule keyword-gated. The docs
were never updated and said "forced off, for everyone" for seven weeks. An engine whose
own documentation contradicts it teaches card authors the wrong thing, so the agreement
is pinned rather than trusted to a reviewer's memory.

The behaviour itself is pinned by `tests/agent/test_worldbook.py::
test_keeper_world_import_preserves_constant_player_import_does_not`. This file only
checks that the prose matches it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# The four documents §9 names, and the wording each one must no longer carry.
STALE_CLAIMS: dict[str, tuple[str, ...]] = {
    "docs/cards.md": ("for everyone",),
    "docs/cards.zh.md": ("对谁都一样",),
    "docs/plugins.md": ("constant stripped",),
    "docs/authoring.md": ("Forced off for uploaded files",),
}

# What each one must say instead: the flag survives a keeper world import.
KEEPER_CLAIMS: dict[str, tuple[str, ...]] = {
    "docs/cards.md": ("honored for the Keeper's `world` import",),
    "docs/cards.zh.md": ("在守秘人的 `world` 导入里生效",),
    "docs/plugins.md": ("`constant` honored for a keeper world import",),
    "docs/authoring.md": ("Honored for the keeper's `world` import",),
}


@pytest.mark.parametrize("relative", sorted(STALE_CLAIMS))
def test_no_document_still_says_constant_is_always_stripped(relative: str):
    text = (REPO_ROOT / relative).read_text(encoding="utf-8")
    for claim in STALE_CLAIMS[relative]:
        assert claim not in text, f"{relative} still claims `constant` is stripped: {claim!r}"


@pytest.mark.parametrize("relative", sorted(KEEPER_CLAIMS))
def test_every_document_states_the_keeper_import_keeps_constant(relative: str):
    text = (REPO_ROOT / relative).read_text(encoding="utf-8")
    for claim in KEEPER_CLAIMS[relative]:
        assert claim in text, f"{relative} does not state what the code does: {claim!r}"


def test_the_code_is_what_the_documents_now_describe():
    """The oracle side: read the enforcement off the source, not off memory."""
    source = (REPO_ROOT / "core" / "worldbook.py").read_text(encoding="utf-8")
    assert '"constant": bool(raw.get("constant", False)) if is_keeper else False' in source
