"""M23 WS1: room state nobody claims fails the build.

The four lifecycle operations (`.reset` at three scopes, delete, import, export) used to
carry hand-written lists of what to clean, and the lists drifted from the code that wrote
the state — three fixes in one month, plus a fourth this window. `infra/room_facets.py`
moved the answer to the state's OWNER; this file is what keeps the answer complete.

It scans the ACTUAL write surface rather than trusting a list:

- every `room_state` key a `state_set` call can write, resolved statically;
- every document type registered in `core.documents`;
- every vector `collection` constant in the engine.

Anything the registry does not claim is a failure. The escape hatch is deliberately
awkward: a named `(module, function)` entry below, with a written reason. It exists for
call sites that write a key some OTHER module owns (a restore, a caller-supplied key),
never for a family of state nobody has thought about.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from functools import cache, lru_cache
from pathlib import Path

import pytest

# The document-type registry is the oracle for `documents`-table coverage; there is no
# public enumeration API because nothing in the engine needs one at runtime.
from core.documents import _REGISTRY as DOCUMENT_TYPES
from infra.room_facets import (
    DOCUMENT_VECTOR_LANE,
    PERSISTED_STORAGES,
    RESET_SCOPES,
    STORAGE_MEMORY,
    FacetRegistry,
    RoomStateFacet,
)
from net.room_backup import _IMPORT_CLEAR_SQL, EXPORT_SECTIONS
from net.room_lifecycle import FACET_MODULES, room_registry

REPO_ROOT = Path(__file__).resolve().parents[2]
SCANNED_PACKAGES = ("core", "infra", "agent", "gateway", "net", "adapters")
_WRITE_METHODS = frozenset({"state_set", "state_set_if_values"})

# Call sites that write a `room_state` key the scanner cannot attribute to a facet by
# reading the expression alone. Each entry names the module and the function, and says
# which facet already owns what it writes.
WRITE_SURFACE_EXEMPTIONS: dict[tuple[str, str], str] = {
    ("agent/history.py", "migrate_legacy_blob"): (
        "writes the CALLER's history key and its leaf; every caller passes "
        "`DEFAULT_HISTORY_KEY`, which the `conversation` facet claims"
    ),
    ("agent/history.py", "rewind_to_parent"): (
        "moves the caller's history leaf pointer — same key family as above"
    ),
    ("agent/history.py", "append_turn"): (
        "moves the caller's history leaf pointer — same key family as above"
    ),
    ("agent/undo.py", "restore"): (
        "restores the history leaf pointer for the caller's history key, claimed by the "
        "`conversation` facet"
    ),
    ("agent/forge.py", "generate_and_install_module"): (
        "puts back the module runtime keys it read a moment earlier when an install turns "
        "out inconsistent; all three belong to the `module_text` facet"
    ),
    ("gateway/audio.py", "_set_json"): (
        "a JSON-writing helper whose key comes from its caller; both callers pass a key the "
        "`room_audio` facet claims"
    ),
    ("net/room_backup.py", "_atomic_store_update"): (
        "the lifecycle operation itself — it writes whatever an imported snapshot carried, "
        "which is the registry's output rather than a claim of its own"
    ),
}

# Registered document types no facet claims, with the reason. Keep this empty if you can.
DOC_TYPE_EXEMPTIONS: dict[str, str] = {}


# ---------------------------------------------------------------------------
# The scanner
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Write:
    path: str
    function: str
    line: int
    kind: str  # "exact" | "prefix" | "unresolved"
    value: str


def _python_files() -> list[Path]:
    files: list[Path] = []
    for package in SCANNED_PACKAGES:
        root = REPO_ROOT / package
        if root.is_dir():
            files.extend(sorted(p for p in root.rglob("*.py") if "__pycache__" not in p.parts))
    app = REPO_ROOT / "app.py"
    if app.is_file():
        files.append(app)
    return files


@cache
def _module_constants(module_path: str) -> dict[str, str]:
    """Module-level ``NAME = "literal"`` bindings, for cross-module import resolution."""
    path = REPO_ROOT / module_path
    if not path.is_file():
        return {}
    constants: dict[str, str] = {}
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            if isinstance(node.value.value, str):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        constants[target.id] = node.value.value
    return constants


class _Resolver:
    """Resolves a key expression to an exact key, a prefix, or nothing.

    Deliberately simple and local: constants, imported constants, f-strings, single-return
    helpers, and `for key in (...)` loops. Anything richer is reported unresolved so a
    human has to write down why it is safe.
    """

    def __init__(self, tree: ast.Module) -> None:
        self.constants: dict[str, str] = {}
        self.functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                if isinstance(node.value.value, str):
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            self.constants[target.id] = node.value.value
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imported = _module_constants(node.module.replace(".", "/") + ".py")
                for alias in node.names:
                    if alias.name in imported:
                        self.constants[alias.asname or alias.name] = imported[alias.name]
            elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                self.functions[node.name] = node
        self.bindings: dict[str, tuple[str, str]] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
                if isinstance(target, ast.Name) and target.id not in self.bindings:
                    resolved = self.resolve(node.value)
                    if resolved is not None:
                        self.bindings[target.id] = resolved
            elif isinstance(node, ast.For) and isinstance(node.target, ast.Name):
                if isinstance(node.iter, ast.Tuple | ast.List):
                    for element in node.iter.elts:
                        resolved = self.resolve(element)
                        if resolved is not None:
                            self.bindings.setdefault(node.target.id, resolved)

    def resolve(self, node: ast.AST, depth: int = 0) -> tuple[str, str] | None:
        if depth > 4:
            return None
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return ("exact", node.value)
        if isinstance(node, ast.Name):
            if node.id in self.constants:
                return ("exact", self.constants[node.id])
            return self.bindings.get(node.id)
        if isinstance(node, ast.JoinedStr):
            literal_prefix: list[str] = []
            for part in node.values:
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    literal_prefix.append(part.value)
                else:
                    return ("prefix", "".join(literal_prefix)) if literal_prefix else None
            return ("exact", "".join(literal_prefix))
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = self.resolve(node.left, depth + 1)
            if left is None or left[0] != "exact":
                return None
            right = self.resolve(node.right, depth + 1)
            if right is not None and right[0] == "exact":
                return ("exact", left[1] + right[1])
            return ("prefix", left[1])
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            function = self.functions.get(node.func.id)
            if function is None:
                return None
            returns = [n for n in ast.walk(function) if isinstance(n, ast.Return) and n.value]
            if len(returns) == 1 and returns[0].value is not None:
                return self.resolve(returns[0].value, depth + 1)
        return None


def _scan_writes() -> list[_Write]:
    writes: list[_Write] = []
    for path in _python_files():
        relative = path.relative_to(REPO_ROOT).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        resolver = _Resolver(tree)
        enclosing: dict[ast.AST, str] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                for child in ast.walk(node):
                    enclosing.setdefault(child, node.name)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr not in _WRITE_METHODS or len(node.args) < 2:
                continue
            resolved = resolver.resolve(node.args[1])
            function = enclosing.get(node, "<module>")
            if resolved is None:
                writes.append(_Write(relative, function, node.lineno, "unresolved", ""))
            else:
                writes.append(_Write(relative, function, node.lineno, resolved[0], resolved[1]))
    return writes


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_the_registry_builds_and_every_facet_names_a_declaring_module():
    registry = room_registry()
    assert registry.facets, "no facets were collected — the registry list is broken"
    for facet in registry.facets:
        assert facet.owner.replace(".", "/") + ".py" in {
            path.relative_to(REPO_ROOT).as_posix() for path in _python_files()
        }, f"{facet.name} names a module that does not exist: {facet.owner}"


def test_every_module_that_declares_facets_is_in_the_registry_list():
    """A declaration nothing imports is a facet the operations never see."""
    declaring = {
        path.relative_to(REPO_ROOT).as_posix().removesuffix(".py").replace("/", ".")
        for path in _python_files()
        if "ROOM_FACETS" in path.read_text(encoding="utf-8")
        and "ROOM_FACETS = (" in path.read_text(encoding="utf-8")
    }
    missing = declaring - set(FACET_MODULES)
    assert not missing, f"declared but never collected: {sorted(missing)}"


def test_every_written_room_state_key_is_claimed_by_a_facet():
    registry = room_registry()
    unclaimed: list[str] = []
    for write in _scan_writes():
        exemption = WRITE_SURFACE_EXEMPTIONS.get((write.path, write.function))
        if exemption:
            continue
        if write.kind == "unresolved":
            unclaimed.append(
                f"{write.path}:{write.line} ({write.function}) writes a key the scanner "
                f"cannot resolve — claim it or add a reasoned exemption"
            )
        elif write.kind == "exact":
            if not registry.claims_state_key(write.value):
                unclaimed.append(f"{write.path}:{write.line} writes unclaimed key {write.value!r}")
        elif write.value not in registry.claimed_state_prefixes():
            unclaimed.append(f"{write.path}:{write.line} writes unclaimed prefix {write.value!r}*")
    assert not unclaimed, "room_state nobody disposes of:\n  " + "\n  ".join(unclaimed)


def test_every_registered_document_type_is_claimed_by_a_facet():
    claimed = room_registry().claimed_doc_types()
    unclaimed = {name for name in DOCUMENT_TYPES if name not in claimed} - set(DOC_TYPE_EXEMPTIONS)
    assert not unclaimed, f"document types nobody disposes of: {sorted(unclaimed)}"


def test_every_vector_collection_constant_is_claimed_by_a_facet():
    """A `*_COLLECTION` constant is a vector lane; an unclaimed lane orphans its points."""
    claimed = room_registry().claimed_vector_collections()
    unclaimed: list[str] = []
    for path in _python_files():
        relative = path.relative_to(REPO_ROOT).as_posix()
        for node in ast.parse(path.read_text(encoding="utf-8")).body:
            if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Constant):
                continue
            if not isinstance(node.value.value, str):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.endswith("_COLLECTION"):
                    if node.value.value not in claimed:
                        unclaimed.append(f"{relative}: {target.id} = {node.value.value!r}")
    assert not unclaimed, "vector lanes nobody disposes of:\n  " + "\n  ".join(unclaimed)
    assert DOCUMENT_VECTOR_LANE in claimed, "the collection-less document lane must be claimed too"


def test_every_facet_storage_is_exported_or_says_why_not():
    registry = room_registry()
    for facet in registry.facets:
        for storage in facet.storages:
            if storage == STORAGE_MEMORY or facet.export_exempt_because:
                continue
            assert storage in EXPORT_SECTIONS, (
                f"{facet.name} lives in {storage!r}, which no export section carries and "
                f"which the facet does not declare export-exempt"
            )


def test_a_storage_no_snapshot_carries_is_cleared_on_import():
    """The rule that makes the undo-ring bug unrepeatable: not exported means cleared."""
    not_exported = room_registry().storages_not_exported()
    assert not_exported <= PERSISTED_STORAGES
    for storage in not_exported:
        assert storage in _IMPORT_CLEAR_SQL, (
            f"{storage!r} is carried by no snapshot, so import must clear it — add the "
            f"statement to `_IMPORT_CLEAR_SQL`"
        )
        assert storage not in EXPORT_SECTIONS


def test_a_facet_that_survives_every_reset_has_to_say_why():
    for facet in room_registry().facets:
        if facet.reset_scope is None:
            assert len(facet.survives_because.split()) >= 6, (
                f"{facet.name}: `survives_because` is the record of a decision, not a label"
            )


def test_reset_scopes_nest():
    registry = room_registry()
    previous: set[str] = set()
    for scope in RESET_SCOPES:
        doc_types, keys, prefixes = registry.reset_targets(scope)
        current = doc_types | keys | prefixes
        assert previous <= current, f"`.reset {scope}` drops targets a lighter scope wipes"
        previous = current


def test_two_facets_cannot_claim_the_same_state():
    with pytest.raises(Exception):
        FacetRegistry(
            (
                RoomStateFacet(name="a", owner="core.a", reset_scope="story", state_keys=frozenset({"k"}),
                               storages=frozenset({"room_state"})),
                RoomStateFacet(name="b", owner="core.b", reset_scope="all", state_keys=frozenset({"k"}),
                               storages=frozenset({"room_state"})),
            )
        )


def test_a_key_under_another_facets_prefix_is_rejected():
    with pytest.raises(Exception):
        FacetRegistry(
            (
                RoomStateFacet(name="a", owner="core.a", reset_scope="story",
                               state_prefixes=frozenset({"battle."}), storages=frozenset({"room_state"})),
                RoomStateFacet(name="b", owner="core.b", reset_scope="all",
                               state_keys=frozenset({"battle.latest"}), storages=frozenset({"room_state"})),
            )
        )
