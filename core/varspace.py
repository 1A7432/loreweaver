"""Unified read surface over a room's deterministic variable state.

`core.condexpr` expressions and `core.ejs_lite` templates resolve variable paths through one
resolver; this module builds it. A path is looked up in order across the two variable stores:

1. `core.modvars` — the typed, flat, engine-native trackers (exact id match);
2. the imported MVU tree (`core.mvu_compat`, dot-separated nested paths, numeric segments
   index lists, ``[value, "description"]`` leaves unwrap to the value).

The ST/MVU-style root prefixes ``variables.`` and ``stat_data.`` are stripped before lookup, so
``variables.stage``, ``stat_data.理.好感度``, ``getvar('好感度')`` and a bare ``town_fear`` all
land in the same space. Missing paths resolve to `None` — expression semantics (fail-closed
conditions) live in `core.condexpr`, not here.

The module is pure: it never reads a document. Each caller loads the two variable states through
the projection ITS lane requires — the keeper lane raw (`agent.prompt_builder`), the player lane
through PLAYER views (`agent.card_text`, iron rule #3) — and hands them to `build_resolver`, which
returns a synchronous closure, so a build over many worldbook entries costs no further reads.
`modvar_values_from_view` flattens a projected `modvars` view into the mapping that resolver wants;
`resolve_tree_path` is the MVU-tree half on its own, for callers that already hold a tree.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from core.mvu_compat import is_value_with_desc, leaf_value

__all__ = ["build_resolver", "modvar_values_from_view", "resolve_tree_path"]

_ROOT_PREFIXES = ("variables.", "stat_data.")


def build_resolver(modvar_values: dict[str, Any], mvu_tree: dict[str, Any]) -> Callable[[str], Any]:
    """Pure resolver over already-loaded state: modvars first, then the MVU tree."""

    def resolve(path: str) -> Any:
        if not isinstance(path, str) or not path:
            return None
        for prefix in _ROOT_PREFIXES:
            if path.startswith(prefix):
                path = path[len(prefix) :]
                break
        if path in modvar_values:
            return modvar_values[path]
        return resolve_tree_path(mvu_tree, path)

    return resolve


def resolve_tree_path(tree: Any, path: str) -> Any:
    """Read one dot-separated `path` out of an MVU tree.

    Numeric segments index lists, a ``[value, "description"]`` leaf unwraps to its value, and any
    path that runs off the tree (missing key, bad index, a segment past a scalar) yields `None`.
    """
    node: Any = tree
    for segment in path.split("."):
        if isinstance(node, dict):
            if segment not in node:
                return None
            node = node[segment]
        elif isinstance(node, list) and not is_value_with_desc(node):
            try:
                node = node[int(segment)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return leaf_value(node) if is_value_with_desc(node) else node


def modvar_values_from_view(view: dict[str, Any] | None) -> dict[str, Any]:
    """Flat ``{id: value}`` from a projected `modvars` view, defaults filled in."""
    if not isinstance(view, dict):
        return {}
    specs = view.get("specs")
    values = view.get("values")
    specs = specs if isinstance(specs, dict) else {}
    values = values if isinstance(values, dict) else {}
    return {
        var_id: values.get(var_id, spec.get("default") if isinstance(spec, dict) else None)
        for var_id, spec in specs.items()
    }
