"""Mechanical gate: wire error codes cannot drift across runtimes.

`error` / `admin_error` codes used to live as a TypeScript union, a pair of
locale-key prefixes, and a scatter of Python string literals. They DID drift:
the runtime and docs shipped `demo_unavailable` and `last_keeper` while
`loreweaver-protocol`'s `ErrorCode` / `AdminErrorCode` omitted them.

This file does not hard-code the expected set. It extracts the three
authoritative lists — the TS `as const` arrays the unions derive from, the
Python frozensets next to `error_frame` / `_error`, and the locale keys both
languages already ship — and fails the build on any mismatch. A new code has
to land in all three (and both locale files) in the same change.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TYPES_TS = REPO_ROOT / "clients" / "protocol" / "src" / "types.ts"
SESSION_PY = REPO_ROOT / "net" / "session.py"
ADMIN_PY = REPO_ROOT / "net" / "admin.py"
LOCALE_EN = REPO_ROOT / "locales" / "en" / "tui.json"
LOCALE_ZH = REPO_ROOT / "locales" / "zh" / "tui.json"

def _quoted_strings(body: str) -> frozenset[str]:
    return frozenset(re.findall(r'"([^"]+)"', body))


def _ts_const_array(name: str) -> frozenset[str]:
    source = TYPES_TS.read_text(encoding="utf-8")
    match = re.search(
        rf"export const {re.escape(name)}\s*=\s*\[(.*?)]\s*as const",
        source,
        re.DOTALL,
    )
    assert match, f"clients/protocol/src/types.ts no longer exports `export const {name} = [...] as const`"
    values = _quoted_strings(match.group(1))
    assert values, f"{name} parsed as empty — the extractor no longer matches the array"
    return values


def _py_frozenset(path: Path, name: str) -> frozenset[str]:
    source = path.read_text(encoding="utf-8")
    match = re.search(
        rf"^{re.escape(name)}:\s*frozenset\[str\]\s*=\s*frozenset\(\s*\{{(.*?)\}}\s*\)",
        source,
        re.DOTALL | re.MULTILINE,
    )
    assert match, f"{path.name} no longer declares `{name}: frozenset[str] = frozenset({{...}})`"
    values = _quoted_strings(match.group(1))
    assert values, f"{path.name}::{name} parsed as empty"
    return values


def _locale_codes(path: Path, prefix: str) -> frozenset[str]:
    catalog = json.loads(path.read_text(encoding="utf-8"))
    return frozenset(key[len(prefix) :] for key in catalog if key.startswith(prefix))


def _literal_call_codes(path: Path, func_names: frozenset[str]) -> frozenset[str]:
    """String literals passed as the first positional arg to the named calls."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
        if name not in func_names or not node.args:
            continue
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            found.add(arg.value)
    return frozenset(found)


def test_error_codes_match_across_ts_python_and_both_locales() -> None:
    ts = _ts_const_array("ERROR_CODES")
    py = _py_frozenset(SESSION_PY, "ERROR_CODES")
    en = _locale_codes(LOCALE_EN, "tui.error.")
    zh = _locale_codes(LOCALE_ZH, "tui.error.")
    assert ts == py, f"TS ERROR_CODES vs net.session.ERROR_CODES: only-ts={ts - py} only-py={py - ts}"
    assert ts == en, f"TS ERROR_CODES vs locales/en tui.error.*: only-ts={ts - en} only-en={en - ts}"
    assert en == zh, f"locales/en vs locales/zh tui.error.*: only-en={en - zh} only-zh={zh - en}"


def test_admin_error_codes_match_across_ts_python_and_both_locales() -> None:
    ts = _ts_const_array("ADMIN_ERROR_CODES")
    py = _py_frozenset(ADMIN_PY, "ADMIN_ERROR_CODES")
    en = _locale_codes(LOCALE_EN, "tui.admin.error.")
    zh = _locale_codes(LOCALE_ZH, "tui.admin.error.")
    assert ts == py, (
        f"TS ADMIN_ERROR_CODES vs net.admin.ADMIN_ERROR_CODES: only-ts={ts - py} only-py={py - ts}"
    )
    assert ts == en, (
        f"TS ADMIN_ERROR_CODES vs locales/en tui.admin.error.*: only-ts={ts - en} only-en={en - ts}"
    )
    assert en == zh, f"locales/en vs locales/zh tui.admin.error.*: only-en={en - zh} only-zh={zh - en}"


def test_error_frame_literals_are_members_of_the_runtime_set() -> None:
    """A new `error_frame("foo")` / `MediaError("foo")` cannot ship outside the set."""
    allowed = _py_frozenset(SESSION_PY, "ERROR_CODES")
    emitted: set[str] = set()
    for path in (REPO_ROOT / "net").rglob("*.py"):
        emitted |= _literal_call_codes(path, frozenset({"error_frame", "_error_frame"}))
    emitted |= _literal_call_codes(REPO_ROOT / "infra" / "media_store.py", frozenset({"MediaError"}))
    unknown = frozenset(emitted) - allowed
    assert not unknown, f"runtime emits error codes missing from ERROR_CODES: {sorted(unknown)}"


def test_admin_error_literals_are_members_of_the_runtime_set() -> None:
    allowed = _py_frozenset(ADMIN_PY, "ADMIN_ERROR_CODES")
    emitted = _literal_call_codes(ADMIN_PY, frozenset({"_error", "_last_keeper_error"}))
    # `_last_keeper_error` has no code literal; `_error("last_keeper")` does.
    unknown = emitted - allowed
    assert not unknown, f"runtime emits admin_error codes missing from ADMIN_ERROR_CODES: {sorted(unknown)}"
    assert "last_keeper" in allowed
    assert "demo_unavailable" in _py_frozenset(SESSION_PY, "ERROR_CODES")
