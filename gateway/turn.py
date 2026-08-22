"""Shared, transport-agnostic turn runner (M6 Phase 1).

`run_turn` is the one place a player's input becomes a sequence of normalized
:class:`~gateway.hub.Event` objects published to the room. It used to live
inline in ``net.tui_server.dispatch_input``; hoisting it here means *every*
transport (the terminal WS today, chat adapters later) drives the exact same
turn machinery — ``gateway.commands.CommandRouter`` for slash/dot commands,
``agent.loop.run_kp_turn`` for the AI-KP — and every member of the room, on
whatever transport, receives the same fan-out via ``hub.publish``.

The published order follows the fiction's own: ``player_action`` echo -> each tool's
public consequences AS IT RUNS (a ``dice`` event per roll, a ``narrative`` with speaker
``npc`` per ``speak_as_npc``) -> the ``narrative`` (speaker ``kp``) reply -> one ``ui``
event per hook-emitted UI frame (protocol v1.7) -> the room ``state`` snapshot. Those
tool events were once read off the FINISHED trace, which put them after the reply's
streaming draft had already opened — so a streaming turn showed the narration above the
roll it narrated and a non-streaming turn showed it below, same room, order decided by
the provider. They are also recorded as they happen (``record_turn_events``, anchored to
the transcript line they followed) so a member who joins or reconnects replays the same
scene — the same interleaving — rather than one with every roll missing. On a real
(non-command) AI-KP turn, the KP narrative is also followed by a best-effort
call into ``gateway.director.run_director`` (M10), which lets the party's AI
companions take an auto-paced turn (their own sub-turns fan out through this
same function) before the room ``state`` snapshot is published.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import TYPE_CHECKING, Any

from agent.context import AgentCtx
from agent.loop import KPTurnResult, run_kp_turn
from agent.scribe_coord import ScribeEpoch, refresh_latest_snapshot
from gateway.hub import Event
from gateway.ops import is_bot_enabled, room_content_unfiltered
from gateway.panels import deliver_panel_events
from gateway.ui_media import filter_ui_media
from infra.i18n import I18n, get_i18n
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet
from infra.usage_stats import record_usage_stats
from net.state import build_room_state, resolve_active_character

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from agent.services import Services
    from agent.tools import Toolset
    from gateway.commands import CommandRouter, CommandSpec
    from gateway.hub import Member, RoomHub
    from gateway.ops import Censor

# Strong refs used to live here as a GC keep-alive. The per-room coordinator
# (`agent.scribe_coord`) now owns the chain — tests and playtest drain through
# `scribe_runtime.await_idle`.


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
    model_authored: bool = False,
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

    ``model_authored=True`` marks a turn whose ``text`` is LLM-generated (a companion /
    director action), NOT human input. It bypasses the command router and the inline-roll
    fallback ENTIRELY -- model output must never reach a parser built for human input (it
    would let a generated ".party act X" recurse into the director, a ".bot off" flip room
    state with EVERYONE privilege, or an inline "[[1d6]]" silently swallow the KP turn) --
    and instead feeds ``text`` straight into the KP pipeline as pure narration/action, still
    publishing a ``player_action`` so the room can attribute the effect. Companion dice go
    ONLY through the KP toolset (``skill_check`` etc.), never via text pattern matching.

    A command turn whose matched ``gateway.commands.CommandSpec.private_reply`` is set
    (e.g. ``.model key``/``.lore query``, which can echo a masked API key or keeper-only
    secret lore) delivers its reply ONLY to ``origin`` via ``Member.deliver`` — never
    ``hub.publish`` — so the rest of the room never sees it. With no ``origin`` (a
    transport with no per-connection member) this falls back to the normal broadcast.

    On a real (non-command) AI-KP turn, once the KP's own narrative is published,
    this also best-effort records the turn's token/cache usage
    -- surfaced by ``net.state.build_room_state`` as ``state.usage`` -- and gives the
    party's AI companions (M10) a chance to auto-act via
    ``gateway.director.run_director`` — a no-op outside combat / with `.party auto`
    off, and, critically, ALWAYS a no-op when ``ctx.platform == "companion"`` (a
    companion's own turn re-enters this function and must never re-trigger the
    director — the structural anti-runaway `gateway.director` describes). A
    companion-pacing failure is logged and swallowed, never allowed to turn a
    successful player turn into a surfaced error. The post-turn Scribe pass
    carries the same ``ctx.platform != "companion"`` guard for the same reason:
    one PLAYER turn buys exactly one reconciliation pass, however large the party.
    """
    i18n = get_i18n(ctx.locale)
    name = actor_name or await _display_name(origin, ctx, services)
    extra = getattr(ctx, "extra", None)
    interaction_private = bool(
        isinstance(extra, dict) and extra.get("private_interaction")
    )

    result: KPTurnResult | None = None
    # The id the player line will be persisted under IF this becomes an AI-KP turn
    # (`run_kp_turn` writes it when the turn starts). Stamped on the live echo now, so a
    # member whose join replay reads that line back can tell the held echo from it.
    user_record_id = uuid.uuid4().hex
    action_event = Event.player_action(name=name, text=text)
    action_event.origin_id = user_record_id
    if model_authored:
        # This is the ONLY place non-human-authored text reaches run_turn: a
        # model-authored companion/director turn (see gateway.director.run_companion_turn),
        # where the "text" is an LLM-generated action/dialogue. The command router and the
        # inline-roll fallback are parsers built for HUMAN input ONLY, so model output MUST
        # NEVER reach them. If it did: a companion whose generated action happened to read
        # ".party act <name>" would re-enter gateway.director and recurse (holding the room
        # turn lock); a ".bot off"/".st"/".room link" would execute a level-0 command with
        # EVERYONE privilege straight from pure model output; and an inline "[[1d6]]" would
        # hit the inline-roll fallback and silently swallow the whole KP turn (the Keeper is
        # never consulted). So a model-authored turn ALWAYS publishes the player_action (so
        # the room can attribute the effect) and feeds the text straight into the KP pipeline
        # as pure narration/action. Companion dice happen ONLY through the KP toolset
        # (skill_check, ...), adjudicated by the Keeper, never via text pattern matching.
        matched_spec = None
        reply = None
        await hub.publish(ctx.chat_key, action_event, exclude=echo_exclude)
    else:
        matched_spec = _matched_command_spec(command_router, text, ctx.locale)
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
        public_events: list[Event] = []
        for event in command_events:
            if event.kind == "dice":
                # Commands record the stable user id; the room edge owns the active
                # character/platform display name used by every other turn event.
                event.data["actor"] = name
            event_origin_only = bool(
                event.private
                or interaction_private
                or (reply is not None and reply.error)
                or (matched_spec and matched_spec.private_reply)
            )
            if event_origin_only:
                event.private = True
                if origin is not None:
                    await origin.deliver(event)
            else:
                await hub.publish(ctx.chat_key, event)
                public_events.append(event)
        if public_events:
            # A typed roll is table content like any other: it joins the replay lane,
            # anchored to the message the transcript currently ends on (see
            # `record_turn_events`) — after the last narration, before the next.
            await record_turn_events(services, ctx.chat_key, public_events)
        # F16: a reply that says the command did NOT happen is feedback for whoever
        # typed it, never table content — and broadcasting one advertises the command's
        # existence, arguments and privilege gate to everyone. A 2026-08-07 session had
        # a player read the keeper's `.rule` error and start probing the console.
        command_failed = bool(reply is not None and reply.error)
        reply_event = Event.narrative(
            speaker="system",
            text=command_reply,
            fmt="plain",
            private=bool(
                interaction_private or command_failed or (matched_spec and matched_spec.private_reply)
            ),
        )
        origin_only = bool(
            interaction_private or command_failed or (matched_spec and matched_spec.private_reply)
        )
        if origin_only:
            # Sensitive keeper-command reply (masked API key / keeper-only secret lore /
            # a room join key): unicast to the invoking connection only, never broadcast.
            if origin is not None:
                await origin.deliver(reply_event)
        else:
            await hub.publish(ctx.chat_key, reply_event)
    else:
        # `.bot off` (gateway.commands.rooms.cmd_bot_toggle) mutes the AI Keeper for this
        # room: the player message above is still echoed to everyone (a human-Keeper
        # table keeps chatting, dice commands keep working), but no KP turn runs.
        # Unset defaults to ON — the hub/TUI table's existing behavior. The chat
        # adapters gate earlier, in `GatewayRunner.on_inbound`, with their own
        # per-platform defaults; this check makes the same switch real on the hub path.
        if not await _kp_enabled(services, ctx.chat_key):
            await publish_state(hub, services, ctx)
            return None
        # The session is the report's BOUNDARY — its start, its duration, and the dice
        # ledgers scoped to it — so a player's turn opens one rather than leaving the
        # room reportless until someone happens to roll. Nothing about the turn is
        # recorded here: the exchange itself lands in `chat_history` (agent.loop), and
        # that is what the report renders.
        role = extra.get("role") if isinstance(extra, dict) else None
        if ctx.platform != "companion" and role != "keeper":
            await services.battles.ensure_session_started(ctx.chat_key, i18n=i18n)
        # A room with a mature/explicit KP skill enabled (Layer B.1's mature-mode
        # gate — see `gateway.ops.room_content_unfiltered`) opts the output censor
        # OUT entirely for that room, regardless of the configured `Censor`; every
        # other room keeps today's behavior exactly.
        unfiltered = await room_content_unfiltered(services.store, ctx.chat_key)
        review = None if unfiltered else ((lambda value: censor.review(value).cleaned) if censor is not None else None)
        # Progress inside a long busy stretch: each tool round refreshes the room's `busy`
        # frame with a COARSE category and the round number (protocol 2.3.1). Gated on the
        # PLAYER-turn path for the same structural reason the Scribe and the Director are —
        # a companion sub-turn re-enters this function, and its rounds are not the table's
        # turn. `run_kp_turn` is the only caller of the sink (`agent.loop`).
        if ctx.platform != "companion":

            async def _publish_activity(activity: str, round_index: int) -> None:
                await hub.publish(
                    ctx.chat_key,
                    Event.turn_status("busy", actor=name, activity=activity, round_index=round_index),
                )

            ctx.activity_sink = _publish_activity
        await hub.begin_turn(ctx.chat_key, name)
        try:
            # Streaming narrative (docs/protocol.md 2.0): `narrative_delta` frames sharing
            # an id carry text deltas clients concatenate into a draft bubble; the ONE
            # closing `narrative` frame with the SAME id carries the full final text and
            # REPLACES the draft — post-generation corrections (dice-first, censor) simply
            # land in that final text, no supersede rules. Each loop epoch (one model
            # round) gets a fresh id, so a discarded tool-round draft never becomes the
            # final bubble.
            from net.session import new_id  # gateway->net seam; module-level would cycle

            stream_state = {"id": "", "epoch": 0}

            async def _emit_reply_delta(frame: dict) -> None:
                if frame["epoch"] != stream_state["epoch"]:
                    if stream_state["id"]:
                        # Every delta stream ends with a same-id narrative: close the
                        # abandoned tool-round draft with an empty final (clients drop it).
                        await hub.publish(
                            ctx.chat_key,
                            Event.narrative(speaker="kp", text="", fmt="markdown", frame_id=stream_state["id"]),
                        )
                    stream_state.update(id=new_id(), epoch=frame["epoch"])
                await hub.publish(
                    ctx.chat_key,
                    Event.narrative_delta(speaker="kp", text=frame["text"], frame_id=stream_state["id"]),
                )

            async def _emit_tool_event(entry: dict) -> None:
                """Publish one tool's public consequences AS IT HAPPENS.

                These used to be read off the finished trace after `run_kp_turn`
                returned — which put them after the streaming draft bubble had already
                opened, so a streaming turn showed the Keeper's narration ABOVE the roll
                it was narrating, and a non-streaming turn showed it below. Same frames,
                same room, order decided by whether the provider happened to stream.
                Publishing at the call site makes the log match the fiction's own order
                on every turn: the dice land, the NPC speaks, the narration closes.

                One rule keeps that order true in every lane: a public tool event NEVER
                lands under an open draft. A tool round's draft is discarded anyway (the
                next round re-streams); the end-of-turn check lane does not stream at
                all, so without this its corrective roll fell BELOW the already-open
                final draft and the corrected narration then replaced that draft in
                place — narration above the roll live, roll above the narration on
                replay. Closing the draft first (an empty final, which clients drop) and
                letting the final reply take a fresh id makes live and replay agree.
                """
                events = _public_tool_events(entry, name, i18n)
                if events and stream_state["id"]:
                    await hub.publish(
                        ctx.chat_key,
                        Event.narrative(speaker="kp", text="", fmt="markdown", frame_id=stream_state["id"]),
                    )
                    stream_state["id"] = ""
                for event in events:
                    await hub.publish(ctx.chat_key, event)
                # …and into the replay lane at the same moment, anchored to the message
                # the transcript currently ends on: this turn's own player line (persisted
                # when the turn started), or a companion's reply if one just spoke.
                # Recording as it happens is what lets a rejoin reproduce the interleaving
                # of rolls, NPC lines and companion turns exactly as the table saw it.
                await record_turn_events(services, ctx.chat_key, events)

            final_published = False
            try:
                result = await run_kp_turn(
                    ctx,
                    services,
                    toolset,
                    text,
                    output_review=review,
                    on_reply_delta=_emit_reply_delta,
                    on_tool_event=_emit_tool_event,
                    user_record_id=user_record_id,
                )
                # `frame_id` is the open draft's id (the final REPLACES the draft) or a
                # fresh one when no draft is open — the check lane closed it, or nothing
                # ever streamed. `origin_id` is the persisted reply's record (join replay).
                final = Event.narrative(
                    speaker="kp", text=result.reply, fmt="markdown", frame_id=stream_state["id"] or new_id()
                )
                final.origin_id = result.reply_record_id
                await hub.publish(ctx.chat_key, final)
                final_published = True
            finally:
                if stream_state["id"] and not final_published:
                    # The turn died mid-stream: close the draft bubble with a final
                    # frame so no client is left holding an open draft forever.
                    await hub.publish(
                        ctx.chat_key,
                        Event.narrative(speaker="kp", text="", fmt="markdown", frame_id=stream_state["id"]),
                    )
            # Hook-emitted declarative UI (protocol v1.7) rides right behind the
            # narrative it annotates, before the closing `state` snapshot. Image
            # blocks pass the reachability gate first: a hash this room cannot fetch
            # would render as a permanent broken picture (`gateway.ui_media`).
            for ui_frame in await filter_ui_media(services, ctx.chat_key, result.ui_frames):
                await hub.publish(ctx.chat_key, Event.ui(ui_frame))
            # Hook-emitted module-panel events (protocol v1.8) follow the same slot,
            # but are NOT a broadcast: each reaches only members whose own manifest
            # contains the target panel (gateway.panels.deliver_panel_events).
            if result.panel_events:
                await deliver_panel_events(hub, services, ctx.chat_key, result.panel_events)
            await record_usage_stats(
                services.store,
                ctx.chat_key,
                result.usage,
                model=services.settings.llm.chat_model,
                context_window=services.settings.llm.context_window,
            )

            if ctx.platform != "companion":
                await _run_companion_director(hub, services, ctx, command_router, censor, result.reply)
        finally:
            await hub.end_turn(ctx.chat_key)

    # Post-turn Scribe (agent.scribe): fire-and-forget bookkeeping reconciliation.
    # It runs AFTER the reply has already streamed (zero perceived latency); when
    # it lands tracker writes it republishes room state, so panels move within
    # seconds of the narration instead of freezing at their defaults. Its 场记 lane
    # additionally classifies the turn as a BEAT, which cues the Stage Director
    # (M19) — one extra call on beats only, never per turn.
    #
    # Gated on `ctx.platform != "companion"` for the SAME structural reason as the
    # director call-out above (and `gateway.director.run_director`'s own guard): a
    # companion's own turn re-enters this function, so without it one player turn
    # with N companions spent 1+N Scribe calls, reconciled the same trackers 1+N
    # times off the same narrated fact, and drained the keeper whisper channel
    # into its own sub-turns. The PLAYER turn's pass already sees the whole
    # exchange — the companions' beats are part of what it reads.
    if result is not None and ctx.platform != "companion" and services.settings.scribe.enabled:
        from agent.scribe_coord import scribe_runtime

        epoch = scribe_runtime.capture_epoch(ctx.chat_key)
        scribe_runtime.schedule(
            ctx.chat_key,
            lambda: run_scribe_pass(hub, services, ctx, text, result, snapshot_epoch=epoch),
        )

    await publish_state(hub, services, ctx)
    return result


async def run_scribe_pass(
    hub: RoomHub | None,
    services: Services,
    ctx: AgentCtx,
    text: str,
    result: KPTurnResult,
    *,
    snapshot_epoch: ScribeEpoch | None = None,
) -> None:
    """One post-turn Scribe pass — the SAME pass on every channel that runs real turns.

    The hub path wraps this in a fire-and-forget task (the reply has already streamed,
    so the latency is invisible); the standalone CLI path (`gateway.runner`) AWAITS it
    inline — a one-shot ``--exec`` process has no later moment to hide the latency in,
    and a task killed by process exit would silently lose the bookkeeping. That
    hubless channel was exactly how the CLI ran 12+ turns with zero chronicle records
    (k3 pipeline playtest, D2): the pass was never scheduled there at all.

    With ``hub=None`` the pass keeps everything durable (chronicle records, tracker
    reconciliation, whispers, habits) and skips only what speaks in wire frames: the
    state republish and the Stage Director, which stages `ui`/`audio` frames a
    hubless channel has nowhere to deliver (documented in docs/operating.md).

    Gated on ``ctx.platform != "companion"`` for the structural reason
    `gateway.director` describes: a companion's own turn re-enters the turn flow, and
    without the gate one player turn with N companions spent 1+N Scribe calls and
    drained the whisper channel into its own sub-turns. The PLAYER turn's pass
    already sees the whole exchange.
    """
    if ctx.platform == "companion" or not services.settings.scribe.enabled:
        return
    names = [str(entry.get("name", "")) for entry in result.tool_trace]
    try:
        from agent.scribe import run_scribe

        # `result.turn`, never the room's counter: this runs after the turn returned
        # (and after any companion sub-turns), so the counter has moved on. See
        # `KPTurnResult.turn` / `agent.chronicle.record_entry`.
        outcome = await run_scribe(services, ctx, text, result.reply, names, result.turn)
        if hub is not None:
            if outcome.changed:
                await publish_state(hub, services, ctx)
            if outcome.beat and services.settings.director.enabled:
                # The Director receives the PLAYER-VISIBLE turn — what was broadcast —
                # plus the beat KIND. Nothing keeper-side crosses this call; that is
                # the whole isolation contract (tests/architecture).
                from agent.stage_director import run_director

                await run_director(services, ctx, text, result.reply, beat=outcome.beat, hub=hub)
        # Refresh the LATEST boundary (current chronicle turn), not `result.turn`:
        # companion sub-turns have already photographed the later indexes. Skip
        # when a later external turn has begun assembling its prompt.
        await refresh_latest_snapshot(services, ctx.chat_key, epoch=snapshot_epoch)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — bookkeeping must never break the table
        logging.getLogger(__name__).debug("scribe pass failed", exc_info=True)


async def _kp_enabled(services: Services, chat_key: str) -> bool:
    """Whether the AI Keeper answers non-command messages in this room — the one
    `bot_enabled` reader, `gateway.ops.is_bot_enabled` (unset means ON)."""
    return await is_bot_enabled(services.store, chat_key)


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


async def publish_state(hub: RoomHub, services: Services, ctx: AgentCtx, *, reset: bool = False) -> None:
    """Build a caller-correct room snapshot for every connected member.

    Overlays the live connection count and per-party ``online`` flags from the
    hub's current membership (a presence concern the read-only
    ``net.state.build_room_state`` deliberately leaves at ``0``/``True``).

    ``reset=True`` marks the frame published right after a campaign wipe
    (``.reset`` / ``admin_reset_room``): the panel data in it is already fresh
    (empty), and the flag additionally tells clients to drop their locally
    accumulated chat scrollback, which the server can no longer replay away.
    """
    members = hub.members(ctx.chat_key)

    def member_ctx(member: Member) -> AgentCtx:
        # `extra["role"]` carries the connection's keystore-authenticated role (WsMember/Iroh
        # members; chat-adapter members have none → player view) so `net.state._variables`
        # can build each viewer's panel — same convention as `net.session._ctx_for`.
        return AgentCtx(
            chat_key=ctx.chat_key,
            user_id=str(getattr(member, "state_user_id", None) or getattr(member, "id", "")),
            platform=str(getattr(member, "transport", ctx.platform)),
            locale=str(getattr(member, "locale", ctx.locale)),
            fs=ctx.fs,
            extra={"role": str(getattr(member, "role", "") or "")},
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
        snapshot = await state_for_ctx(
            hub,
            services,
            member_ctx(member),
            members=members,
            connected_names=connected_names,
            online=online,
        )
        if reset:
            snapshot["reset"] = True
        return Event.state(snapshot)

    await hub.publish_each(ctx.chat_key, event_for)


async def state_for_ctx(
    hub: RoomHub,
    services: Services,
    ctx: AgentCtx,
    *,
    members: list[Member] | None = None,
    connected_names: set[str] | None = None,
    online: int | None = None,
) -> dict[str, Any]:
    """`ctx`'s own room snapshot (`net.state.build_room_state`) with the hub's presence
    overlaid — the frame `publish_state` sends each member, for one member. A command
    that wants to refresh its caller's HUD (`.panel`) attaches this as `Event.panel`."""
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


def _npc_events(entry: dict[str, Any], i18n: I18n) -> list[Event]:
    """The ``npc`` narrative events one tool call put in front of the table.

    Built ONLY from the lines the tool EMITTED (`AgentCtx.emit_npc_line`, recorded on
    the trace as `npc_lines`) — the same rule dice frames follow (`_dice_events`): never
    reconstructed from the tool's return string. `speak_as_npc` emits on its success path
    alone, so a hook's refusal (`suppressed`), an unknown-NPC error or a gated-tool notice
    is a tool RESULT the model reads, and structurally not something the NPC said. A
    keeper-only tool call has no public consequences at all.
    """
    if entry.get("keeper_only") or entry.get("suppressed"):
        return []
    lines = entry.get("npc_lines")
    if not isinstance(lines, list):
        return []
    events: list[Event] = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        text = str(line.get("text") or "")
        if not text.strip():
            continue
        events.append(
            Event.narrative(
                speaker="npc",
                name=str(line.get("name") or "").strip() or i18n.t("hub.npc.unknown_name"),
                text=text,
                fmt="markdown",
            )
        )
    return events


def _public_tool_events(entry: dict[str, Any], actor: str, i18n: I18n) -> list[Event]:
    """Everything ONE tool call puts in front of the whole table, in table order.

    The single definition of that, shared by the live publish and the replay record —
    two lists that drifted apart would show a reconnecting player a different scene
    than the one everyone else watched.
    """
    return [*_dice_events(entry, actor), *_npc_events(entry, i18n)]


# The public tool events of recent turns, kept for join replay. Windowed by TURN, not by
# event count: replay walks the last `net.session._HISTORY_REPLAY_CAP` (30) chat-history
# entries — about 15 turns, fewer with companion sub-turns — and a flat event cap cut at
# an arbitrary event offset, so a run of dice-heavy combat turns silently evicted older
# turns' rolls and truncated the oldest surviving turn mid-sequence, which reads as "only
# half of that turn was rolled". Forty turns covers the replay window with room to spare;
# the flat ceiling below is a safety net for a pathological turn, not the working bound.
TURN_EVENT_HISTORY_KEY = "turn_event_history"
TURN_EVENT_HISTORY_TURNS = 40
TURN_EVENT_HISTORY_CAP = 2000


def prune_turn_events(records: list[Any]) -> list[Any]:
    """The records that stay: every event of the newest `TURN_EVENT_HISTORY_TURNS` DISTINCT
    turns, under the flat safety ceiling. Malformed entries are dropped here rather than
    replayed.

    "Newest" is by APPEND ORDER, not by the largest turn number: records are written
    chronologically, `.undo` moves turn numbers back, and one imported record with an
    absurd `turn` must not evict everything else and then swallow every future write —
    it is one distinct turn among forty and ages out like any other.
    """
    turns: list[tuple[int, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        try:
            turns.append((int(record.get("turn", 0) or 0), record))
        except (TypeError, ValueError):
            continue
    recent: set[int] = set()
    for turn, _record in reversed(turns):
        if turn in recent:
            continue
        if len(recent) >= TURN_EVENT_HISTORY_TURNS:
            break
        recent.add(turn)
    kept = [record for turn, record in turns if turn in recent]
    return kept[-TURN_EVENT_HISTORY_CAP:]


async def record_turn_events(services: Any, chat_key: str, events: list[Event]) -> None:
    """Store public events so a joining member's replay can include them — anchored to
    the history message the transcript currently ends on (`agent.history.current_leaf`).

    Best-effort, and PUBLIC only: a private event is a unicast to one connection and has
    no place in a lane that is re-broadcast to whoever joins next.

    The anchor is a message ID, not a turn number: replay walks the persisted transcript
    and emits each anchored event right after its message, so a KP roll made before a
    companion spoke lands before the companion's line and one made after lands after it;
    a typed roll (`.ra`, `r 3d6`) anchors to the last reply; anything before the first
    turn anchors to the root (""). Turn numbers cannot carry that — a companion sub-turn
    advances the counter mid-turn, so two messages can share a stamp and a stamp can
    have no message. The turn IS kept on the record, for the lane's window.
    """
    public = [event for event in events if not event.private]
    if not public:
        return
    try:
        from agent.chronicle import chronicle_turn
        from agent.history import DEFAULT_HISTORY_KEY, current_leaf

        anchor = await current_leaf(services, chat_key)
        # The turn stamp (for the lane's window only): the anchor message's own — exact
        # both during a turn (its player line) and after it (its reply) — else the
        # completed-turn counter, before any message.
        anchor_record = await services.store.history_record(chat_key, DEFAULT_HISTORY_KEY, anchor)
        turn = (
            int(anchor_record.get("turn", 0) or 0)
            if anchor_record is not None
            else await chronicle_turn(services.store, chat_key)
        )
        payload = []
        for event in public:
            record_id = uuid.uuid4().hex
            # The published Event object is the one a joining member may be HOLDING right
            # now (`net.session`): stamping the record id on it is what lets that member
            # drop the held copy when its replay already emitted this very record.
            event.origin_id = record_id
            payload.append(
                {
                    "id": record_id,
                    "turn": turn,
                    "after_id": anchor,
                    "event": {
                        "kind": event.kind,
                        "speaker": event.speaker,
                        "name": event.name,
                        "text": event.text,
                        "fmt": event.fmt,
                        "data": event.data,
                    },
                }
            )
        raw = await services.store.state_get(chat_key, TURN_EVENT_HISTORY_KEY)
        history = json.loads(raw) if raw else []
        if not isinstance(history, list):
            history = []
        history.extend(payload)
        await services.store.state_set(
            chat_key,
            TURN_EVENT_HISTORY_KEY,
            json.dumps(prune_turn_events(history), ensure_ascii=False),
        )
    except Exception:  # noqa: BLE001 — a replay convenience must never break a turn
        logger.warning("turn: could not record public tool events for %s", chat_key, exc_info=True)


def _dice_events(entry: dict[str, Any], actor: str) -> list[Event]:
    """Build public dice events from the payloads bound during tool dispatch.

    Protocol 2.0: dice frames come ONLY from structured `ctx.emit_dice`
    payloads — the pre-2.0 fallback that re-parsed a tool's localized text to
    guess ranks is gone (a tool that emits no payload emits no dice frame).
    """
    if entry.get("keeper_only"):
        return []

    payloads = entry.get("dice_payloads")
    if not isinstance(payloads, list):
        return []
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
    return events


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="turn_events",
        owner="gateway.turn",
        # The public dice/NPC frames of recent turns: the same narrative session
        # `agent.history`'s conversation facet holds, in its wire form. A story reset
        # that kept them would replay rolls from a campaign the room just erased.
        reset_scope="story",
        state_keys=frozenset({TURN_EVENT_HISTORY_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
