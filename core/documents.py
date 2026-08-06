"""M17 — the unified document model: one meta-type for all room content.

Every piece of room content (worldbook lore, NPC records, character sheets,
pregens, module variables, the imported MVU tree, keeper notes, the module
knowledge pool, media records) is a `Document` in ONE storage table, and every
document type registers a PROJECTION contract:

    project(document, viewer) -> view | None    (None = invisible to viewer)
    validate_write(document, services) -> violations

The wire/state/export layer calls `project()` on every outbound document — one
structural chokepoint for iron rule #3 (information isolation) instead of the
five parallel per-store mechanisms this replaces. Split-content types (NPC,
knowledge pool, MVU tree, module variables) implement REAL projections; simple
types are all-or-nothing. `agent/`, `gateway/` and `net/` never read secrecy
fields off raw documents — they consume projections (enforced by
`tests/architecture/test_document_layer.py`).

`meta.source` is provenance (``"<pack-id>#<entry-id>"`` for imported content,
``""`` for native) — load-bearing for serialized-module diff updates. `grants`
is a RESERVED per-member reveal slot (handouts later); no mechanism reads it
yet. Every document carries `schema_version` from birth (the M16 addendum:
zero-compat is for the past, not the future); `SCHEMA_MIGRATIONS` is the
designed migration slot, empty until a future version needs one.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

# ---------------------------------------------------------------------------
# Core types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Viewer:
    """Who a projection is rendered for.

    ``role`` is the transport-authenticated room role ("keeper" | "player").
    ``actor_id`` marks an NPC/companion sub-actor as the viewer: an actor sees
    its OWN document in full (its private knowledge is its own) and every other
    document at player grade — that is the structural half of iron rule #3's
    actor isolation. ``member_id`` is reserved for per-member grants.
    """

    role: str = "player"
    member_id: str | None = None
    actor_id: str | None = None
    locale: str = "en"

    @property
    def is_keeper(self) -> bool:
        return self.role == "keeper"


KEEPER_VIEWER = Viewer(role="keeper")
PLAYER_VIEWER = Viewer(role="player")


def actor_viewer(actor_id: str, *, locale: str = "en") -> Viewer:
    """A player-grade viewer that is a specific NPC/companion actor."""
    return Viewer(role="player", actor_id=actor_id, locale=locale)


@dataclass(frozen=True)
class Document:
    """One unit of room content. ``data`` is the type-specific payload."""

    id: str
    type: str
    schema_version: int
    data: dict[str, Any]
    meta: dict[str, Any] = field(default_factory=dict)
    grants: tuple[str, ...] = ()

    @property
    def source(self) -> str:
        """Provenance: ``"<pack-id>#<entry-id>"`` for imported content, else ``""``."""
        value = self.meta.get("source", "")
        return value if isinstance(value, str) else ""


class DocumentValidationError(ValueError):
    """A write was rejected by the type's `validate_write` hook."""

    def __init__(self, doc_type: str, violations: list[str]) -> None:
        self.violations = violations
        super().__init__(f"document type {doc_type!r} rejected write: " + "; ".join(violations))


ProjectFn = Callable[[Document, Viewer], dict[str, Any] | None]
ValidateFn = Callable[[Document, Any], list[str]]


def _no_validation(doc: Document, services: Any) -> list[str]:
    return []


@dataclass(frozen=True)
class DocumentType:
    """A registered document type: its schema version + the projection contract."""

    name: str
    schema_version: int
    project: ProjectFn
    validate_write: ValidateFn = _no_validation
    singleton_id: str | None = None


# Designed migration slot (M16 addendum): when a type's schema_version bumps,
# its per-version migration lands here as {(type, from_version): migrate_fn}.
SCHEMA_MIGRATIONS: dict[tuple[str, int], Callable[[dict[str, Any]], dict[str, Any]]] = {}

_REGISTRY: dict[str, DocumentType] = {}


def register_document_type(doc_type: DocumentType) -> None:
    _REGISTRY[doc_type.name] = doc_type


def document_type(name: str) -> DocumentType:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise KeyError(f"unknown document type {name!r}") from None


def document_types() -> dict[str, DocumentType]:
    return dict(_REGISTRY)


def project(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """THE chokepoint: the viewer-facing view of `doc`, or None (invisible)."""
    return document_type(doc.type).project(doc, viewer)


# ---------------------------------------------------------------------------
# Built-in projections. The secrecy sentinel tests in
# tests/documents/test_secrecy_sentinels.py were written FIRST and ran RED
# against a trivial all-pass stub before these landed (oracle-first).
# ---------------------------------------------------------------------------


def _full_view(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """All-or-nothing types with no secrecy content: everyone sees the data."""
    return dict(doc.data)


def _project_lore(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Worldbook entry: ``secret`` entries are keeper-only, whole-entry."""
    if viewer.is_keeper:
        return dict(doc.data)
    return None if doc.data.get("secret") else dict(doc.data)


_NPC_PUBLIC_FIELDS = ("name", "public_description", "location", "status")


def _project_npc(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """NPC record: the keeper and the NPC's OWN actor see everything; every
    other viewer — players and OTHER actors alike — gets the public subset.
    This is the structural half of NPC actor isolation: a sub-actor's world is
    built from its own full view, and no other document can hand it secrets."""
    if viewer.is_keeper or (viewer.actor_id is not None and viewer.actor_id == doc.id):
        return dict(doc.data)
    return {key: doc.data[key] for key in _NPC_PUBLIC_FIELDS if key in doc.data}


def _project_pregen(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Pregen cast entry: who exists and who claimed whom is table talk; the
    pristine sheet payload is keeper-side until a claim copies it out."""
    if viewer.is_keeper:
        return dict(doc.data)
    return {key: value for key, value in doc.data.items() if key != "sheet"}


def _project_modvars(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Module variables: keeper-only trackers are dropped spec AND value, so no
    player-facing surface can observe them (iron rule #3, structural)."""
    if viewer.is_keeper:
        return dict(doc.data)
    specs = doc.data.get("specs")
    values = doc.data.get("values")
    specs = specs if isinstance(specs, dict) else {}
    values = values if isinstance(values, dict) else {}
    visible = {
        var_id: spec
        for var_id, spec in specs.items()
        if isinstance(spec, dict) and spec.get("visibility") == "player"
    }
    return {
        "specs": visible,
        "values": {var_id: values[var_id] for var_id in visible if var_id in values},
    }


def _project_mvu(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Imported MVU tree: an opaque card's module state, hidden by default.
    Players see ONLY leaves under keeper-exposed path prefixes (fail-closed:
    nothing exposed → nothing shipped); the keeper view carries every leaf
    plus the exposure list so keeper surfaces can flag the hidden remainder."""
    from core.mvu_compat import flatten_leaves, path_is_exposed

    tree = doc.data.get("tree")
    leaves = flatten_leaves(tree if isinstance(tree, dict) else {})
    exposed_raw = doc.data.get("exposed")
    exposed = [p for p in exposed_raw if isinstance(p, str)] if isinstance(exposed_raw, list) else []
    if viewer.is_keeper:
        return {"leaves": leaves, "exposed": exposed}
    return {"leaves": [leaf for leaf in leaves if path_is_exposed(leaf["path"], exposed)]}


def _project_module_pool(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Knowledge pools: one document, two halves; players get the player half
    only — truths/timeline/keeper_notes live exclusively in the keeper half."""
    if viewer.is_keeper:
        return dict(doc.data)
    player = doc.data.get("player")
    return dict(player) if isinstance(player, dict) else {}


def _project_note(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Keeper notes are the keeper's private working memory: players see none."""
    return dict(doc.data) if viewer.is_keeper else None


# Singleton document ids.
MODVARS_ID = "modvars"
MVU_ID = "mvu"
MODULE_POOL_ID = "module"
SCENE_ID = "scene"

for _name, _project_fn, _singleton in (
    ("lore", _project_lore, None),
    ("npc", _project_npc, None),
    ("sheet", _full_view, None),
    ("pregen", _project_pregen, None),
    ("modvars", _project_modvars, MODVARS_ID),
    ("mvu_tree", _project_mvu, MVU_ID),
    ("module_pool", _project_module_pool, MODULE_POOL_ID),
    ("note", _project_note, None),
    ("scene", _full_view, SCENE_ID),
    ("media", _full_view, None),
):
    register_document_type(
        DocumentType(name=_name, schema_version=1, project=_project_fn, singleton_id=_singleton)
    )


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


class _StoreProtocol(Protocol):
    """Duck-typed slice of `infra.store.Store` this layer needs."""

    async def doc_get(self, room: str, doc_type: str, doc_id: str) -> dict | None: ...

    async def doc_put(
        self, room: str, doc_type: str, doc_id: str, *, schema_version: int, data: str, meta: str, grants: str
    ) -> None: ...

    async def doc_list(self, room: str, doc_type: str | None = None) -> list[dict]: ...

    async def doc_delete(self, room: str, doc_type: str, doc_id: str) -> bool: ...

    async def doc_delete_type(self, room: str, doc_type: str) -> int: ...

    async def doc_delete_room(self, room: str) -> int: ...


class DocumentStore:
    """Async CRUD over the one `documents` table, applying type contracts.

    This is the ONLY room-content persistence path. `put` runs the type's
    `validate_write` (raising `DocumentValidationError` on violations), stamps
    `meta.created`/`meta.modified`, and preserves provenance on update.
    """

    def __init__(self, store: _StoreProtocol) -> None:
        self._store = store

    async def get(self, room: str, doc_type: str, doc_id: str) -> Document | None:
        row = await self._store.doc_get(room, doc_type, doc_id)
        return _from_row(row) if row is not None else None

    async def list(self, room: str, doc_type: str | None = None) -> list[Document]:
        return [_from_row(row) for row in await self._store.doc_list(room, doc_type)]

    async def put(
        self,
        room: str,
        doc_type: str,
        doc_id: str,
        data: dict[str, Any],
        *,
        source: str | None = None,
        grants: tuple[str, ...] = (),
        services: Any = None,
    ) -> Document:
        spec = document_type(doc_type)
        existing = await self._store.doc_get(room, doc_type, doc_id)
        now = time.time()
        if existing is not None:
            meta = _meta_from_row(existing)
            meta["modified"] = now
            if source is not None:
                meta["source"] = source
        else:
            meta = {"source": source or "", "created": now, "modified": now}
        doc = Document(
            id=doc_id,
            type=doc_type,
            schema_version=spec.schema_version,
            data=data,
            meta=meta,
            grants=grants,
        )
        violations = spec.validate_write(doc, services)
        if violations:
            raise DocumentValidationError(doc_type, violations)
        await self._store.doc_put(
            room,
            doc_type,
            doc_id,
            schema_version=doc.schema_version,
            data=json.dumps(doc.data, ensure_ascii=False),
            meta=json.dumps(doc.meta, ensure_ascii=False),
            grants=json.dumps(list(doc.grants), ensure_ascii=False),
        )
        return doc

    async def delete(self, room: str, doc_type: str, doc_id: str) -> bool:
        return await self._store.doc_delete(room, doc_type, doc_id)

    async def delete_type(self, room: str, doc_type: str) -> int:
        return await self._store.doc_delete_type(room, doc_type)

    async def delete_room(self, room: str) -> int:
        return await self._store.doc_delete_room(room)

    # -- viewer-facing helpers (the outbound chokepoint) -------------------

    async def get_view(self, room: str, doc_type: str, doc_id: str, viewer: Viewer) -> dict[str, Any] | None:
        doc = await self.get(room, doc_type, doc_id)
        return project(doc, viewer) if doc is not None else None

    async def list_views(
        self, room: str, doc_type: str, viewer: Viewer
    ) -> list[tuple[Document, dict[str, Any]]]:
        """Every (document, view) pair of `doc_type` visible to `viewer`, in order."""
        pairs: list[tuple[Document, dict[str, Any]]] = []
        for doc in await self.list(room, doc_type):
            view = project(doc, viewer)
            if view is not None:
                pairs.append((doc, view))
        return pairs

    # -- singleton conveniences -------------------------------------------

    async def get_singleton(self, room: str, doc_type: str) -> Document | None:
        spec = document_type(doc_type)
        if spec.singleton_id is None:
            raise ValueError(f"document type {doc_type!r} is not a singleton type")
        return await self.get(room, doc_type, spec.singleton_id)

    async def put_singleton(
        self, room: str, doc_type: str, data: dict[str, Any], *, source: str | None = None, services: Any = None
    ) -> Document:
        spec = document_type(doc_type)
        if spec.singleton_id is None:
            raise ValueError(f"document type {doc_type!r} is not a singleton type")
        return await self.put(room, doc_type, spec.singleton_id, data, source=source, services=services)


def _from_row(row: dict) -> Document:
    data = _json_field(row.get("data"), {})
    meta = _json_field(row.get("meta"), {})
    grants_raw = _json_field(row.get("grants"), [])
    grants = tuple(str(item) for item in grants_raw) if isinstance(grants_raw, list) else ()
    doc = Document(
        id=str(row.get("id", "")),
        type=str(row.get("type", "")),
        schema_version=int(row.get("schema_version", 1)),
        data=data if isinstance(data, dict) else {},
        meta=meta if isinstance(meta, dict) else {},
        grants=grants,
    )
    return _migrate(doc)


def _meta_from_row(row: dict) -> dict[str, Any]:
    meta = _json_field(row.get("meta"), {})
    return meta if isinstance(meta, dict) else {}


def _json_field(raw: Any, default: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return default
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default


def _migrate(doc: Document) -> Document:
    """Walk the migration slot up to the type's current schema version."""
    try:
        spec = document_type(doc.type)
    except KeyError:
        return doc
    current = doc
    while current.schema_version < spec.schema_version:
        migrate = SCHEMA_MIGRATIONS.get((doc.type, current.schema_version))
        if migrate is None:
            break
        current = replace(
            current, data=migrate(dict(current.data)), schema_version=current.schema_version + 1
        )
    return current
