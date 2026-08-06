"""M17 architecture gate: one documents table, one projection chokepoint.

Room CONTENT persists ONLY through `core.documents` (the `documents` table);
room-scoped RUNTIME state only through the `room_state` table. The old
per-store KV keys are deleted — any literal resurrection of one of those key
bases in engine code is a revival of the pre-M17 storage (and of the
backup-allowlist drift class that came with it), and fails here immediately.

Secrecy filtering is centralized in the document projections: the filter
functions the pre-M17 mechanisms used (`path_is_exposed`, per-store
player-view helpers) may not be referenced from `agent/`, `gateway/` or
`net/` — those layers consume `project()` views (`get_view`/`list_views`),
never raw secrecy fields.

Like the M16 gate, allowlists must only ever SHRINK and are EMPTY at the end
of the window.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
_SCAN_DIRS = ("core", "agent", "gateway", "net", "adapters", "infra")

# The pre-M17 per-store KV key bases (content AND moved runtime state). A
# literal `"<base>.{` / `f"<base>.` occurrence in engine code means someone is
# rebuilding the old parallel store.
_DEAD_KEY_BASES = (
    "worldbook.",
    "worldbook_index.",
    "npc_list.",
    "characters_list.",
    "pregen_roster.",
    "pregen_sheet.",
    "module_vars.",
    "mvu_data.",
    "mvu_exposed.",
    "kp_notes.",
    "module_player_pool.",
    "module_keeper_pool.",
    "module_catalog.",
)
# Match STORE-KEY shaped literals only (`f"<base>.{chat_key}"`-style): an i18n
# key like "worldbook.tools.add.done" shares the word but never interpolates.
_DEAD_KEY_RE = re.compile("|".join(re.escape(f'"{base}') + r"\{" for base in _DEAD_KEY_BASES))

# Secrecy filter functions that live inside the document layer's projections.
# Only `core/documents.py` (the projections) and the modules that OWN the pure
# logic may reference them; the outbound layers consume projections instead.
_PROJECTION_ONLY_NAMES = ("path_is_exposed",)
_PROJECTION_OWNERS = {
    Path("core/documents.py"),
    Path("core/mvu_compat.py"),  # defines the pure function
}

# file (repo-relative, posix) -> reason; must only ever shrink, EMPTY at window end.
DEAD_KEY_ALLOWLIST: dict[str, str] = {}
PROJECTION_ALLOWLIST: dict[str, str] = {}


def _engine_sources() -> dict[Path, str]:
    sources: dict[Path, str] = {}
    for dir_name in _SCAN_DIRS:
        for path in sorted((REPO_ROOT / dir_name).rglob("*.py")):
            rel = path.relative_to(REPO_ROOT)
            sources[rel] = path.read_text(encoding="utf-8")
    return sources


def test_no_dead_store_key_base_is_revived() -> None:
    violations: list[str] = []
    for rel, text in _engine_sources().items():
        hits = sorted({match.group(0) for match in _DEAD_KEY_RE.finditer(text)})
        if not hits:
            continue
        if str(rel) in DEAD_KEY_ALLOWLIST:
            continue
        violations.append(f"{rel}: {hits}")
    assert not violations, (
        "pre-M17 store-key bases revived outside the document layer:\n" + "\n".join(violations)
    )
    assert not DEAD_KEY_ALLOWLIST, "allowlist must be empty at the end of the M17 window"


def test_secrecy_filters_live_only_in_document_projections() -> None:
    violations: list[str] = []
    for rel, text in _engine_sources().items():
        if rel in _PROJECTION_OWNERS or str(rel) in PROJECTION_ALLOWLIST:
            continue
        for name in _PROJECTION_ONLY_NAMES:
            if re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", text):
                violations.append(f"{rel}: references {name}")
    assert not violations, (
        "secrecy filters must be consumed via document projections, not re-applied ad hoc:\n"
        + "\n".join(violations)
    )
    assert not PROJECTION_ALLOWLIST, "allowlist must be empty at the end of the M17 window"
