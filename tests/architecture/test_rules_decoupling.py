"""M16 architecture gate: the agent layer decouples COMPLETELY from rule systems.

`agent/` talks to rules exclusively through the neutral `core.check_outcome`
contract, the compiled rulepack layer, and the engine registries. It must not
import a system rules module, name a system, or compare a rank id string —
semantic flags (`success`/`critical`/`fumble`) and `tier` only.

The allowlist below records the files that are still coupled TODAY, each tagged
with the M16 stage that clears it. It must only ever SHRINK: a file that goes
clean fails the test until its entry is removed, and by the end of M16 the
allowlist is EMPTY.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = REPO_ROOT / "agent"

# Word-ish occurrences of a bundled rule system's name, case-insensitive.
# Deliberately matches comments and docstrings too: the decoupled end state
# has no reason to even TALK about a specific system inside agent/.
_SYSTEM_TOKEN_RE = re.compile(r"(?i)(?<![a-z0-9_])(coc7?|dnd(?:5e)?|wod)(?![0-9]?[a-z])")

# Rules modules the agent layer must never import (grows as stage C/D move
# more system knowledge out of the engine).
_FORBIDDEN_IMPORTS = {"core.coc_rules"}

# file name -> why it is still coupled; the M16 stage that clears it.
SYSTEM_TOKEN_ALLOWLIST: dict[str, str] = {
    "companion_actor.py": "stage D: per-system sheet template hints in the companion prompt",
    "forge.py": "stage E: forge references built-in systems as generation examples",
    "kp_tools_charcard.py": "stage B: sheet-from-card fills per-system vitals",
    "kp_tools_companion.py": "stage B: companion sheet creation branches per system",
    "kp_tools_mechanics.py": "stage C/D: legacy check branches + CoC/DND bridge ranks",
    "loop.py": "stage D: dice tool-name lists (wod_check/sanity_check) pending materialization",
}

IMPORT_ALLOWLIST: dict[str, str] = {
    "kp_tools_mechanics.py": "stage C: legacy result_check_base bridge until the compiled resolver lands",
}


def _agent_sources() -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(AGENT_DIR.glob("*.py"))}


def test_agent_system_name_allowlist_shrinks_to_empty() -> None:
    sources = _agent_sources()
    assert set(SYSTEM_TOKEN_ALLOWLIST) <= set(sources), "allowlist names a file that no longer exists"
    for name, text in sources.items():
        hits = sorted({match.group(0).lower() for match in _SYSTEM_TOKEN_RE.finditer(text)})
        if name in SYSTEM_TOKEN_ALLOWLIST:
            assert hits, (
                f"agent/{name} no longer mentions any rule system — remove it from "
                f"SYSTEM_TOKEN_ALLOWLIST (the allowlist must only shrink)"
            )
        else:
            assert not hits, f"agent/{name} mentions rule system(s) {hits}; agent/ must stay system-agnostic"


def test_agent_never_imports_system_rule_modules() -> None:
    for name, text in _agent_sources().items():
        tree = ast.parse(text)
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        forbidden = sorted(imported & _FORBIDDEN_IMPORTS)
        if name in IMPORT_ALLOWLIST:
            assert forbidden, (
                f"agent/{name} no longer imports a system rules module — remove it from IMPORT_ALLOWLIST"
            )
        else:
            assert not forbidden, f"agent/{name} imports {forbidden}; use core.check_outcome instead"


def _rank_id_vocabulary() -> frozenset[str]:
    """Every rank id any discovered pack declares (labels tables), plus the
    contract bridge ids — the strings agent/ must never compare against."""
    from core.rulepacks import _discover_registry

    ids: set[str] = {"crit", "extreme", "hard", "regular", "success", "fail", "fumble"}
    for pack in _discover_registry().values():
        for table in pack.labels.values():
            ids.update(table.keys())
    return frozenset(ids)


def test_agent_never_compares_rank_id_strings() -> None:
    """`Rank.id` is presentation-only: comparing it re-couples the agent to one
    system's ladder vocabulary. Semantic flags / `tier` are the sanctioned way."""
    rank_ids = _rank_id_vocabulary()
    violations: list[str] = []
    for name, text in _agent_sources().items():
        for node in ast.walk(ast.parse(text)):
            if not isinstance(node, ast.Compare):
                continue
            for operand in (node.left, *node.comparators):
                if isinstance(operand, ast.Constant) and isinstance(operand.value, str):
                    if operand.value.strip().casefold() in rank_ids:
                        violations.append(f"agent/{name}:{node.lineno} compares rank id {operand.value!r}")
    assert not violations, "; ".join(violations)
