"""The one place every room-lifecycle facet is collected (M23 WS1).

`infra.room_facets` defines what a facet IS; the owner modules declare them; this module
is where they become a registry the four lifecycle operations can walk. The module list
is explicit rather than discovered by scanning the package tree: an import that only
happens when some other code path happens to have imported the owner first is a registry
that silently shrinks. `tests/architecture/test_room_facets.py` compares this list against
every module in the repo that declares `ROOM_FACETS`, so forgetting to add one is a red
build rather than a room that quietly keeps state forever.

Ordering note: the registry answers WHAT a facet owns. `net/room_backup.py` keeps
answering in which segment, and in which order, each operation acts on it.
"""

from __future__ import annotations

from functools import lru_cache
from importlib import import_module

from infra.room_facets import FacetRegistry, RoomStateFacet

# Every module that declares `ROOM_FACETS`, alphabetically. Add a module here in the same
# commit that adds its declaration.
FACET_MODULES: tuple[str, ...] = (
    "agent.chronicle",
    "agent.forge",
    "agent.history",
    "agent.hook_runtime",
    "agent.kp_tools_charcard",
    "agent.kp_tools_companion",
    "agent.kp_tools_knowledge",
    "agent.kp_tools_mechanics",
    "agent.npc",
    "agent.scribe",
    "agent.scribe_coord",
    "agent.services",
    "agent.stage_director",
    "agent.tool_phase",
    "agent.undo",
    "core.battle_report",
    "core.character_manager",
    "agent.document_manager",
    "core.game_clock",
    "core.module_brief",
    "agent.module_initializer",
    "core.modvars",
    "core.mvu_compat",
    "core.pregen_roster",
    "core.relationships",
    "core.table_habits",
    "core.worldbook",
    "gateway.audio",
    "gateway.commands.rooms",
    "gateway.dev_room",
    "gateway.hub",
    "gateway.media",
    "gateway.ops",
    "gateway.turn",
    "infra.usage_stats",
)


@lru_cache(maxsize=1)
def room_registry() -> FacetRegistry:
    """Every declared facet, with the collision checks that make the result authoritative.

    Cached because building it imports thirty modules and the answer cannot change inside
    a process — facets are module-level declarations, not runtime registrations.
    """
    facets: list[RoomStateFacet] = []
    for name in FACET_MODULES:
        declared = getattr(import_module(name), "ROOM_FACETS", ())
        facets.extend(declared)
    return FacetRegistry(tuple(facets))
