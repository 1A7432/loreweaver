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

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any

from agent.context import AgentCtx
from agent.loop import KPTurnResult, run_kp_turn
from core.dice_engine import coc_rank_label
from gateway.hub import Event
from gateway.ops import room_content_unfiltered
from infra.i18n import I18n, get_i18n
from infra.llm import Usage, context_window_for
from net.state import build_room_state, resolve_active_character

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
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
_SESSION_ACTION_MAX_CHARS = 1000


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
    this also best-effort records the turn's token/cache usage (``_record_usage_stats``)
    -- surfaced by ``net.state.build_room_state`` as ``state.usage`` -- and gives the
    party's AI companions (M10) a chance to auto-act via
    ``gateway.director.run_director`` — a no-op outside combat / with `.party auto`
    off, and, critically, ALWAYS a no-op when ``ctx.platform == "companion"`` (a
    companion's own turn re-enters this function and must never re-trigger the
    director — the structural anti-runaway `gateway.director` describes). A
    companion-pacing failure is logged and swallowed, never allowed to turn a
    successful player turn into a surfaced error.
    """
    i18n = get_i18n(ctx.locale)
    name = actor_name or await _display_name(origin, ctx, services)
    extra = getattr(ctx, "extra", None)
    interaction_private = bool(
        isinstance(extra, dict) and extra.get("private_interaction")
    )

    result: KPTurnResult | None = None
    matched_spec = _matched_command_spec(command_router, text, ctx.locale)
    action_event = Event.player_action(name=name, text=text)
    if matched_spec is None:
        await hub.publish(ctx.chat_key, action_event, exclude=echo_exclude)
    elif origin is not None and echo_exclude is None:
        # Keep the TUI caller's local echo, but never broadcast raw command arguments
        # such as attachment paths, provider endpoints, or keys to room peers.
        await origin.deliver(action_event)
    reply = await command_router.dispatch_reply(ctx, text)
    command_reply = reply.text if reply is not None else None
    command_events = reply.events if reply is not None else ()
    if command_reply is not None:
        if matched_spec is not None and matched_spec.canonical == "panel":
            snapshot = await _state_for_ctx(hub, services, ctx)
            event = Event.panel(snapshot)
            if origin is not None:
                await origin.deliver(event)
            else:
                await hub.publish(ctx.chat_key, event)
            return None
        for event in command_events:
            if event.kind == "dice":
                # Commands record the stable user id; the room edge owns the active
                # character/platform display name used by every other turn event.
                event.data["actor"] = name
            event_origin_only = bool(
                event.private
                or interaction_private
                or (matched_spec and matched_spec.private_reply)
            )
            if event_origin_only:
                event.private = True
                if origin is not None:
                    await origin.deliver(event)
            else:
                await hub.publish(ctx.chat_key, event)
        reply_event = Event.narrative(
            speaker="system",
            text=command_reply,
            fmt="plain",
            private=bool(
                interaction_private or (matched_spec and matched_spec.private_reply)
            ),
        )
        origin_only = bool(
            interaction_private
            or (
                matched_spec
                and (matched_spec.private_reply or matched_spec.canonical == "room")
            )
        )
        if origin_only:
            # Sensitive keeper-command reply (masked API key / keeper-only secret lore /
            # a room join key): unicast to the invoking connection only, never broadcast.
            if origin is not None:
                await origin.deliver(reply_event)
        else:
            await hub.publish(ctx.chat_key, reply_event)
    else:
        # `.bot off` (gateway.commands.cmd_bot_toggle) mutes the AI Keeper for this
        # room: the player message above is still echoed to everyone (a human-Keeper
        # table keeps chatting, dice commands keep working), but no KP turn runs.
        # Unset defaults to ON — the hub/TUI table's existing behavior. The chat
        # adapters gate earlier, in `GatewayRunner.on_inbound`, with their own
        # per-platform defaults; this check makes the same switch real on the hub path.
        if not await _kp_enabled(services, ctx.chat_key):
            await publish_state(hub, services, ctx)
            return None
        role = extra.get("role") if isinstance(extra, dict) else None
        if ctx.platform != "companion" and role != "keeper":
            character = await resolve_active_character(services, ctx)
            char_name = character.name if character is not None else name
            await services.battles.add_player_action(
                ctx.chat_key,
                ctx.uid(),
                char_name,
                text[:_SESSION_ACTION_MAX_CHARS],
            )
        # A room with a mature/explicit KP skill enabled (Layer B.1's mature-mode
        # gate — see `gateway.ops.room_content_unfiltered`) opts the output censor
        # OUT entirely for that room, regardless of the configured `Censor`; every
        # other room keeps today's behavior exactly.
        unfiltered = await room_content_unfiltered(services.store, ctx.chat_key)
        review = None if unfiltered else ((lambda value: censor.review(value).cleaned) if censor is not None else None)
        result = await run_kp_turn(ctx, services, toolset, text, output_review=review)
        for entry in result.tool_trace:
            for dice_event in _dice_events(entry, name, i18n):
                await hub.publish(ctx.chat_key, dice_event)
        for entry in result.tool_trace:
            npc_event = _npc_event(entry, i18n)
            if npc_event is not None:
                await hub.publish(ctx.chat_key, npc_event)
        await hub.publish(ctx.chat_key, Event.narrative(speaker="kp", text=result.reply, fmt="markdown"))
        await _record_usage_stats(services, ctx, result.usage)

        if ctx.platform != "companion":
            await _run_companion_director(hub, services, ctx, command_router, censor, result.reply)

    await publish_state(hub, services, ctx)
    return result


async def _kp_enabled(services: Services, chat_key: str) -> bool:
    """Whether the AI Keeper answers non-command messages in this room.

    Reads the SAME store flag `.bot on/off` writes (`bot_enabled.{chat_key}` --
    see `gateway.commands.cmd_bot_toggle` and `GatewayRunner._bot_enabled`);
    only an explicit "0" mutes the KP, so existing rooms keep today's behavior.
    """
    value = await services.store.get(user_key="", store_key=f"bot_enabled.{chat_key}")
    return value != "0"


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


async def _record_usage_stats(services: Services, ctx: AgentCtx, usage: Usage) -> None:
    """Best-effort persist this turn's token/cache usage as a rolling per-room aggregate.

    Stored at `usage_stats.{ctx.chat_key}` -- `net.state.build_room_state` reads it
    back as the `state.usage` snapshot field. Skips entirely when `usage` is
    all-zero (a provider-error turn, an exhausted `max_rounds` fallback, or a
    `FakeLLM`-backed test turn never carries real usage -- see `agent.loop`), so a
    turn that produced no usage data can't zero out an otherwise-healthy meter.

    Shape: `{"last": {...THIS turn's counts + context_window}, "session": {...running
    sums across every turn recorded so far + a turn counter}}`. A missing or corrupt
    prior aggregate just starts the session sums fresh rather than failing the turn.
    """
    if usage.total_tokens == 0 and usage.prompt_tokens == 0:
        return

    key = f"usage_stats.{ctx.chat_key}"
    session = {"prompt": 0, "completion": 0, "cache_hit": 0, "cache_miss": 0, "turns": 0}
    try:
        raw = await services.store.get(user_key="", store_key=key)
        prior = json.loads(raw) if raw else {}
        prior_session = prior.get("session") if isinstance(prior, dict) else None
        if isinstance(prior_session, dict):
            for field_name in session:
                session[field_name] = int(prior_session.get(field_name, 0) or 0)
    except Exception:
        # Corrupt/missing prior aggregate: start this session's sums fresh rather
        # than losing the turn.
        session = {"prompt": 0, "completion": 0, "cache_hit": 0, "cache_miss": 0, "turns": 0}

    session["prompt"] += usage.prompt_tokens
    session["completion"] += usage.completion_tokens
    session["cache_hit"] += usage.cache_hit_tokens
    session["cache_miss"] += usage.cache_miss_tokens
    session["turns"] += 1

    payload = {
        "last": {
            "prompt": usage.prompt_tokens,
            "completion": usage.completion_tokens,
            "cache_hit": usage.cache_hit_tokens,
            "cache_miss": usage.cache_miss_tokens,
            "context_window": context_window_for(services.settings.llm.chat_model),
        },
        "session": session,
    }
    try:
        await services.store.set(user_key="", store_key=key, value=json.dumps(payload, ensure_ascii=False))
    except Exception:
        logger.warning("usage_stats: failed to persist for chat_key=%s", ctx.chat_key, exc_info=True)


async def publish_state(hub: RoomHub, services: Services, ctx: AgentCtx) -> None:
    """Build a caller-correct room snapshot for every connected member.

    Overlays the live connection count and per-party ``online`` flags from the
    hub's current membership (a presence concern the read-only
    ``net.state.build_room_state`` deliberately leaves at ``0``/``True``).
    """
    members = hub.members(ctx.chat_key)

    def member_ctx(member: Member) -> AgentCtx:
        return AgentCtx(
            chat_key=ctx.chat_key,
            user_id=str(getattr(member, "state_user_id", None) or getattr(member, "id", "")),
            platform=str(getattr(member, "transport", ctx.platform)),
            locale=str(getattr(member, "locale", ctx.locale)),
            fs=ctx.fs,
        )

    identity_contexts: list[tuple[AgentCtx, str]] = []
    for member in members:
        identities = getattr(member, "state_identities", ())
        if identities:
            for user_id, name in identities:
                identity_contexts.append(
                    (
                        AgentCtx(
                            chat_key=ctx.chat_key,
                            user_id=str(user_id),
                            platform=str(getattr(member, "transport", ctx.platform)),
                            locale=str(getattr(member, "locale", ctx.locale)),
                            fs=ctx.fs,
                        ),
                        str(name),
                    )
                )
        else:
            identity_contexts.append((member_ctx(member), str(getattr(member, "name", ""))))

    async def active_name(identity: tuple[AgentCtx, str]) -> str:
        identity_ctx, fallback = identity
        sheet = await resolve_active_character(services, identity_ctx)
        return sheet.name if sheet is not None else fallback

    connected_names = set(
        await asyncio.gather(*(active_name(identity) for identity in identity_contexts))
    )
    online = len({identity_ctx.uid() for identity_ctx, _name in identity_contexts})

    async def event_for(member: Member) -> Event:
        snapshot = await _state_for_ctx(
            hub,
            services,
            member_ctx(member),
            members=members,
            connected_names=connected_names,
            online=online,
        )
        return Event.state(snapshot)

    await hub.publish_each(ctx.chat_key, event_for)


async def _state_for_ctx(
    hub: RoomHub,
    services: Services,
    ctx: AgentCtx,
    *,
    members: list[Member] | None = None,
    connected_names: set[str] | None = None,
    online: int | None = None,
) -> dict[str, Any]:
    members = hub.members(ctx.chat_key) if members is None else members
    connected_names = (
        {getattr(member, "name", "") for member in members}
        if connected_names is None
        else connected_names
    )
    snapshot = await build_room_state(services, ctx)
    snapshot["online"] = len(members) if online is None else online
    for party_member in snapshot.get("party", []):
        party_member["online"] = party_member.get("name") in connected_names
    return snapshot


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


def _dice_events(entry: dict[str, Any], actor: str, i18n: I18n) -> list[Event]:
    """Build public dice events, preferring payloads bound during tool dispatch."""
    if entry.get("keeper_only"):
        return []

    payloads = entry.get("dice_payloads")
    if isinstance(payloads, list) and payloads:
        events: list[Event] = []
        arguments = entry.get("arguments") or {}
        for raw_payload in payloads:
            if not isinstance(raw_payload, dict):
                continue
            fields = dict(raw_payload)
            kind = str(fields.pop("kind", ""))
            payload_actor = fields.pop("actor", "")
            if not kind or "total" not in fields:
                continue
            rank = fields.get("rank")
            if isinstance(rank, int) and "level" not in fields:
                fields["level"] = coc_rank_label(rank, i18n)
            events.append(
                Event.dice(
                    actor=str(
                        payload_actor
                        or arguments.get("actor")
                        or arguments.get("name")
                        or actor
                    ),
                    kind=kind,
                    **fields,
                )
            )
        # A tool that emitted structured data never falls back to parsing its
        # localized text, even if a malformed payload was defensively skipped.
        return events

    legacy = _dice_event(entry, actor, i18n)
    return [legacy] if legacy is not None else []


def _dice_event(entry: dict[str, Any], actor: str, i18n: I18n) -> Event | None:
    """Legacy best-effort dice event reconstructed from localized tool text.

    Retained for older/custom dice tools that did not call ``ctx.emit_dice``.
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
    return Event.dice(
        actor=str(arguments.get("actor") or arguments.get("name") or actor),
        kind=kind,
        **fields,
    )


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
