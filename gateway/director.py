"""The companion director -- pacing for AI party members (`docs/specs/M10-companions.md` §4).

An AI companion ACTS by feeding its declared action (from `agent.companion_actor.companion_action`)
through the *normal* turn pipeline (`gateway.turn.run_turn`) AS that companion -- with
`ctx.user_id = "companion:{id}"`, so the KP loop's `skill_check`/character tools operate on the
COMPANION's own sheet: a REAL roll on its REAL stats, adjudicated by the KP, fanned out to the hub.
The companion never rolls for itself.

Pacing (locked decisions):

- ``request_companion`` -- run ONE companion's turn now (exploration / on-request; `.party act`).
- ``run_combat_round`` -- iterate companions in initiative order ONCE, each taking a single turn,
  bounded by ``MAX_COMPANION_TURNS`` (anti-runaway) and honoring "pass" (an empty action → skip).
- ``run_director`` -- the AUTO-PACING entry point ``gateway.turn.run_turn`` calls after every real
  (non-command) AI-KP turn: runs one ``run_combat_round`` when ``.party auto`` is on AND the room is
  in combat (an active initiative order), else does nothing. Exploration stays on-request only.

Anti-runaway is structural: a companion turn NEVER spawns another. The director loop is the ONLY
place companion turns are scheduled, and it builds each companion turn a *hub-less* toolset (via
``build_kp_toolset(services)`` with no hub), so the ``companion_act`` KP tool can't re-enter the
director from inside a companion's own turn. ``run_director`` itself refuses to run at all when
called from within a companion's own turn (``ctx.platform == "companion"``), so even its ONE entry
point on the normal turn path (``gateway.turn.run_turn``) can never recurse.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from agent.companion_actor import companion_action
from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.npc import NpcManager, NpcRecord
from gateway.turn import run_turn

if TYPE_CHECKING:
    from agent.loop import KPTurnResult
    from agent.services import Services
    from agent.tools import Toolset
    from gateway.commands import CommandRouter
    from gateway.hub import RoomHub
    from gateway.ops import Censor

# Per-round cap on how many companion turns the director will run, so a party of many companions
# (or a mis-seeded initiative list) can never turn one combat round into an unbounded LLM cascade.
MAX_COMPANION_TURNS = 6


async def run_companion_turn(
    hub: RoomHub,
    services: Services,
    companion: NpcRecord,
    *,
    chat_key: str,
    command_router: CommandRouter,
    toolset: Toolset,
    censor: Censor | None = None,
    situation: str = "",
    locale: str = "en",
    cap_note: str | None = None,
) -> KPTurnResult | None:
    """Generate ``companion``'s action, then run it through ``run_turn`` AS that companion.

    Returns the :class:`~agent.loop.KPTurnResult` of the KP resolving the action, or ``None`` when
    the companion PASSES (its actor returned an empty action) -- a pass produces no turn and no
    events. Because ``ctx.user_id`` is ``companion:{id}``, every character/dice tool the KP reaches
    for during this turn resolves against the companion's own sheet.
    """
    sheet = await services.characters.get_character(f"companion:{companion.id}", chat_key)

    prompt_situation = f"{situation}\n{cap_note}".strip() if cap_note else situation
    # INFORMATION ISOLATION (M10 red line): a companion actor is built from ONLY its own record +
    # its own sheet, NEVER room-wide state. So we deliberately do NOT feed the room's session
    # key-events into the companion prompt -- its short-term context is just the KP-provided
    # ``situation`` for this turn. Anything the companion "knows" must reach it via its own
    # player-scoped ``knowledge`` (see ``agent.kp_tools_companion.witness``), not the shared log.
    out = await companion_action(services, companion, sheet, prompt_situation)

    action = (out.get("action") or "").strip()
    if not action:  # empty/"hold" action == a pass: the companion sits this one out
        return None
    dialogue = (out.get("dialogue") or "").strip()
    text = f"{dialogue} {action}".strip() if dialogue else action

    ctx = AgentCtx(chat_key=chat_key, user_id=f"companion:{companion.id}", platform="companion", locale=locale)
    return await run_turn(
        hub,
        services,
        ctx,
        text,
        command_router=command_router,
        toolset=toolset,
        censor=censor,
        origin=None,
        echo_exclude=None,
        actor_name=companion.name,
    )


async def request_companion(
    hub: RoomHub,
    services: Services,
    name: str,
    *,
    chat_key: str,
    command_router: CommandRouter,
    toolset: Toolset,
    censor: Censor | None = None,
    hint: str = "",
    locale: str = "en",
) -> KPTurnResult | None:
    """Run exactly ONE companion's turn now (exploration / on-request; `.party act <name>`).

    Resolves ``name`` to a `player_companion` record and runs its turn; returns ``None`` when the
    name matches no companion (or the companion passes). Never iterates the party -- this is the
    single-actor path, the anti-runaway counterpart to :func:`run_combat_round`.
    """
    npcs = NpcManager(services.store)
    companion = await npcs.get_npc(chat_key, name)
    if companion is None or companion.role != "player_companion":
        return None
    return await run_companion_turn(
        hub,
        services,
        companion,
        chat_key=chat_key,
        command_router=command_router,
        toolset=toolset,
        censor=censor,
        situation=hint,
        locale=locale,
    )


async def run_combat_round(
    hub: RoomHub,
    services: Services,
    *,
    chat_key: str,
    command_router: CommandRouter,
    toolset: Toolset,
    censor: Censor | None = None,
    situation: str = "",
    locale: str = "en",
    max_turns: int = MAX_COMPANION_TURNS,
) -> list[tuple[str, KPTurnResult | None]]:
    """Iterate the party's companions in initiative order, each taking ONE turn.

    Returns ``[(companion_id, result), ...]`` in the order the companions were processed (initiative
    order; companions absent from the initiative list follow, in party order). ``result`` is ``None``
    for a companion that passed. At most ``max_turns`` companions are processed (the anti-runaway
    cap). A companion turn never recursively schedules another -- only this loop schedules turns.
    """
    npcs = NpcManager(services.store)
    companions = await npcs.list_companions(chat_key)
    ordered = await _order_by_initiative(services, chat_key, companions)

    results: list[tuple[str, KPTurnResult | None]] = []
    for index, companion in enumerate(ordered):
        if index >= max_turns:
            break
        cap_note = None
        if index == max_turns - 1 or index == len(ordered) - 1:
            cap_note = services.i18n.with_locale(locale).t("companion.director.final_turn_note")
        result = await run_companion_turn(
            hub,
            services,
            companion,
            chat_key=chat_key,
            command_router=command_router,
            toolset=toolset,
            censor=censor,
            situation=situation,
            locale=locale,
            cap_note=cap_note,
        )
        results.append((companion.id, result))
    return results


async def run_director(
    hub: RoomHub,
    services: Services,
    ctx: AgentCtx,
    *,
    command_router: CommandRouter,
    censor: Censor | None = None,
    situation: str = "",
) -> list[tuple[str, KPTurnResult | None]]:
    """Auto-pace the party's AI companions after ``ctx``'s turn (the M10 locked "auto on initiative"
    half of pacing; `docs/specs/M10-companions.md` §4).

    This is the ONE entry point ``gateway.turn.run_turn`` calls, right after publishing a REAL
    AI-KP turn's narrative -- never for a command turn. It runs one full :func:`run_combat_round`
    ONLY when BOTH hold for ``ctx.chat_key``:

    - ``.party auto`` is on (``party_auto.{chat_key}`` == ``"1"``), and
    - the room is in combat (``initiative.{chat_key}`` has an active order).

    Exploration pacing stays strictly ON-REQUEST (``.party act`` / the KP's ``companion_act`` tool);
    outside combat, or with auto off, this is a no-op returning ``[]``.

    STRUCTURAL anti-runaway: refuses to run at all when ``ctx.platform == "companion"`` -- a
    companion's own turn re-enters ``run_turn`` (see ``run_companion_turn``) and so would otherwise
    reach this exact call site, which would recursively schedule another companion round. Since the
    director loop (``run_combat_round``) is the only scheduler and this is its only automatic
    trigger, that one guard is enough to make the whole path non-recursive.

    ``situation`` is normally the KP's just-published reply (what the companions are reacting to);
    the companion turns it runs get their own hub-less toolset (:func:`companion_turn_toolset`), so
    they can never re-enter the director via their own ``companion_act`` tool call either.
    """
    if ctx.platform == "companion":
        return []
    if not await _party_auto_enabled(services, ctx.chat_key):
        return []
    if not await _initiative_order(services, ctx.chat_key):  # no active order == not in combat
        return []
    return await run_combat_round(
        hub,
        services,
        chat_key=ctx.chat_key,
        command_router=command_router,
        toolset=companion_turn_toolset(services),
        censor=censor,
        situation=situation,
        locale=ctx.locale,
    )


async def _party_auto_enabled(services: Services, chat_key: str) -> bool:
    """Whether `.party auto` is on for `chat_key` (mirrors `agent.kp_tools_companion.party_auto`'s
    ``party_auto.{chat_key}`` store key -- ``"1"`` means on)."""
    try:
        value = await services.store.get(user_key="", store_key=f"party_auto.{chat_key}")
    except Exception:
        return False
    return value == "1"


def companion_turn_toolset(services: Services) -> Toolset:
    """The hub-less KP toolset a companion turn runs under.

    Building the companion-turn toolset with NO hub is what makes anti-runaway structural: the
    `companion_act` KP tool only re-enters the director when it was given a hub, so a toolset built
    here can't spawn a nested companion turn.
    """
    return build_kp_toolset(services)


async def _order_by_initiative(
    services: Services, chat_key: str, companions: list[NpcRecord]
) -> list[NpcRecord]:
    """Order ``companions`` by the room's initiative list; those absent from it follow, in party order."""
    order = await _initiative_order(services, chat_key)
    if not order:
        return companions

    rank = {name: index for index, name in enumerate(order)}

    def sort_key(companion: NpcRecord) -> tuple[int, int]:
        name = companion.stat_char or companion.name
        return (rank.get(name, len(rank)), 0)

    return sorted(companions, key=sort_key)


async def _initiative_order(services: Services, chat_key: str) -> list[str]:
    """The initiative-tracker names for ``chat_key``, in turn order (highest initiative first)."""
    try:
        raw = await services.store.get(user_key="", store_key=f"initiative.{chat_key}")
        entries = json.loads(raw) if raw else []
    except Exception:
        return []
    if not isinstance(entries, list):
        return []
    return [str(entry.get("name", "")) for entry in entries if isinstance(entry, dict) and entry.get("name")]
