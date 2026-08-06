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

Load once per prompt/state build: `load_resolver` reads both variable documents a single time
and returns a pure synchronous closure, so a build over many worldbook entries costs two
document reads total.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from core.documents import KEEPER_VIEWER, MODVARS_ID, PLAYER_VIEWER, DocumentStore
from core.modvars import MODVARS_DOC_TYPE
from core.mvu_compat import is_value_with_desc, leaf_value, load_mvu

_ROOT_PREFIXES = ("variables.", "stat_data.")


def build_resolver(modvar_values: dict[str, Any], mvu_tree: dict[str, Any]) -> Callable[[str], Any]:
    """Pure resolver over already-loaded state (the testable core of `load_resolver`)."""

    def resolve(path: str) -> Any:
        if not isinstance(path, str) or not path:
            return None
        for prefix in _ROOT_PREFIXES:
            if path.startswith(prefix):
                path = path[len(prefix) :]
                break
        if path in modvar_values:
            return modvar_values[path]
        return _walk_tree(mvu_tree, path)

    return resolve


def _walk_tree(tree: Any, path: str) -> Any:
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


async def load_resolver(store: Any, chat_key: str, *, player_view: bool = False) -> Callable[[str], Any]:
    """Load both variable documents once and return the pure resolver over them.

    ``player_view=True`` builds the PLAYER-SIDE resolver (iron rule #3): the `modvars`
    document is read through its PLAYER projection, so keeper-only trackers are filtered
    out structurally and template rendering inside an NPC/companion actor's context — or
    any other player-facing surface — can never observe them. The MVU tree has no
    visibility concept upstream and is included whole in both views (server-side template
    rendering, not transport).
    """
    documents = DocumentStore(store)
    viewer = PLAYER_VIEWER if player_view else KEEPER_VIEWER
    view = await documents.get_view(chat_key, MODVARS_DOC_TYPE, MODVARS_ID, viewer)
    mvu_tree = await load_mvu(documents, chat_key)
    return build_resolver(modvar_values_from_view(view), mvu_tree)
