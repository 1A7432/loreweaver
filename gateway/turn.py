"""Shared, transport-agnostic turn runner (M6 Phase 1).

`run_turn` is the one place a player's input becomes a sequence of normalized
:class:`~gateway.hub.Event` objects published to the room. It used to live
inline in ``net.tui_server.dispatch_input``; hoisting it here means *every*
transport (the terminal WS today, chat adapters later) drives the exact same
turn machinery — ``gateway.commands.CommandRouter`` for slash/dot commands,
``agent.loop.run_kp_turn`` for the AI-KP — and every member of the room, on
whatever transport, receives the same fan-out via ``hub.publish``.

The published order is fixed and matches what the M4 WS server produced:
``player_action`` echo -> one ``dice`` event per dice/check tool-trace entry ->
one ``narrative`` (speaker ``npc``) per ``speak_as_npc`` entry -> the
``narrative`` (speaker ``kp``) reply -> the room ``state`` snapshot. On a real
(non-command) AI-KP turn, the KP narrative is also followed by a best-effort
call into ``gateway.director.run_director`` (M10), which lets the party's AI
companions take an auto-paced turn (their own sub-turns fan out through this
same function) before the room ``state`` snapshot is published.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any

from agent.loop import KPTurnResult, run_kp_turn
from core.dice_engine import coc_rank_label
from gateway.hub import Event
from gateway.ops import room_content_unfiltered
from infra.i18n import I18n, get_i18n
from net.state import build_room_state, resolve_active_character

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from agent.context import AgentCtx
    from agent.services import Services
    from agent.tools import Toolset
    from gateway.commands import CommandRouter, CommandSpec
    from gateway.hub import Member, RoomHub
    from gateway.ops import Censor

# tool_trace `name` -> the `dice` event's `kind` (M4 §1's turn-flow step 5).
# None of these are `keeper_only` (they never touch module secrets), matching
# the wire protocol's "dice frames NEVER contain keeper secrets" guarantee.
_DICE_KIND_BY_TOOL = {
    "roll_dice": "roll",
    "skill_check": "check",
    "sanity_check": "sanity",
    "opposed_check": "opposed",
    "initiative_tracker": "init",
}
_INT_RE = re.compile(r"-?\d+")
_BRACKET_RE = re.compile(r"\[([-\d,\s]+)\]")
# Probed most-specific-first: "Critical Success"/"大成功" also contains the
# plain success label as a substring in some locales, so crit/fumble must be
# checked before the plain success/fail codes to avoid a false match.
_RANK_PROBE_ORDER = (4, 3, 2, -2, 1, -1)


async def run_turn(
    hub: RoomHub,
    services: Services,
    ctx: AgentCtx,
    text: str,
    *,
    command_router: CommandRouter,
    toolset: Toolset,
    censor: Censor | None = None,
    origin: Member | None = None,
    echo_exclude: Member | None = None,
    actor_name: str | None = None,
) -> KPTurnResult | None:
    """Run one player turn and publish its normalized events to the room.

    Fans events out to *every* member of ``ctx.chat_key``'s room via
    ``hub.publish`` (not just ``origin``), so a player on any transport sees
    the same turn. Returns the :class:`~agent.loop.KPTurnResult` for an AI-KP
    turn (so the caller can record it for observability) or ``None`` for a
    command turn.

    ``echo_exclude`` is applied ONLY to the ``player_action`` echo: the WS server
    passes ``None`` (a solo terminal still sees its own echo — the M4 behavior),
    while the chat runner passes ``origin`` so the origin channel — which already
    shows the player's own message — does not re-echo it, though OTHER transports
    still render who acted. Everything after the echo (dice/npc/kp/state) always
    goes to ALL members, including ``origin``.

    ``actor_name`` overrides the echoed/attributed actor name (member name, else
    ``ctx.uid()``). An AI companion turn (``gateway.director.run_companion_turn``)
    runs with no ``origin`` member but passes the companion's display name here so
    the room sees ``Silas: I cover the door`` rather than the raw ``companion:silas``.

    A command turn whose matched ``gateway.commands.CommandSpec.private_reply`` is set
    (e.g. ``.model key``/``.lore query``, which can echo a masked API key or keeper-only
    secret lore) delivers its reply ONLY to ``origin`` via ``Member.deliver`` — never
    ``hub.publish`` — so the rest of the room never sees it. With no ``origin`` (a
    transport with no per-connection member) this falls back to the normal broadcast.

    On a real (non-command) AI-KP turn, once the KP's own narrative is published,
    this also gives the party's AI companions (M10) a chance to auto-act via
    ``gateway.director.run_director`` — a no-op outside combat / with `.party auto`
    off, and, critically, ALWAYS a no-op when ``ctx.platform == "companion"`` (a
    companion's own turn re-enters this function and must never re-trigger the
    director — the structural anti-runaway `gateway.director` describes). A
    companion-pacing failure is logged and swallowed, never allowed to turn a
    successful player turn into a surfaced error.
    """
    i18n = get_i18n(ctx.locale)
    name = actor_name or await _display_name(origin, ctx, services)

    await hub.publish(ctx.chat_key, Event.player_action(name=name, text=text), exclude=echo_exclude)

    result: KPTurnResult | None = None
    matched_spec = _matched_command_spec(command_router, text, ctx.locale)
    command_reply = await command_router.dispatch(ctx, text)
    if command_reply is not None:
        reply_event = Event.narrative(speaker="system", text=command_reply, fmt="plain")
        if matched_spec is not None and matched_spec.private_reply and origin is not None:
            # Sensitive keeper-command reply (masked API key / keeper-only secret lore /
            # a room join key): unicast to the invoking connection only, never broadcast.
            await origin.deliver(reply_event)
        else:
            await hub.publish(ctx.chat_key, reply_event)
    else:
        # A room with a mature/explicit KP skill enabled (Layer B.1's mature-mode
        # gate — see `gateway.ops.room_content_unfiltered`) opts the output censor
        # OUT entirely for that room, regardless of the configured `Censor`; every
        # other room keeps today's behavior exactly.
        unfiltered = await room_content_unfiltered(services.store, ctx.chat_key)
        review = None if unfiltered else ((lambda value: censor.review(value).cleaned) if censor is not None else None)
        result = await run_kp_turn(ctx, services, toolset, text, output_review=review)
        for entry in result.tool_trace:
            dice_event = _dice_event(entry, name, i18n)
            if dice_event is not None:
                await hub.publish(ctx.chat_key, dice_event)
        for entry in result.tool_trace:
            npc_event = _npc_event(entry, i18n)
            if npc_event is not None:
                await hub.publish(ctx.chat_key, npc_event)
        await hub.publish(ctx.chat_key, Event.narrative(speaker="kp", text=result.reply, fmt="markdown"))

        if ctx.platform != "companion":
            await _run_companion_director(hub, services, ctx, command_router, censor, result.reply)

    await publish_state(hub, services, ctx)
    return result


def _matched_command_spec(command_router: CommandRouter, text: str, locale: str) -> CommandSpec | None:
    """The ``CommandSpec`` ``text`` resolves to, or ``None`` for a non-command turn.

    Reuses ``CommandRouter.resolve`` — the router's own accessor, not a re-implementation
    of its prefix/alias parsing — purely to learn ``private_reply`` before dispatching;
    ``command_router.dispatch`` performs the actual (identical) resolution again to run
    the handler, so this never affects which handler runs or its result.
    """
    resolved = command_router.resolve(text, locale)
    return resolved[0] if resolved is not None else None


async def _run_companion_director(
    hub: RoomHub,
    services: Services,
    ctx: AgentCtx,
    command_router: CommandRouter,
    censor: Censor | None,
    situation: str,
) -> None:
    """Best-effort M10 auto-pacing call-out (see ``run_turn``'s docstring).

    Imported lazily to avoid a module-level cycle (``gateway.director`` imports
    ``run_turn`` FROM this module, since a companion's turn runs through it too).
    """
    from gateway.director import run_director

    try:
        await run_director(hub, services, ctx, command_router=command_router, censor=censor, situation=situation)
    except Exception:
        logger.warning("director: companion auto-turn failed for chat_key=%s", ctx.chat_key, exc_info=True)


async def publish_state(hub: RoomHub, services: Services, ctx: AgentCtx) -> None:
    """Build ``ctx``'s room snapshot and publish it as a ``state`` event.

    Overlays the live connection count and per-party ``online`` flags from the
    hub's current membership (a presence concern the read-only
    ``net.state.build_room_state`` deliberately leaves at ``0``/``True``).
    """
    snapshot = await build_room_state(services, ctx)
    members = hub.members(ctx.chat_key)
    snapshot["online"] = len(members)
    connected_names = {getattr(member, "name", "") for member in members}
    for party_member in snapshot.get("party", []):
        party_member["online"] = party_member.get("name") in connected_names
    await hub.publish(ctx.chat_key, Event.state(snapshot))


async def _display_name(origin: Member | None, ctx: AgentCtx, services: Services) -> str:
    """The actor name to echo/attribute this turn to.

    Prefers ``ctx``'s ACTIVE character name, resolved via
    ``net.state.resolve_active_character`` -- the SAME function
    ``net.state.build_room_state`` uses for the room ``state`` snapshot's
    ``character``/``party[].active`` fields, reused here (not re-implemented)
    so the echoed actor name and what ``state`` reports can never diverge for
    the same caller. When the platform nickname (member name, else
    ``ctx.uid()``) differs from the character name, it is kept alongside it --
    ``"<char name> (<nickname>)"`` -- so a chat log stays legible even when a
    player's in-fiction name and platform handle diverge; when they match,
    just the one name is shown. Falls back to the nickname alone when the
    player has no active character.
    """
    nickname = str(getattr(origin, "name", "") or ctx.uid())
    sheet = await resolve_active_character(services, ctx)
    if sheet is None:
        return nickname
    if sheet.name == nickname:
        return sheet.name
    return f"{sheet.name} ({nickname})"


def _npc_event(entry: dict[str, Any], i18n: I18n) -> Event | None:
    """Best-effort ``narrative`` event from one AI-NPC dialogue tool-trace entry."""
    if entry.get("name") != "speak_as_npc":
        return None

    arguments = entry.get("arguments")
    npc_name = ""
    if isinstance(arguments, dict):
        npc_name = str(arguments.get("npc") or "").strip()

    return Event.narrative(
        speaker="npc",
        name=npc_name or i18n.t("hub.npc.unknown_name"),
        text=str(entry.get("result") or ""),
        fmt="markdown",
    )


def _dice_event(entry: dict[str, Any], actor: str, i18n: I18n) -> Event | None:
    """Best-effort ``dice`` event from one `KPTurnResult.tool_trace` entry.

    The KP tools only ever return a rendered, localized string (never a raw
    `core.dice_engine.DiceResult`), so this recovers what it reasonably can
    from that text rather than re-rolling: the trailing integer as ``total``,
    a bracketed roll list when the template rendered one (e.g. ``[15]+3``),
    and — when the text happens to contain one of the localized COC rank
    labels `core.dice_engine.coc_rank_label` would have produced — a canonical
    ``-2..4`` ``rank``/``success``.
    """
    tool_name = str(entry.get("name", ""))
    kind = _DICE_KIND_BY_TOOL.get(tool_name)
    if kind is None or entry.get("keeper_only"):
        return None

    text = str(entry.get("result", ""))
    numbers = [int(match) for match in _INT_RE.findall(text)]
    if not numbers:
        return None

    bracket = _BRACKET_RE.search(text)
    rolls = [int(match) for match in _INT_RE.findall(bracket.group(1))] if bracket else numbers

    arguments = entry.get("arguments") or {}
    fields: dict[str, Any] = {
        "expr": _dice_expr(tool_name, arguments),
        "rolls": rolls,
        "total": numbers[-1],
    }

    rank = _infer_rank(text, i18n)
    if rank is not None:
        fields["rank"] = rank
        fields["success"] = rank >= 1
    return Event.dice(actor=str(arguments.get("name") or actor), kind=kind, **fields)


def _dice_expr(name: str, arguments: dict[str, Any]) -> str:
    if name == "roll_dice":
        return str(arguments.get("expression", ""))
    if name == "skill_check":
        return str(arguments.get("skill_name", ""))
    if name == "sanity_check":
        return f"{arguments.get('success_loss', '')}/{arguments.get('failure_loss', '')}"
    if name == "opposed_check":
        return f"{arguments.get('skill1', '')} vs {arguments.get('skill2', '')}"
    return str(arguments.get("name") or name)


def _infer_rank(text: str, i18n: I18n) -> int | None:
    for code in _RANK_PROBE_ORDER:
        if coc_rank_label(code, i18n) in text:
            return code
    return None
