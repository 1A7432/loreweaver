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
``narrative`` (speaker ``kp``) reply -> the room ``state`` snapshot.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from agent.loop import KPTurnResult, run_kp_turn
from core.dice_engine import coc_rank_label
from gateway.hub import Event
from infra.i18n import I18n, get_i18n
from net.state import build_room_state

if TYPE_CHECKING:
    from agent.context import AgentCtx
    from agent.services import Services
    from agent.tools import Toolset
    from gateway.commands import CommandRouter
    from gateway.hub import Member, RoomHub
    from gateway.ops import Censor

# The sentinel `CharacterManager.get_character` returns for "no character set"
# (it defaults an unresolved active-character pointer to this fixed slot name
# rather than raising). Mirrors `net.state._UNSET_CHARACTER_NAME` (a private
# name of that module, so duplicated here rather than imported).
_UNSET_CHARACTER_NAME = "default"

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
    """
    i18n = get_i18n(ctx.locale)
    name = actor_name or await _display_name(origin, ctx, services)

    await hub.publish(ctx.chat_key, Event.player_action(name=name, text=text), exclude=echo_exclude)

    result: KPTurnResult | None = None
    command_reply = await command_router.dispatch(ctx, text)
    if command_reply is not None:
        await hub.publish(ctx.chat_key, Event.narrative(speaker="system", text=command_reply, fmt="plain"))
    else:
        review = (lambda value: censor.review(value).cleaned) if censor is not None else None
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

    await publish_state(hub, services, ctx)
    return result


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

    Prefers ``ctx``'s ACTIVE character name (looked up the same way
    ``net.state._active_character`` does: ``CharacterManager.get_character``
    defaults to the caller's active character and returns a sentinel
    ``"default"``-named sheet when none is set). When the platform nickname
    (member name, else ``ctx.uid()``) differs from the character name, it is
    kept alongside it -- ``"<char name> (<nickname>)"`` -- so a chat log stays
    legible even when a player's in-fiction name and platform handle diverge;
    when they match, just the one name is shown. Falls back to the nickname
    alone (the previous behavior) when the player has no active character.
    """
    nickname = str(getattr(origin, "name", "") or ctx.uid())
    try:
        sheet = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    except Exception:
        return nickname
    if not sheet or not sheet.name or sheet.name == _UNSET_CHARACTER_NAME:
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
