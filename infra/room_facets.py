"""Room-lifecycle facets (M23 WS1): the state's OWNER declares how it is disposed of.

Four operations end or replace a room's life — `.reset` (three scopes), room delete,
room import, room export. Before this module each of them carried its own
hand-enumerated list of what to clean, and the lists drifted: August 2026 alone fixed
three divergences (b23c450 reset vector orphans, 91b9ca4 an admin reset outside the
locked set, 9069575 a non-atomic restore), and the audit that opened M23 found a
fourth (import left the undo ring intact, so `.undo` could cross a `.save load`
boundary). The knowledge lived in the operations; it belongs with the state.

A `RoomStateFacet` is therefore declared BY the module that writes the state — the
chronicle facet beside the chronicle code, the character facet beside the character
manager, the turn-lock facet beside the hub that creates the locks. It names what the
family owns (document types, `room_state` keys and prefixes, vector collections,
whole room-scoped storages) and, in ONE place, when it dies.

## What this registry does and does not decide

It answers **what** to clean. It never answers **order** or **atomicity** — those stay
with the four operations in `net/room_backup.py`, where the segmented transactions and
their failure compensation live. A facet contributes targets to a segment the operation
chooses; it does not get to schedule itself.

## Reset scope

`reset_scope` is the LIGHTEST scope at which the facet dies, and the scopes nest
(`story` ⊂ `chars` ⊂ `all`). `reset_scope=None` means the facet survives every reset:
that is the room-SETTINGS family — language, house rules, enabled skills/presets/panels,
media toggles — configuration rather than campaign content. Surviving is a decision, so
`None` requires `survives_because` to say why; an unexplained survivor is the exact
drift this registry exists to prevent.

## Export and import are one rule, not two

A facet names the room-scoped `storages` it lives in. Every storage a facet claims must
be carried by the export manifest — unless the facet sets `export_exempt_because`, in
which case the same reason obliges import to CLEAR that storage rather than restore it:
state that a snapshot does not carry must not survive the snapshot being loaded over the
room. That single rule is what makes the undo-ring bug structurally unrepeatable.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

# The `.reset` ladder, lightest first. Each scope wipes everything the lighter ones do.
RESET_SCOPES: tuple[str, ...] = ("story", "chars", "all")

# Room-scoped storages a facet can live in. `memory` is process state (no rows), which is
# why it is exported by nobody and disposed of only when the room itself goes away.
STORAGE_DOCUMENTS = "documents"
STORAGE_ROOM_STATE = "room_state"
STORAGE_HISTORY = "history"
STORAGE_SNAPSHOTS = "snapshots"
STORAGE_VECTORS = "vectors"
STORAGE_MEDIA = "media"
STORAGE_MEMORY = "memory"
STORAGES: frozenset[str] = frozenset(
    {
        STORAGE_DOCUMENTS,
        STORAGE_ROOM_STATE,
        STORAGE_HISTORY,
        STORAGE_SNAPSHOTS,
        STORAGE_VECTORS,
        STORAGE_MEDIA,
        STORAGE_MEMORY,
    }
)
# Everything a backup could carry and an import could clear. `memory` is outside it in
# both directions: there are no rows to export, and an import must NOT drop in-process
# state — the room stays live and connected across a `.save load`.
PERSISTED_STORAGES: frozenset[str] = STORAGES - {STORAGE_MEMORY}

# The vector lane that carries no `collection` payload field: chunks of an uploaded
# document, addressed by `chat_key`. Named so a facet can claim it like any collection.
DOCUMENT_VECTOR_LANE = "*documents"


class FacetError(ValueError):
    """A facet declaration that cannot be honoured — a programming error, not input."""


@dataclass(frozen=True)
class FacetContext:
    """What a disposal hook is handed. `hub` is present only where the caller has one."""

    services: Any
    room: str
    chat_key: str
    hub: Any | None = None


@dataclass(frozen=True)
class RoomStateFacet:
    """One family of room state, declared by the module that writes it.

    Everything except `name`, `owner` and `reset_scope` is optional: a facet that owns
    only a single `room_state` key declares only that key.
    """

    name: str
    owner: str
    reset_scope: str | None
    survives_because: str = ""
    export_exempt_because: str = ""
    doc_types: frozenset[str] = frozenset()
    state_keys: frozenset[str] = frozenset()
    state_prefixes: frozenset[str] = frozenset()
    vector_collections: frozenset[str] = frozenset()
    storages: frozenset[str] = frozenset()
    # Disposal a target list cannot express — currently only in-process state. Runs inside
    # the segment `delete_room_data` assigns it, never on a schedule of its own.
    on_delete: Callable[[FacetContext], Awaitable[None]] | None = field(
        default=None, compare=False, repr=False
    )

    def __post_init__(self) -> None:
        if not self.name or not self.owner:
            raise FacetError("a facet needs a name and an owner module")  # i18n-exempt: internal invariant
        if self.reset_scope is not None and self.reset_scope not in RESET_SCOPES:
            raise FacetError(f"{self.name}: unknown reset scope {self.reset_scope!r}")
        if self.reset_scope is None and not self.survives_because:
            raise FacetError(f"{self.name}: a facet that survives every reset must say why")  # i18n-exempt: internal invariant
        unknown = self.storages - STORAGES
        if unknown:
            raise FacetError(f"{self.name}: unknown storages {sorted(unknown)}")
        for prefix in self.state_prefixes:
            if not prefix:
                raise FacetError(f"{self.name}: an empty state prefix claims every key")  # i18n-exempt: internal invariant
        declared = self.declared_storages()
        missing = declared - self.storages
        if missing:
            raise FacetError(
                f"{self.name}: claims {sorted(missing)} state but does not name the storage"  # i18n-exempt: internal invariant
            )

    def declared_storages(self) -> frozenset[str]:
        """The storages this facet's target lists imply (it may name more, e.g. history)."""
        implied: set[str] = set()
        if self.doc_types:
            implied.add(STORAGE_DOCUMENTS)
        if self.state_keys or self.state_prefixes:
            implied.add(STORAGE_ROOM_STATE)
        if self.vector_collections:
            implied.add(STORAGE_VECTORS)
        return frozenset(implied)

    def dies_at(self, scope: str) -> bool:
        """True if a `.reset <scope>` wipes this facet — scopes nest, `None` never dies."""
        if scope not in RESET_SCOPES:
            raise FacetError(f"unknown reset scope: {scope}")
        if self.reset_scope is None:
            return False
        return RESET_SCOPES.index(self.reset_scope) <= RESET_SCOPES.index(scope)


@dataclass(frozen=True)
class FacetRegistry:
    """Every facet in the process, with the conflict checks that make it authoritative."""

    facets: tuple[RoomStateFacet, ...]

    def __post_init__(self) -> None:
        _reject_collisions(self.facets)

    def in_scope(self, scope: str) -> tuple[RoomStateFacet, ...]:
        return tuple(facet for facet in self.facets if facet.dies_at(scope))

    def reset_targets(self, scope: str) -> tuple[set[str], set[str], set[str]]:
        """The (document types, state keys, state prefixes) a `.reset <scope>` wipes."""
        doc_types: set[str] = set()
        keys: set[str] = set()
        prefixes: set[str] = set()
        for facet in self.in_scope(scope):
            doc_types |= set(facet.doc_types)
            keys |= set(facet.state_keys)
            prefixes |= set(facet.state_prefixes)
        return doc_types, keys, prefixes

    def storages_at(self, scope: str) -> frozenset[str]:
        """Whole room-scoped storages a `.reset <scope>` empties."""
        return frozenset().union(*(facet.storages for facet in self.in_scope(scope)), frozenset())

    def vector_collections_at(self, scope: str) -> frozenset[str]:
        """Vector lanes a `.reset <scope>` wipes, by `collection` payload value."""
        return frozenset().union(
            *(facet.vector_collections for facet in self.in_scope(scope)), frozenset()
        )

    def claimed_doc_types(self) -> frozenset[str]:
        return frozenset().union(*(facet.doc_types for facet in self.facets), frozenset())

    def claimed_state_keys(self) -> frozenset[str]:
        return frozenset().union(*(facet.state_keys for facet in self.facets), frozenset())

    def claimed_state_prefixes(self) -> frozenset[str]:
        return frozenset().union(*(facet.state_prefixes for facet in self.facets), frozenset())

    def claimed_vector_collections(self) -> frozenset[str]:
        return frozenset().union(*(facet.vector_collections for facet in self.facets), frozenset())

    def claims_state_key(self, key: str) -> bool:
        """True if some facet claims `key` outright or through one of its prefixes."""
        if key in self.claimed_state_keys():
            return True
        return any(key.startswith(prefix) for prefix in self.claimed_state_prefixes())

    def storages_not_exported(self) -> frozenset[str]:
        """Storages whose every claimant is export-exempt — import must CLEAR these.

        A storage is exported as long as ONE facet living in it expects to be carried;
        only a storage nobody exports may be (and must be) cleared on import.
        """
        exported: set[str] = set()
        exempt: set[str] = set()
        for facet in self.facets:
            (exempt if facet.export_exempt_because else exported).update(facet.storages)
        return frozenset(exempt - exported) & PERSISTED_STORAGES

    def delete_hooks(self) -> tuple[RoomStateFacet, ...]:
        return tuple(facet for facet in self.facets if facet.on_delete is not None)


def _reject_collisions(facets: tuple[RoomStateFacet, ...]) -> None:
    """Two facets may not claim the same state: disposal would depend on iteration order."""
    seen_names: set[str] = set()
    owners: dict[tuple[str, str], str] = {}
    for facet in facets:
        if facet.name in seen_names:
            raise FacetError(f"duplicate facet name: {facet.name}")
        seen_names.add(facet.name)
        claims = (
            [("doc_type", value) for value in facet.doc_types]
            + [("state_key", value) for value in facet.state_keys]
            + [("state_prefix", value) for value in facet.state_prefixes]
            + [("vector_collection", value) for value in facet.vector_collections]
        )
        for claim in claims:
            other = owners.get(claim)
            if other is not None:
                raise FacetError(f"{claim[0]} {claim[1]!r} is claimed by both {other} and {facet.name}")
            owners[claim] = facet.name
    prefixes = sorted({(facet.name, prefix) for facet in facets for prefix in facet.state_prefixes})
    for name, prefix in prefixes:
        for other_name, other_prefix in prefixes:
            if prefix != other_prefix and other_prefix.startswith(prefix):
                raise FacetError(f"state prefix {other_prefix!r} ({other_name}) is shadowed by {prefix!r} ({name})")
    for facet in facets:
        for key in facet.state_keys:
            for other in facets:
                if other is facet:
                    continue
                for prefix in other.state_prefixes:
                    if key.startswith(prefix):
                        raise FacetError(f"state key {key!r} ({facet.name}) falls under prefix {prefix!r} ({other.name})")
