"""Which tool phase a room is in (M20 B) — `prep` or `play`.

The Keeper's 76 tools are not all wanted at once. The axis that separates them is
**bulk / low-frequency vs improvisational**: authoring a module-grade NPC, importing a
lorebook, defining a variable, exporting a report are things a keeper does in a sitting
before or between sessions; rolling a check, voicing an NPC, moving the clock are things
that happen every turn. `prep_only` on `@tool` marks the first kind; this module answers
"which phase is this room in right now" so the loop can drop them during play.

The axis is deliberately NOT "prep-type work". Improvising a shopkeeper mid-scene is
ordinary play, and a keeper flipping phase to rescue one improvised line would BE the
ceremony the split is supposed to remove — so the light `sketch_npc` counterpart lives in
both phases. That also keeps iron rule #3 intact: no record means no knowledge-scoped
actor, so an NPC voiced without one would have nowhere to keep its private knowledge.

**Where the default comes from.** An unset room follows its own recorded lifecycle rather
than a guess about intent: a room whose module has not finished initializing is still
being built, so it reads as `prep` (which is where the bulk tools belong, and it is what
makes a brand-new room work with no ceremony at all); once `module_init_status` reaches
ready, the room reads as `play`. A keeper's explicit `.phase` choice is a pin and always
wins — including pinning a never-initialized freeform room to `play`.
"""

from __future__ import annotations

import logging

from agent.tools import PLAY_PHASE, PREP_PHASE
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet
from infra.store import Store

logger = logging.getLogger(__name__)

PHASE_KEY = "tool_phase"
PHASES = (PREP_PHASE, PLAY_PHASE)

# The module-init states that mean "this room's content is built" — the same pair
# `agent.prompt_builder` treats as an initialized pool.
_READY_STATES = {"ready", "ready_fallback"}


async def room_phase(store: Store, chat_key: str) -> str:
    """This room's current tool phase, keeper pin first, lifecycle otherwise.

    Never raises: an unreadable store degrades to `prep`, the permissive phase — a
    storage hiccup must not take tools away mid-campaign.
    """
    try:
        pinned = await store.state_get(chat_key, PHASE_KEY)
        if pinned in PHASES:
            return pinned
        status = await store.state_get(chat_key, "module_init_status")
    except Exception:  # noqa: BLE001 — see docstring
        logger.debug("tool phase unreadable for %s; falling back to prep", chat_key, exc_info=True)
        return PREP_PHASE
    return PLAY_PHASE if status in _READY_STATES else PREP_PHASE


async def set_room_phase(store: Store, chat_key: str, phase: str | None) -> None:
    """Pin this room to `phase`, or clear the pin with `None` so the lifecycle governs again."""
    if phase is not None and phase not in PHASES:
        raise ValueError(f"unknown tool phase {phase!r}")
    await store.state_set(chat_key, PHASE_KEY, phase or "")


async def is_pinned(store: Store, chat_key: str) -> bool:
    """Whether a keeper has pinned this room's phase (vs. following its lifecycle)."""
    try:
        return await store.state_get(chat_key, PHASE_KEY) in PHASES
    except Exception:  # noqa: BLE001 — same stance as `room_phase`
        return False


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="tool_phase",
        owner="agent.tool_phase",
        reset_scope=None,
        survives_because=(
            "an empty value means `follow the room's lifecycle`, so the key is inert "
            "unless a keeper pinned the phase with `.phase` — and a pin is a room setting"
        ),
        state_keys=frozenset({PHASE_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
