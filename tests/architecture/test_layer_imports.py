"""Production layering: ``agent/`` must not import ``net/``.

``agent/`` is the Keeper brain; ``net/`` is the transport/admin surface.
A reverse import (for example ``agent.kp_tools_*`` pulling
``net.room_backup``) couples the model tools to a carrier and breaks the
layer stack in AGENTS.md. Shared helpers belong in ``infra/``.
"""

from __future__ import annotations

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = REPO_ROOT / "agent"


def _imported_modules(tree: ast.AST) -> set[str]:
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    return imported


def test_agent_never_imports_net() -> None:
    violations: list[str] = []
    for path in sorted(AGENT_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for module in sorted(_imported_modules(tree)):
            if module == "net" or module.startswith("net."):
                rel = path.relative_to(REPO_ROOT)
                violations.append(f"{rel} imports {module}")
    assert not violations, (
        "agent/ must not import net/ (put shared helpers in infra/):\n" + "\n".join(violations)
    )
