"""The AI-KP multi-round function-calling loop.

Per the M1 spec (``docs/specs/M1.md`` §6.5), one player turn is driven as:
build the system prompt, replay a capped window of prior turn history from
the store, then repeatedly call ``services.llm.chat(...)`` with the
toolset's schemas attached. Every round that comes back with tool calls is
dispatched through ``toolset.dispatch`` and fed back as ``role="tool"``
messages (recorded to ``tool_trace`` for auditing/tests); the first round
that comes back with no tool calls supplies the final reply. If
``max_rounds`` is exhausted without ever reaching a plain-text reply, one
tools-disabled finalizer narrates the already-committed public tool results.
Only if that finalizer fails is a localized deterministic fallback used.

Only the user message and the final assistant reply are persisted back to
history — never the intermediate tool-call chatter — so replayed history
stays lean across turns. A keeper-only tool's raw result is recorded in
``tool_trace`` for inspection, but it only ever enters the conversation as a
``role="tool"`` message; it is never surfaced as-is as ``reply`` (the model
must transform it first, per the keeper-secrecy discipline block the system
prompt carries — see ``agent/prompt_builder.py``).

=====================================================================
THE MAP — read this before changing anything below
=====================================================================

This module is the most paid-for code in the repo: nearly every block below
exists because a live session broke without it, and the fix's reason is in
the comment next to it. The line-level comments say WHY each piece is there;
this section says HOW THE PIECES FIT, which is the thing a reader cannot
recover from any one of them. Do not split this file for readability alone
(owner ruling 2026-08-19): the pieces are kept together because their ORDER
is the contract.

How one turn runs (``run_kp_turn``), in order — every step depends on the
ones above it:

 1. Reset per-turn residue on the (reused) ``AgentCtx``: dice payloads, NPC
    lines, ``hook_injections`` / ``clock_advances`` / ``variable_writes``.
 2. Fire the ``turn_start`` hook BEFORE prompt assembly — its injections and
    variable writes must shape this very prompt.
 3. Adopt legacy history (``migrate_legacy_blob``), then run the routine
    chronicle fold (``maybe_fold_chronicle``) — also BEFORE assembly, so the
    emergency ceiling keeps headroom for the fold's own generation.
 4. Fix this turn's tool catalog ONCE: ``unlocked`` (skills), ``phase``
    (prep/play), ``capabilities`` (room stores), ``room_pack`` subsystem
    tools. Every schema build and every dispatch this turn uses the same
    four values, so what is offered and what is refused can never disagree.
 5. Assemble the prompt (``_assemble_base``): stable head as ONE system
    message with a cache breakpoint; replayed history (trimmed to what the
    fold has absorbed); the volatile state tail as a USER message headed as
    engine state; the player line. One assembler, one object (iron rule #5);
    two wire slots for cache behavior (M20 A1).
 6. Stamp ``turn_index`` (= completed turns + 1, the same stamp chronicle
    records use), heal a crashed prior attempt's dangling leaf (NOT inside a
    companion sub-turn), write down the hook injections (M23 WS3), and
    persist the PLAYER message NOW — so a nested companion turn appends its
    exchange between the player's line and the reply, the order the table saw.
 7. The round loop: ``chat`` → if tool calls, ``_dispatch_and_record`` and go
    again; else the content is the reply. A context overflow — refusal OR a
    reply truncated at the window — folds once and retries ONCE
    (``_recover_from_overflow``); any other provider error returns a
    localized diagnosis WITHOUT persisting the turn (the player line is
    abandoned back off the path).
 8. End-of-turn checks (``_run_turn_checks``): the pack-declared Stop-form
    table, re-verified after every re-ask, bounded by
    ``MAX_ROUNDS_PER_TURN``; a tool round inside a check is not the end
    (the narration that reads the real roll is).
 9. If ``max_rounds`` ran out with no plain reply: one tools-disabled
    finalizer over the public committed results, else the deterministic
    fallback.
10. Reply post-processing, in THIS order: MVU ``<UpdateVariable>`` blocks
    applied + stripped (deterministic code does the bookkeeping) → text-shaped
    tool calls stripped → reply hooks (``apply``/``reply`` phases) →
    ``output_review`` (the censor sees final text) → stream gate drained.
11. Persist the reply, advance the chronicle counter, photograph the room for
    undo (``capture_snapshot`` AFTER the counter, so snapshot ``turn_index``
    is the end-of-turn state), fill an estimated prompt size if the provider
    reported none. The post-turn Scribe/Director later refreshes the *latest*
    chronicle-turn snapshot (``agent.scribe_coord``), not this turn's index —
    companion sub-turns will have moved the counter.

Invariants a change here must keep (each one was paid for — see the comment
at the site, and ``docs/defensive-patterns.md``):

 * ``messages`` is mutated IN PLACE for the whole turn and never rebound: the
   provider's continuation state (``_clear_llm_continuation``) is keyed by the
   list's identity. The overflow rebuild splices (``messages[:] = ...``).
 * Cache breakpoints are wire-only marks on COPIES; the persisted chain never
   carries ``CACHE_BREAKPOINT_KEY``. Exactly one breakpoint rides the newest
   tool result (``_move_in_turn_breakpoint``); calls that leave the main
   prefix (checks, finalizer) strip the marks.
 * The overflow retry is at most once per KP turn and only if the fold FOLDED
   something — no progress, no retry (the ping-pong guard). The retry is
   budgeted as +1 round, not as a tool round.
 * Provider errors never crash a turn and never persist one; cancellation
   (``asyncio.CancelledError``) always releases continuation state before it
   propagates.
 * Tool calls in one round run concurrently only inside a RUN of calls that
   cannot touch the same document: ``read_only`` tools, and tools declaring
   ``concurrent_by=<arg>`` whose keys differ (``speak_as_npc`` by ``npc``; its one
   shared write, the intent note, takes a per-room lock). Any other writer is a
   barrier, and ``companion_act`` — a nested turn — always is. Recording and
   publishing stay in CALL order; only the execution overlaps
   (``_concurrency_groups``, ``capture_npc_lines``).
 * The stream gate is fail-closed: text leaves for the client only once it can
   no longer become part of a machinery/MVU block; a tool round's draft is
   discarded; the final ``narrative`` frame is authoritative. Streaming the
   final draft happens BEFORE the check lane so a corrective roll can close it.
 * Tool results are capped (``MAX_TOOL_RESULT_CHARS``) and the cut is ANNOUNCED
   to the model — a silent cut makes it answer from half a document.
 * Nothing here is a new model-call lane: the turn's budget is
   ``AGENTS.md`` "Per-turn model-call budget", pinned by
   ``tests/agent/test_turn_call_budget.py``. The check runner's calls are
   deliberately NOT folded into the headline usage.
 * Hook failures never break a turn; hook emissions are capped
   (``MAX_PANEL_EVENTS_PER_TURN``).
 * ``ctx.platform == "companion"`` marks a NESTED turn: no dangling-leaf heal,
   no Scribe/Director (those guards live in ``gateway/turn.py`` and
   ``gateway/director.py``), and it deliberately does NOT take the room's
   turn lock — that is what keeps it from self-deadlocking.

Traps (things that look like small improvements and are not):

 * "This round also needs to do one small thing" — a new per-turn step goes
   in the phase list above or in ``agent/turn_checks`` (the declarative
   table), not as a sixth ad-hoc branch in the round loop.
 * Folding the check runner's usage into ``turn_usage`` (it is a bounded
   repair pass, and the meter drives the fold).
 * Re-ordering step 11: the reply is persisted FIRST (it carries this turn's
   stamp), the counter advances SECOND, the undo snapshot is taken LAST
   (before the counter it would be named one turn off).
 * Reading a chronicle/turn index AFTER ``run_kp_turn`` returns by re-reading
   the counter — take it from ``KPTurnResult.turn`` (M21 trap).
 * Re-ordering step 10: the censor must see what the player will see.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from agent.chronicle import (
    advance_chronicle_turn,
    chronicle_turn,
    fold_for_overflow,
    maybe_fold_chronicle,
    summary_through_turn,
)
from agent.context import AgentCtx, capture_npc_lines
from agent.history import (
    DEFAULT_HISTORY_KEY,
    abandon_message,
    append_message,
    heal_dangling_leaf,
    load_chain,
    migrate_legacy_blob,
    trim_folded,
)
from agent.hook_runtime import apply_hook_writes, load_room_hook_engine, record_hook_injections
from agent.kp_tools_subsystems import dispatch_subsystem, subsystem_schemas
from agent.prompt_builder import build_system_prompt_parts
from agent.services import Services
from agent.tool_phase import room_capabilities, room_phase
from agent.tool_trace import record_tool_call, tool_trace_enabled
from agent.tools import Toolset
from agent.turn_checks import (
    MAX_ROUNDS_PER_TURN,
    TurnState,
    dice_tool_names,
    rolled_values,
    scene_title_lines,
    turn_checks_for,
)
from agent.undo import capture as capture_snapshot
from core.chronicle import estimate_tokens
from core.hooks import MAX_PANEL_EVENTS_PER_TURN
from core.mvu_compat import mvu_apply_text
from core.rulepacks import RulePack
from core.skills import unlocked_tools_for
from infra.i18n import t
from infra.llm import CACHE_BREAKPOINT_KEY, ChatResult, Usage
from infra.llm_errors import is_context_overflow, is_context_overflow_stop
from infra.model_call_trace import lane_scope, set_lane_field
from infra.usage_stats import record_context_overflow

logger = logging.getLogger(__name__)

# A model occasionally writes a TOOL CALL as literal text instead of using the
# function-calling channel — foreign-harness XML dialects were observed live
# (2026-08-06: a `<Deep><use><name>mcp__…` block, its fake kp_note args carrying
# keeper-side meta into the player-visible reply). Machinery-shaped blocks are
# never legitimate narration and their payloads can hold keeper-only reasoning,
# so any wrapper that contains tool-call markers is stripped WHOLE, content
# unseen — the same fail-closed stance as the ST template scrub.
_TEXT_TOOL_CALL_WRAPPER_RE = re.compile(
    r"<(Deep|use|tool_call|tool_use|function_call|function_calls|invoke)\b[^>]*>.*?</\1\s*>",
    re.DOTALL | re.IGNORECASE,
)
_TEXT_TOOL_CALL_MARKER_RE = re.compile(
    r"<\s*(?:name|tool_name|args|arguments|parameter)\b|mcp__", re.IGNORECASE
)


# The FOUR coarse activity categories a room may be told a turn is in (protocol 2.3.1's
# optional `turn_status.activity`). Deliberately coarse and closed: a tool's own name or
# arguments would put keeper-side material on a room-wide frame, so the wire only ever
# carries which of these four buckets the round's first tool fell into.
ACTIVITY_READING = "reading"
ACTIVITY_DICE = "dice"
ACTIVITY_CAST = "cast"
ACTIVITY_BOOKKEEPING = "bookkeeping"


def tool_activity(tool_name: str) -> str:
    """Map one tool name to its coarse activity bucket. Anything unclassified is bookkeeping."""
    name = (tool_name or "").casefold()
    if name in {"query_lore", "module_brief"} or name.startswith(("get_", "list_", "search")):
        return ACTIVITY_READING
    if name == "roll_dice" or name.endswith("_check") or name.startswith("opposed"):
        return ACTIVITY_DICE
    if "npc" in name or "companion" in name:
        return ACTIVITY_CAST
    return ACTIVITY_BOOKKEEPING


def _strip_text_tool_calls(reply: str) -> str:
    """Remove tool-call-shaped machinery blocks a model wrote as plain text."""

    def _drop_if_machinery(match: re.Match[str]) -> str:
        return "" if _TEXT_TOOL_CALL_MARKER_RE.search(match.group(0)) else match.group(0)

    cleaned = _TEXT_TOOL_CALL_WRAPPER_RE.sub(_drop_if_machinery, reply)
    if cleaned == reply:
        return reply
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


# Tag-name prefixes that may open a machinery block (`_TEXT_TOOL_CALL_WRAPPER_RE`) or an
# MVU update block — while streaming, text is held from such an opener until it resolves.
_STREAM_SUSPECT_PREFIXES = (
    "deep", "use", "tool_call", "tool_use", "function_call", "function_calls", "invoke", "updatevariable",
)
_STREAM_TAG_RE = re.compile(r"\s*/?\s*([A-Za-z_][\w-]*)")


class _ReplyStreamGate:
    """Fail-closed incremental release of the in-progress reply.

    A leak cannot be streamed first and stripped later, so text leaves for the client
    only once it can no longer become part of a machinery/MVU block: everything from a
    plausible suspicious opener onward is HELD until the block closes (then dropped
    whole via `_strip_text_tool_calls`) or the round ends (unclosed suspicious tail
    dropped). The final `narrative` frame remains authoritative — clients replace the
    whole draft with it. Emission is coalesced and scheduled as ordered tasks so the
    provider's sync callback can feed the async transport."""

    def __init__(self, emit: Callable[[dict], Awaitable[None]]) -> None:
        self._emit = emit
        self._epoch = 0
        self._seq = 0
        self._pending = ""
        self._held = ""
        self._tasks: list[asyncio.Task] = []

    def begin_round(self) -> None:
        self._epoch += 1
        self._seq = 0
        self._pending = ""
        self._held = ""

    def feed(self, delta: str) -> None:
        self._held += delta
        self._release_safe()
        if len(self._pending) >= 48 or "\n" in self._pending:
            self._flush()

    def finish_round(self, *, discard: bool) -> None:
        """Round over: a tool round discards its draft (the client clears on the next
        epoch); a final round releases the held remainder through the full strip."""
        if discard:
            self._pending = ""
            self._held = ""
            return
        remainder = _strip_text_tool_calls(self._held)
        cut = self._suspect_hold_index(remainder)
        self._held = ""
        self._pending += remainder[:cut]
        self._flush()

    async def drain(self) -> None:
        for task in self._tasks:
            try:
                await task
            except Exception:
                logger.debug("reply-delta emit failed", exc_info=True)
        self._tasks.clear()

    def _suspect_hold_index(self, text: str) -> int:
        search = 0
        while True:
            idx = text.find("<", search)
            if idx == -1:
                return len(text)
            rest = text[idx + 1 :]
            if not rest.strip():
                return idx  # a trailing '<' could still become anything
            tag = _STREAM_TAG_RE.match(rest)
            if tag is None:
                search = idx + 1  # '<' into non-tag prose
                continue
            name = tag.group(1).lower()
            if any(name.startswith(p) or p.startswith(name) for p in _STREAM_SUSPECT_PREFIXES):
                return idx
            search = idx + 1

    def _release_safe(self) -> None:
        cut = self._suspect_hold_index(self._held)
        if cut < len(self._held):
            stripped = _strip_text_tool_calls(self._held)
            if stripped != self._held:
                self._held = stripped  # a machinery block completed and was dropped whole
                self._release_safe()
                return
        self._pending += self._held[:cut]
        self._held = self._held[cut:]

    def _flush(self) -> None:
        if not self._pending:
            return
        frame = {"epoch": self._epoch, "seq": self._seq, "text": self._pending}
        self._seq += 1
        self._pending = ""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._tasks.append(asyncio.ensure_future(self._emit(frame)))


@dataclass
class KPTurnResult:
    """One AI-KP turn's outcome."""

    reply: str  # final player-visible text (already `output_review`-ed)
    tool_trace: list[dict]  # [{name, arguments, keeper_only, result}, ...] in call order
    rounds: int  # how many function-calling rounds this turn took
    # The room turn index this result belongs to — the SAME index `append_turn`
    # stamped on this turn's history messages and `record_entry` stamps on a
    # chronicle record. 0 means no turn was committed (the provider-error early
    # return, which writes no history and never advances the counter).
    #
    # Anything recording against this turn AFTER `run_kp_turn` has returned must
    # take the index from here rather than re-reading the counter: by then the
    # counter has already advanced past this turn, and companion sub-turns advance
    # it further still. A record stamped ahead of the turn it summarises would let
    # `trim_folded` cut history no summary covers (M21).
    turn: int = 0
    # The persisted history record of `reply` ("" when no turn was committed). The gateway
    # stamps it on the live `narrative` it publishes (`Event.origin_id`), so a member's
    # join replay can tell that live frame from the persisted line it just replayed.
    reply_record_id: str = ""
    # Token/cache usage accumulated across this turn's main loop and, when
    # max_rounds is exhausted, its one tools-disabled finalizer. Provider-error
    # early returns stay all-zero; FakeLLM results without usage stay all-zero.
    usage: Usage = field(default_factory=Usage)
    # Validated emitUI() emissions from this turn's hooks, in fire order (turn_start
    # first, then the reply phases). Each dict is one protocol-v1.7 `ui` frame payload
    # ({blocks, panel, id?, replace?}) that `gateway.turn.run_turn` broadcasts right
    # after the KP narrative. Empty whenever hooks are inert.
    ui_frames: list[dict] = field(default_factory=list)
    # Validated emitPanel() emissions (protocol v1.8), capped per turn; each dict is one
    # `panel_event` payload ({panel, payload}) `gateway.turn.run_turn` delivers only to
    # viewers whose panel manifest contains that panel. Empty whenever hooks are inert.
    panel_events: list[dict] = field(default_factory=list)


async def run_kp_turn(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    user_message: str,
    *,
    history_key: str | None = None,
    user_record_id: str | None = None,
    max_rounds: int = 12,
    output_review: Callable[[str], str] | None = None,
    on_reply_delta: Callable[[dict], Awaitable[None]] | None = None,
    on_tool_event: Callable[[dict], Awaitable[None]] | None = None,
) -> KPTurnResult:
    """Drive one AI-KP turn to completion — see `_run_kp_turn_body` for the turn itself.

    This shell only names the lane for the operator's model-call probe
    (`infra.model_call_trace`): every call the body makes — rounds, finalizer, checks —
    reports as the Keeper's, with the room and whether this is a nested companion turn;
    the round index is stamped by the body as it advances. Actors voiced from inside a
    round open their own scope and restore this one.
    """
    with lane_scope("keeper", chat_key=ctx.chat_key, nested=True if ctx.platform == "companion" else None):
        return await _run_kp_turn_body(
            ctx,
            services,
            toolset,
            user_message,
            history_key=history_key,
            user_record_id=user_record_id,
            max_rounds=max_rounds,
            output_review=output_review,
            on_reply_delta=on_reply_delta,
            on_tool_event=on_tool_event,
        )


async def _run_kp_turn_body(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    user_message: str,
    *,
    history_key: str | None = None,
    user_record_id: str | None = None,
    max_rounds: int = 12,
    output_review: Callable[[str], str] | None = None,
    on_reply_delta: Callable[[dict], Awaitable[None]] | None = None,
    on_tool_event: Callable[[dict], Awaitable[None]] | None = None,
) -> KPTurnResult:
    """Drive one AI-KP turn to completion and return its `KPTurnResult`.

    `on_reply_delta`, if given, receives `{"epoch", "seq", "text"}` slices of the
    in-progress reply as the model generates it, released through the fail-closed
    `_ReplyStreamGate` (machinery/MVU blocks can never stream). A tool round's draft
    is discarded (clients clear on the next epoch); the final `reply` remains the
    authoritative text clients reconcile to.

    `on_tool_event`, if given, receives each `tool_trace` entry the moment it is
    recorded, so a transport can publish that tool's public consequences (a dice
    frame, an NPC's line) WHEN THEY HAPPEN. Reading them off the finished trace
    instead put them after the reply's streaming draft had already opened, so the
    table saw the Keeper's narration above the roll it was narrating — and below it
    on a turn that did not stream. Entries arrive in call order and the callback's
    failures are the caller's to swallow: nothing here waits on a transport.

    `history_key` defaults to the room_state key ``"chat_history"`` (room-scoped
    by the room_state table's room column). `output_review`, if given, post-processes the final reply (e.g.
    an M2 output censor) — it runs on the finalizer or fallback text too, if
    `max_rounds` was exhausted.
    """
    i18n = services.i18n.with_locale(ctx.locale)
    # AgentCtx instances may be reused by gateways. Never let a direct tool call
    # or an earlier turn's unconsumed dice payload attach to this turn's trace.
    ctx.consume_dice()
    ctx.consume_npc_lines()
    # The previous player turn's Scribe is fire-and-forget so its latency never
    # sits on that turn's already-streamed reply. This is the next *external*
    # KP turn, and whispers are consumed read-and-clear during prompt assembly
    # below — wait here, not at the transport choke point (that path also
    # admits `.undo` / reset, which must cancel the chain rather than wait
    # for it). Companion sub-turns skip: they are not a new external turn and
    # the parent has not even scheduled its pass yet.
    if ctx.platform != "companion":
        from agent.scribe_coord import scribe_runtime

        await scribe_runtime.take_external_turn(ctx.chat_key)
    # Event hooks (Layer C — core.hooks): one sandboxed engine per turn, inert (None) when
    # nothing is registered. turn_start fires BEFORE prompt assembly so its inject() texts and
    # variable writes shape this very turn; every later phase fires in the finalization block
    # below. Hook failures never break a turn (each fire is internally fail-safe).
    hook_engine = await load_room_hook_engine(services, ctx)
    hook_writes_this_turn: list[str] = []
    hook_ui_frames: list[dict] = []
    hook_panel_events: list[dict] = []
    ctx.extra.pop("hook_injections", None)  # reused ctx must not leak a prior turn's injections
    ctx.extra.pop("clock_advances", None)  # same for a prior turn's unconsumed clock records
    ctx.extra.pop("variable_writes", None)  # and a prior turn's keeper-tool variable writes
    # This turn's player message doubles as the worldbook retrieval context —
    # `agent.prompt_builder` reads `extra["user_message"]` for `worldbook.match`. Nothing
    # else ever wrote this key, which left live-play lorebook injection retrieving against
    # an empty context (found by the 2026-08-05 imported-card play-test): imported cards'
    # keyword entries could never fire outside archived-session recaps.
    ctx.extra["user_message"] = user_message
    if hook_engine is not None:
        outcome = hook_engine.fire("turn_start", {"user_message": user_message, "actor": ctx.user_id})
        hook_writes_this_turn += await apply_hook_writes(services, ctx.chat_key, outcome.writes)
        hook_ui_frames += outcome.ui_blocks
        hook_panel_events += outcome.panel_events
        if outcome.injections:
            ctx.extra["hook_injections"] = outcome.injections
    key = history_key or DEFAULT_HISTORY_KEY
    await migrate_legacy_blob(services, ctx.chat_key, key)
    # M18 campaign chronicle: the context-pressure fold runs BEFORE prompt assembly —
    # measured from last turn's usage meter, an over-trigger (or over-ceiling) room
    # folds its oldest chronicle records into the rolling campaign summary before this
    # turn's model call, so the emergency ceiling always has headroom for the fold
    # generation itself. It needs `key` because what a fold FREES is the replayed
    # history `trim_folded` then drops — hence the key's computation (and the legacy
    # adoption that fills the tree) sits above it. Best-effort: never raises; a no-op
    # when disabled, when no meter exists yet (a room's first turn), or under the trigger.
    routine_fold = await maybe_fold_chronicle(ctx, services, history_key=key)
    # Layer B.2 -- allowed-tools enforcement (docs/plugins.md "Layer B"): the union
    # of `allowed_tools` across every KP skill enabled for this room. With no
    # skills enabled (or none of them declaring gated tools) this is `set()`, so
    # `toolset.schemas()`/`toolset.dispatch()` behave exactly as before gating
    # existed -- see `Toolset.schemas`'s docstring.
    unlocked = await unlocked_tools_for(services.store, ctx.chat_key)
    # M20 B tool phasing: a room in PLAY drops the bulk/low-frequency half of the toolset
    # (module-grade authoring, imports, exports). Same filter family as gating, applied
    # once here and threaded through every schema build and dispatch this turn so the two
    # can never disagree. See `agent.tool_phase` for where the phase comes from.
    phase = await room_phase(services.store, ctx.chat_key)
    # …and what this ROOM actually has behind those tools: a world-card room has no
    # module knowledge pool, so the five pool-backed tools could only ever fail there.
    # Same filter family, same once-per-turn threading (see `agent.tool_phase`).
    capabilities = await room_capabilities(services.documents, ctx.chat_key)
    # Stage D tool materialization: the room's rulepack declares which subsystem
    # tools exist here (a system that declares none materializes none), and their
    # schemas ride alongside the static toolset for this turn.
    room_pack = await services.room_rulepack(ctx)
    subsystem_tools = subsystem_schemas(room_pack)

    # M20 A2: history is APPEND-ONLY between folds — the sliding window is gone, because
    # dropping its front every turn invalidated every downstream cache prefix. The one
    # truncation point is the chronicle fold: what the rolling summary has absorbed
    # (`through_turn`) is exactly what history no longer needs to replay, and the fold's
    # own no-future watermark (M18's 4-turn lag) guarantees recent turns are never cut.
    # Set right after the first assembly (below); read by every later rebuild.
    own_user_record_id = ""

    async def _assemble_base(*, advance_timers: bool) -> list[dict]:
        """This turn's prompt prefix: stable head, replayed history, state, player line.

        ONE assembler, ONE object (iron rule #5) — but two wire slots (M20 A1). The stable
        head rides the system message; the volatile tail becomes a `state` message directly
        before the player's, so the prefix through the end of history stays byte-identical
        between folds instead of being invalidated every turn by the tail.
        `_lw_cache_breakpoint` is agent->adapter metadata marking each boundary: the
        Anthropic path turns it into a `cache_control` breakpoint, the OpenAI-compatible
        path strips it and caches by prefix on its own. It never reaches a vendor's wire
        (`infra.llm.wire_messages`).

        A closure because M23 WS2 rebuilds it once more mid-turn, after a context-overflow
        recovery fold: that fold moves BOTH halves — the summary inside the stable head and
        the history its new watermark stops replaying — so a retry reusing the old prefix
        would resend the same oversized prompt minus nothing.
        """
        parts = await build_system_prompt_parts(ctx, services, advance_timers=advance_timers)
        chain = await load_chain(services, ctx.chat_key, key)
        # This turn's own player message is persisted the moment the first assembly is
        # done (see below), so a REBUILD (the context-overflow recovery) reads it back
        # off the chain — and appends `user_message` itself, as the first pass did. Cut
        # the chain at the persisted copy: the rebuilt prefix is then the one the first
        # pass built (nothing this turn appended after it — a companion's exchange —
        # belongs in the prefix; those rounds ride behind `base_len`, where they were).
        if own_user_record_id:
            ids = [message.get("_lw_id") for message in chain]
            if own_user_record_id in ids:
                chain = chain[: ids.index(own_user_record_id)]
        chain = await trim_folded(
            services, ctx.chat_key, key, chain, await summary_through_turn(services, ctx.chat_key)
        )
        base: list[dict] = []
        if parts.stable:
            base.append({"role": "system", "content": parts.stable, CACHE_BREAKPOINT_KEY: True})
        # Marked on a COPY: `chain` itself is what gets persisted back, and a wire-only
        # breakpoint mark has no business in the store.
        base.extend([*chain[:-1], {**chain[-1], CACHE_BREAKPOINT_KEY: True}] if chain else [])
        if parts.volatile:
            # A user-role message, not a second system one: mid-conversation system messages
            # are model- and vendor-specific, while every provider path here takes a user
            # turn unchanged. The header names it as engine state so the Keeper never reads
            # the state dump as something a player said.
            base.append(
                {"role": "user", "content": i18n.t("prompt.state_header") + "\n\n" + parts.volatile}
            )
        base.append({"role": "user", "content": user_message})
        return base

    # The turn now in flight — completed turns + 1, the same stamp `record_entry` uses,
    # so a history message and a chronicle record made this turn carry the same index.
    # A recovery fold does NOT move it: it changes what is replayed, not what turn this is.
    turn_index = await chronicle_turn(services.store, ctx.chat_key) + 1
    # A previous attempt at this very turn that crashed after persisting its player
    # message (stamped this same index — the counter never advanced) left the path
    # ending on it: abandon it now, so this turn chains after the last COMPLETED one.
    # NOT from inside a companion sub-turn: that runs while the OUTER turn is in flight,
    # whose player message is legitimately the leaf and carries this same stamp — a
    # nested heal would throw the player's own line off the path.
    if ctx.platform != "companion":
        await heal_dangling_leaf(services, ctx.chat_key, key, turn=turn_index)

    # M23 WS3: what the hooks injected reaches the model from process memory, so it is
    # written down BEFORE assembly — otherwise the one segment of this prompt that no
    # persisted row explains disappears with the process.
    await record_hook_injections(
        services, ctx.chat_key, turn_index, list(ctx.extra.get("hook_injections") or [])
    )
    # Mutated in place for the whole turn — `clear_continuation` owns provider state keyed
    # by this list's identity, so the recovery rebuild splices rather than rebinds.
    messages: list[dict] = await _assemble_base(advance_timers=True)
    # The player's message is persisted NOW, the reply at the end: a nested turn run
    # from inside this one (a companion's, via `gateway.director`) then appends its own
    # exchange BETWEEN them on the path — the order the table saw. Written at the end
    # together, the companion's line preceded the action that prompted it for anyone
    # replaying, and every roll of this turn had no record to sit after until it closed.
    own_user_record_id = await append_message(
        services, ctx.chat_key, key, role="user", content=user_message, turn=turn_index, record_id=user_record_id
    )
    # Where the prefix ends and this turn's tool chatter begins.
    base_len = len(messages)
    # The recovery retry is once per KP turn, full stop: a second overflow after a fold
    # that did fold something is not a fold problem, and re-folding on it would be the
    # ping-pong this guard exists to make structurally impossible.
    overflow_retried = False

    tool_trace: list[dict] = []
    reply: str | None = None
    rounds = 0
    # Accumulated across MAIN loop rounds and the max-rounds finalizer. The end-of-turn
    # check runner (`_run_turn_checks`, below) makes its own `services.llm.chat` calls but
    # deliberately does NOT fold them in here: it is a bounded, best-effort repair pass,
    # not part of what a context% meter should describe as "this turn's usage".
    turn_usage = Usage()
    gate = _ReplyStreamGate(on_reply_delta) if on_reply_delta is not None else None
    # Built once: `unlocked` and `phase` are fixed for the turn, so every round sends
    # the same catalog — and the meter's estimate fallback below has to size the same
    # bytes the rounds actually sent.
    round_tools = [*toolset.schemas(unlocked, phase=phase, capabilities=capabilities), *subsystem_tools]

    async def _recover_from_overflow() -> bool:
        """Fold once because the provider says this prompt is at the window; retry?

        True means the caller should re-issue the SAME round: records were folded, so the
        rebuilt prompt is genuinely smaller. False means nothing folded — the caller must
        report the failure rather than send an identical request and get an identical
        answer. Marks the turn either way, so the retry happens at most once whichever of
        the two triggers fired (a refusal, or a reply truncated at the window).
        """
        nonlocal overflow_retried, base_len, allowed_rounds
        overflow_retried = True
        # Record it even though the call reported no usage at all. Otherwise the meter
        # keeps showing the last SUCCESSFUL turn's reading — a number the provider has
        # just contradicted — and the next turn walks into the same wall.
        await record_context_overflow(
            services.store,
            ctx.chat_key,
            model=services.settings.llm.chat_model,
            context_window=services.settings.llm.context_window,
        )
        fold = await fold_for_overflow(
            ctx, services, history_key=key, batches_spent=routine_fold.batches
        )
        if not fold.entries_folded:
            return False
        # The retry is budgeted as its own call (AGENTS.md: "+ 1 overflow retry"), not as
        # one of the tool rounds. Raising the bound by exactly one keeps that arithmetic
        # true in code — and keeps the promise when the overflow lands on the LAST round,
        # which would otherwise fall through to the tools-disabled finalizer.
        allowed_rounds = max_rounds + 1
        logger.warning(
            "context overflow: folded %d chronicle record(s) and retrying the call once",
            fold.entries_folded,
        )
        if gate is not None:
            # The failed (or truncated) call may already have streamed a partial draft;
            # clients clear on the next epoch, so discard this one. The next loop iteration
            # opens a fresh round.
            gate.finish_round(discard=True)
        # The conversation genuinely changed underneath any provider-side continuation
        # state, so retire it before re-sending.
        _clear_llm_continuation(services, messages)
        tail = messages[base_len:]
        # Not a new turn: the worldbook's sticky/cooldown windows already ticked for it
        # when the prompt was first assembled.
        rebuilt = await _assemble_base(advance_timers=False)
        messages[:] = [*rebuilt, *tail]
        base_len = len(rebuilt)
        return True

    allowed_rounds = max_rounds
    round_index = 0
    while round_index < allowed_rounds:
        round_index += 1
        rounds = round_index
        set_lane_field(round=round_index)
        if gate is not None:
            gate.begin_round()
        try:
            result = await _chat_with_continuation_cleanup(
                services,
                messages,
                tools=round_tools,
                tool_choice="auto",
                temperature=services.settings.llm.temperature,
                on_text_delta=gate.feed if gate is not None else None,
            )
        except Exception as exc:
            # M23 WS2 — the provider's refusal is the one meter that cannot lie. When it
            # says the prompt is too long (`infra.llm_errors`, strict by construction),
            # fold and try ONCE more. Both this and the truncation above route through
            # `_recover_from_overflow`, which retries only if the fold actually folded
            # records: no progress, no retry, so a room with nothing left to fold reports
            # the error immediately instead of ping-ponging with the provider.
            if not overflow_retried and is_context_overflow(exc) and await _recover_from_overflow():
                continue
            # A real provider error (network/rate-limit/auth/SDK) must degrade to a friendly,
            # localized diagnosis (or the generic unavailable fallback), never crash the turn.
            # We return early WITHOUT persisting history (nothing useful happened this turn).
            # `usage` stays the default all-zero `Usage()` -- nothing usable came back.
            logger.warning("KP turn aborted: LLM chat failed", exc_info=True)
            category = getattr(exc, "category", "")
            code = getattr(exc, "code", "")
            if code in {"subscription_relogin_required", "subscription_refresh_failed"}:
                category = "auth"
            message_key = {
                "transient": "loop.provider_transient",
                "auth": "loop.provider_auth",
                "quota": "loop.provider_quota",
                "content": "loop.provider_content",
            }.get(category, "loop.unavailable")
            reply = i18n.t(message_key)
            _clear_llm_continuation(services, messages)
            if output_review is not None:
                reply = output_review(reply)
            # A failed turn commits nothing: the player message persisted at the start
            # goes off the path again (it stays in the tree), as it did before it was
            # ever written early. Whoever rejoins sees the last COMPLETED turn. (When a
            # companion already spoke inside this turn the leaf has moved past the
            # message — that exchange DID happen and stays; only then does the line stay
            # with it, as its parent.)
            await abandon_message(services, ctx.chat_key, key, own_user_record_id)
            return KPTurnResult(
                reply=reply,
                tool_trace=tool_trace,
                rounds=rounds,
                ui_frames=hook_ui_frames,
                panel_events=_capped_panel_events(hook_panel_events, ctx.chat_key),
            )

        # M23 WS2 — the quiet half of the same failure. Claude 4.5 and later stop
        # GENERATING at the window instead of refusing the call: HTTP 200, a narration that
        # ends mid-sentence, and a turn that would otherwise be persisted and narrated
        # onward from as if it were whole. Outside the `try` on purpose: a failure inside
        # the recovery is not a provider error and must not be reported as one.
        if not overflow_retried and is_context_overflow_stop(result) and await _recover_from_overflow():
            continue

        _accumulate_usage(turn_usage, result)

        if result.tool_calls:
            if gate is not None:
                gate.finish_round(discard=True)
            # Coarse progress for a long turn: which KIND of work this round opened with,
            # and which round it is. The first call sets the round's character; the bucket
            # is all that leaves this function (see `tool_activity`).
            await ctx.report_activity(tool_activity(result.tool_calls[0].name), round_index)
            try:
                await _dispatch_and_record(
                    toolset,
                    ctx,
                    services,
                    result,
                    messages,
                    tool_trace,
                    unlocked,
                    phase=phase,
                    capabilities=capabilities,
                    room_pack=room_pack,
                    hook_engine=hook_engine,
                    on_tool_event=on_tool_event,
                )
            except (asyncio.CancelledError, Exception):
                _clear_llm_continuation(services, messages)
                raise
            continue

        if gate is not None:
            gate.finish_round(discard=False)
            # The final round's draft is on the wire BEFORE the check lane may act on
            # it: a corrective roll from that lane must find the draft open so it can
            # close it (gateway.turn `_emit_tool_event`) — the order "roll, then the
            # corrected narration" is then the same whether the provider streams
            # synchronously (the fake) or truly asynchronously.
            await gate.drain()
        reply = result.content or ""
        break

    # M20 C: one declarative table of end-of-turn checks, in pure Stop form — the gate
    # refuses to end the turn and feeds the reason back; the model corrects itself. Every
    # condition is structural (what the dice really produced, what state the turn really
    # wrote); nothing here reads the fiction or guesses at the player's intent. Skipped
    # entirely on the max_rounds fallback (reply is still None) and after a provider error
    # (returned early above).
    if reply is not None:
        reply = await _run_turn_checks(
            ctx,
            services,
            toolset,
            messages,
            tool_trace,
            reply,
            i18n,
            unlocked,
            phase=phase,
            capabilities=capabilities,
            room_pack=room_pack,
            subsystem_tools=subsystem_tools,
            hook_engine=hook_engine,
            temperature=services.settings.llm.temperature,
            on_tool_event=on_tool_event,
        )

    if reply is None:  # max_rounds exhausted without ever reaching a plain-text reply
        try:
            reply = await _run_max_rounds_finalizer(
                services,
                messages,
                tool_trace,
                i18n,
                turn_usage,
                temperature=services.settings.llm.temperature,
                gate=gate,
            )
        except asyncio.CancelledError:
            _clear_llm_continuation(services, messages)
            raise
        if reply is None:
            reply = _max_rounds_fallback(tool_trace, i18n)

    _clear_llm_continuation(services, messages)
    # MVU compatibility (imported SillyTavern cards whose scaffolding instructs the model to
    # emit <UpdateVariable> text blocks): parse the blocks, apply their commands to the room's
    # MVU variable tree through validated deterministic code, and strip the blocks from the
    # player-visible narration — the upstream extension's contract, with real code doing the
    # bookkeeping. A reply with no blocks comes back byte-identical. Best-effort: a parse/apply
    # problem must never eat the narration. Runs BEFORE output_review so the censor sees final text.
    mvu_applied: list = []
    try:
        reply, mvu_applied, _mvu_errors = await mvu_apply_text(services.documents, ctx.chat_key, reply)
    except Exception:
        logger.warning("MVU update-block processing failed", exc_info=True)
    reply = _strip_text_tool_calls(reply)

    if hook_engine is not None:
        reply, hook_writes_this_turn, reply_ui_frames, reply_panel_events = await _run_reply_hooks(
            services, ctx, hook_engine, reply, tool_trace, mvu_applied, hook_writes_this_turn
        )
        hook_ui_frames += reply_ui_frames
        hook_panel_events += reply_panel_events
    if output_review is not None:
        reply = output_review(reply)

    if gate is not None:
        await gate.drain()
    reply_record_id = await append_message(
        services, ctx.chat_key, key, role="assistant", content=reply, turn=turn_index
    )
    # M18: count the completed turn — chronicle entries stamp against this counter
    # and the fold's no-future watermark derives from it. Best-effort bookkeeping.
    await advance_chronicle_turn(services.store, ctx.chat_key)
    # M20 D: the turn boundary is where a rewind can land, so it is where the room's
    # non-append-only half is photographed. AFTER the counter advances, so the snapshot
    # named `turn_index` is the state as of the END of that turn. Best-effort.
    await capture_snapshot(services, ctx.chat_key, turn_index)
    _fill_estimated_prompt_tokens(turn_usage, messages, round_tools)

    return KPTurnResult(
        reply=reply,
        tool_trace=tool_trace,
        rounds=rounds,
        turn=turn_index,
        reply_record_id=reply_record_id,
        usage=turn_usage,
        ui_frames=hook_ui_frames,
        panel_events=_capped_panel_events(hook_panel_events, ctx.chat_key),
    )


def _fill_estimated_prompt_tokens(turn_usage: Usage, messages: list[dict], tools: list[dict]) -> None:
    """Size this turn's prompt ourselves when the provider reported nothing, in place.

    Some endpoints simply never report usage on a streamed call — they ignore
    `stream_options`, or the operator turned it off. The tempting answer is to leave
    the meter empty, and that is exactly what made this a bug: an absent meter reads
    as `(0, 0)` to `agent.chronicle._read_meter`, a zero window short-circuits the
    fold, and the room's history never trims — including at the 0.85 emergency level.
    "No number" is the one answer the fold cannot act on, so a rough number beats it.

    Sized in `core.chronicle.estimate_tokens`, which is CJK-aware and is the unit the
    fold's own cost model already speaks, over BOTH halves of what was actually sent:
    the final round's messages (the same last-wins semantics `_accumulate_usage` gives
    a measured reading) and the JSON tool catalog, which is a large fixed share of
    every KP prompt and would otherwise be invisible. It is still only a rough count,
    and rough in both directions — it sees no per-message framing or vendor preamble,
    while a heuristic tuned to be safe on CJK can outrun a vendor's own tokenizer. So
    it is never quietly passed off as a measurement: `Usage.estimated` rides with it
    into the store, and the fold refuses to compare it against a measured reading.

    A no-op the moment any round reported a real prompt count, so a provider that
    reports usage never sees this path at all.
    """
    if turn_usage.prompt_tokens > 0:
        return
    total = sum(estimate_tokens(str(message.get("content") or "")) for message in messages)
    if tools:
        total += estimate_tokens(json.dumps(tools, ensure_ascii=False))
    turn_usage.prompt_tokens = total
    turn_usage.total_tokens = total + turn_usage.completion_tokens
    turn_usage.estimated = True


def _accumulate_usage(turn_usage: Usage, result: ChatResult) -> None:
    """Fold one main-loop round's `ChatResult.usage` into the turn's running total, in place.

    `completion_tokens` SUMS across rounds (each round produced genuinely new
    completion tokens). `prompt_tokens`/`total_tokens`/`cache_hit_tokens`/
    `cache_miss_tokens` are LAST-WINS -- the latest round's numbers describe the
    full current context (prior turns + this round's tool chatter), which is what
    a context% meter wants, not a sum. A no-op when `result.usage` is `None`
    (every `FakeLLM` result, and any real provider call `parse_usage` couldn't
    make sense of), so `turn_usage` stays all-zero exactly like before this
    feature existed.
    """
    if result.usage is None:
        return
    turn_usage.completion_tokens += result.usage.completion_tokens
    turn_usage.prompt_tokens = result.usage.prompt_tokens
    turn_usage.total_tokens = result.usage.total_tokens
    turn_usage.cache_hit_tokens = result.usage.cache_hit_tokens
    turn_usage.cache_miss_tokens = result.usage.cache_miss_tokens


def _clear_llm_continuation(services: Services, messages: list[dict]) -> None:
    """Release optional provider state after a conversation list is retired."""
    clear = getattr(services.llm, "clear_continuation", None)
    if callable(clear):
        try:
            clear(messages)
        except Exception:
            logger.debug("LLM continuation cleanup failed", exc_info=True)


async def _chat_with_continuation_cleanup(
    services: Services,
    messages: list[dict],
    *,
    tools: list[dict],
    tool_choice: str | dict,
    temperature: float | None,
    on_text_delta: Callable[[str], None] | None = None,
) -> ChatResult:
    """Call the LLM and release list-owned state if the turn is cancelled."""
    try:
        return await services.llm.chat(
            messages,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            on_text_delta=on_text_delta,
        )
    except asyncio.CancelledError:
        _clear_llm_continuation(services, messages)
        raise


def _correction_base_messages(messages: list[dict]) -> list[dict]:
    """Copy durable context without this turn's provider-specific tool chatter."""
    return [
        message
        for message in messages
        if message.get("role") != "tool"
        and not (message.get("role") == "assistant" and message.get("tool_calls"))
    ]


def _without_cache_marks(messages: list[dict]) -> list[dict]:
    """Copies with every cache breakpoint stripped — for a call that leaves the main prefix.

    A breakpoint only pays for itself when the same prefix comes back. A one-shot call that
    differs from the turn's other calls in a way that invalidates caching anyway — the
    max-rounds finalizer sends `tools=[]`, and on Anthropic the tool list sits ahead of
    everything, so nothing downstream of it can hit — would otherwise buy a 1.25x cache
    WRITE it never reads.
    """
    return [
        {key: value for key, value in message.items() if key != CACHE_BREAKPOINT_KEY}
        if CACHE_BREAKPOINT_KEY in message
        else message
        for message in messages
    ]


def _move_in_turn_breakpoint(conversation: list[dict]) -> None:
    """Keep exactly one cache breakpoint on the NEWEST tool result (M20 A, breakpoint 3 of 4).

    Everything after the end-of-history breakpoint — the state message, the player's line,
    and every tool round accumulated so far — is recomputed on each of up to `max_rounds`
    calls. A breakpoint that moves forward with the tool loop makes round N+1 read what
    round N wrote, and keeps the distance back to the previous entry short: a breakpoint
    searches only a bounded window of preceding content blocks for one, and a long tool
    loop pushes the end-of-history mark out of that window.

    Older in-turn marks are cleared as it moves, so the request carries at most three
    breakpoints (stable head, end of history, newest tool result) against a limit of four.
    """
    newest: dict | None = None
    for message in conversation:
        if message.get("role") != "tool":
            continue
        message.pop(CACHE_BREAKPOINT_KEY, None)
        newest = message
    if newest is not None:
        newest[CACHE_BREAKPOINT_KEY] = True


def _public_committed_results(tool_trace: list[dict], i18n) -> str:
    """Render public tool results while structurally excluding keeper-only data."""
    lines = [
        i18n.t(
            "loop.max_rounds_result",
            name=str(entry.get("name", "")),
            result=str(entry.get("result", "")).strip(),
        )
        for entry in tool_trace
        if not entry.get("keeper_only", False)
    ]
    return "\n".join(lines) if lines else i18n.t("loop.max_rounds_no_public_results")


def _max_rounds_fallback(tool_trace: list[dict], i18n) -> str:
    """Build a deterministic fallback that explicitly preserves public outcomes."""
    return "\n\n".join(
        [
            i18n.t("loop.max_rounds"),
            f'{i18n.t("loop.max_rounds_committed")}\n{_public_committed_results(tool_trace, i18n)}',
        ]
    )


async def _run_max_rounds_finalizer(
    services: Services,
    messages: list[dict],
    tool_trace: list[dict],
    i18n,
    turn_usage: Usage,
    *,
    temperature: float | None,
    gate: _ReplyStreamGate | None = None,
) -> str | None:
    """Narrate committed public results once, with tools disabled.

    The finalizer starts from durable context with all assistant tool-call and
    role=tool messages removed. Its only result block is rebuilt from
    non-keeper-only trace entries, so hidden tool output cannot enter this
    closing call or its deterministic fallback.

    This call PRODUCES the player-visible reply on every tool-heavy turn, so it
    streams through the same `gate` as an ordinary final round — without it, the
    turns that take the longest are exactly the ones the player watches arrive
    as one late block.
    """
    convo = [
        # Tools are disabled for this one call, which on Anthropic invalidates every
        # cache layer beneath them — so the marks would buy writes nothing reads.
        *_without_cache_marks(_correction_base_messages(messages)),
        {
            "role": "user",
            "content": i18n.t(
                "loop.max_rounds_finalize",
                results=_public_committed_results(tool_trace, i18n),
            ),
        },
    ]
    if gate is not None:
        gate.begin_round()
    set_lane_field(round="finalizer")
    try:
        result = await _chat_with_continuation_cleanup(
            services,
            convo,
            tools=[],
            tool_choice="none",
            temperature=temperature,
            on_text_delta=gate.feed if gate is not None else None,
        )
    except asyncio.CancelledError:
        # `_chat_with_continuation_cleanup` already retired `convo`.
        raise
    except Exception:
        logger.warning("max-rounds finalizer failed", exc_info=True)
        _clear_llm_continuation(services, convo)
        if gate is not None:
            gate.finish_round(discard=True)
        return None

    _clear_llm_continuation(services, convo)
    _accumulate_usage(turn_usage, result)
    if gate is not None:
        gate.finish_round(discard=False)
    return result.content.strip() if result.content and result.content.strip() else None


def _assistant_tool_call_message(result: ChatResult) -> dict:
    """Render an assistant turn's tool calls in the OpenAI message shape."""
    message = {
        "role": "assistant",
        "content": result.content,
        "tool_calls": [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": json.dumps(call.arguments, ensure_ascii=False)},
            }
            for call in result.tool_calls
        ],
    }
    if result.provider_blocks is not None:
        # Same-turn faithful replay (Anthropic thinking blocks must accompany their
        # assistant turn); never persisted — history keeps only user text + final reply.
        message["provider_blocks"] = result.provider_blocks
    return message


def _schemas_for_tool_names(
    toolset: Toolset,
    unlocked: set[str] | None,
    names: frozenset[str],
    *,
    phase: str | None = None,
    capabilities: set[str] | None = None,
) -> list[dict]:
    """Return schemas for the named tools that are available in this turn."""
    schemas = []
    for schema in toolset.schemas(unlocked, phase=phase, capabilities=capabilities):
        try:
            name = schema["function"]["name"]
        except (KeyError, TypeError):
            continue
        if name in names:
            schemas.append(schema)
    return schemas


def _normalize_tool_arguments(call_name: str, arguments: dict | None) -> dict:
    """Drop provider-injected optional sentinels that carry no semantic value."""
    normalized = dict(arguments or {})
    if call_name != "skill_check":
        return normalized
    actor = normalized.get("actor")
    if actor is None or (isinstance(actor, str) and not actor.strip()):
        normalized.pop("actor", None)
        npc_target = normalized.get("npc_target")
        if npc_target is None or npc_target == "" or (
            isinstance(npc_target, (int, float)) and npc_target == 0
        ):
            normalized.pop("npc_target", None)
    return normalized


async def _dispatch_and_record(
    toolset: Toolset,
    ctx: AgentCtx,
    services: Services,
    result: ChatResult,
    conversation: list[dict],
    tool_trace: list[dict],
    unlocked: set[str] | None = None,
    *,
    phase: str | None = None,
    capabilities: set[str] | None = None,
    room_pack: RulePack | None = None,
    hook_engine=None,
    on_tool_event: Callable[[dict], Awaitable[None]] | None = None,
) -> None:
    """Dispatch one assistant round's tool calls, feeding results back into `conversation` + `tool_trace`.

    Shared by the main loop and the end-of-turn check runner so both record the trace
    identically. Mutates `conversation` and `tool_trace` in place. `unlocked` (Layer B.2 --
    see `Toolset.dispatch`) is the room's set of unlocked gated-tool names; `None`/empty
    means no gated tool is callable.

    Calls in one round are split, IN ORDER, into runs that may overlap
    (`_concurrency_groups`): a run holds only calls that cannot touch the same document —
    tools flagged `read_only`, and tools declaring `concurrent_by=<arg>` whose keys differ
    (an NPC's line is voiced from its own record alone, so two different NPCs are
    independent; the same NPC twice is not). Both flags have to be explicit: a tool's
    signature says nothing about whether it writes, and two writers racing on one document
    is a lost update, not a speedup. Every other writer is a barrier between runs, and
    `companion_act` (a nested turn) always is. A run of one dispatches serially, with the
    initiative de-duplication that only makes sense in call order. Recording and publishing
    happen in CALL order for every run, so the trace, the conversation and the room see the
    same sequence the model issued; only the execution overlapped. Each concurrent call's
    NPC lines are captured per task (`capture_npc_lines`) so they stay bound to that call.
    """
    for call in result.tool_calls:
        call.arguments = _normalize_tool_arguments(call.name, call.arguments)
    conversation.append(_assistant_tool_call_message(result))
    for group in _concurrency_groups(toolset, result.tool_calls):
        if len(group) > 1:
            outcomes = await asyncio.gather(
                *(
                    _dispatch_captured(
                        toolset, ctx, services, call, tool_trace, unlocked, phase, capabilities, room_pack, hook_engine
                    )
                    for call in group
                )
            )
            for call, (tool_result, suppressed, lines) in zip(group, outcomes, strict=True):
                entry = _record_call(
                    toolset, ctx, call, tool_result, suppressed, conversation, tool_trace, npc_lines=lines
                )
                await _announce_tool_event(on_tool_event, entry)
            continue
        call = group[0]
        duplicate_initiative_next = (
            call.name == "initiative_tracker"
            and (call.arguments or {}).get("action") == "next"
            and any(
                entry.get("name") == "initiative_tracker"
                and (entry.get("arguments") or {}).get("action") == "next"
                for entry in tool_trace
            )
        )
        suppressed = False
        if duplicate_initiative_next:
            tool_result = t("kp_tools.initiative.next_already_committed", locale=ctx.locale)
            suppressed = True
        else:
            tool_result, suppressed = await _dispatch_one(
                toolset, ctx, services, call, tool_trace, unlocked, phase, capabilities, room_pack, hook_engine
            )
        entry = _record_call(toolset, ctx, call, tool_result, suppressed, conversation, tool_trace)
        await _announce_tool_event(on_tool_event, entry)
    _move_in_turn_breakpoint(conversation)


def _concurrency_groups(toolset: Toolset, calls: list) -> list[list]:
    """Split one round's calls, in order, into runs whose members may execute together.

    A call joins the current run when it is `read_only`, or when it carries a
    `concurrency_key` nobody in the run has; a call with a key the run already holds
    starts a new run; a call with neither (a plain writer, an unknown tool, a nested turn)
    is a run of its own and a barrier for what follows. Order within and across runs is
    the model's call order — the caller records in that order too.
    """
    groups: list[list] = []
    current: list = []
    keys: set[tuple[str, str]] = set()
    for call in calls:
        independent = toolset.is_read_only(call.name)
        key = None if independent else toolset.concurrency_key(call.name, call.arguments)
        if not independent and key is None:
            if current:
                groups.append(current)
                current, keys = [], set()
            groups.append([call])
            continue
        if key is not None and key in keys:
            groups.append(current)
            current, keys = [], set()
        current.append(call)
        if key is not None:
            keys.add(key)
    if current:
        groups.append(current)
    return groups


async def _dispatch_captured(
    toolset: Toolset,
    ctx: AgentCtx,
    services: Services,
    call,
    tool_trace: list[dict],
    unlocked: set[str] | None,
    phase: str | None,
    capabilities: set[str] | None,
    room_pack: RulePack | None,
    hook_engine,
) -> tuple[str, bool, list[dict[str, str]]]:
    """`_dispatch_one` for a concurrent run: the NPC lines it emits come back WITH its
    result instead of landing in the shared `ctx.npc_lines`, where the first call recorded
    would otherwise consume every concurrent sibling's lines as its own. Dice payloads are
    NOT captured: nothing eligible for a concurrent run rolls (readers by definition, voices
    by the actor's own rule) — a keyed tool that ever does must capture them the same way."""
    with capture_npc_lines() as lines:
        tool_result, suppressed = await _dispatch_one(
            toolset, ctx, services, call, tool_trace, unlocked, phase, capabilities, room_pack, hook_engine
        )
    return tool_result, suppressed, lines


async def _dispatch_one(
    toolset: Toolset,
    ctx: AgentCtx,
    services: Services,
    call,
    tool_trace: list[dict],
    unlocked: set[str] | None,
    phase: str | None,
    capabilities: set[str] | None,
    room_pack: RulePack | None,
    hook_engine,
) -> tuple[str, bool]:
    """Run one tool call through the hook veto, then the pack subsystems, then the toolset.

    Also the seam the operator's tool trace (`agent.tool_trace`, off by default) hangs
    off: every model-issued call — a veto, a subsystem tool, a `Toolset` tool or its
    refusal — passes through here with the room and the phase in hand.
    """
    started = time.perf_counter()
    denial = _hook_tool_veto(hook_engine, ctx, call)
    if denial is not None:
        tool_result, suppressed = denial, True
    else:
        tool_result = (
            await dispatch_subsystem(services, ctx, room_pack, call.name, call.arguments)
            if room_pack is not None
            else None
        )
        if tool_result is None:
            tool_result = await toolset.dispatch(
                call.name, ctx, call.arguments, unlocked, phase=phase, capabilities=capabilities
            )
        suppressed = False
    if tool_trace_enabled():
        record_tool_call(
            chat_key=ctx.chat_key,
            phase=phase,
            name=call.name,
            arguments=call.arguments,
            result=tool_result,
            keeper_only=toolset.is_keeper_only(call.name),
            started=started,
        )
    return tool_result, suppressed


def _hook_tool_veto(hook_engine, ctx: AgentCtx, call) -> str | None:
    """A hook's reason for refusing this call, or None to allow it.

    FAIL OPEN in every direction: no engine, no handler, a thrown handler, a QuickJS time
    limit — all of them allow. Every hook failure is internally harmless today (a broken
    handler loses its effects and the turn continues), and that property has to survive
    contact with the critical path: a hook that cannot run does not get to stop the game.
    The refusal itself reuses the same block-with-reason shape the end-of-turn checks use,
    so there is one mechanism for "the engine said no, here is why", not two.
    """
    if hook_engine is None:
        return None
    try:
        outcome = hook_engine.fire("tool_use", {"tool": call.name, "arguments": call.arguments or {}})
    except Exception:  # noqa: BLE001 — see docstring
        logger.debug("tool_use hook dispatch failed; allowing the call", exc_info=True)
        return None
    if not outcome.deny:
        return None
    logger.info("hook denied tool %s: %s", call.name, outcome.deny)
    return t("loop.tool_denied_by_hook", locale=ctx.locale, name=call.name, reason=outcome.deny)


def _record_call(
    toolset: Toolset,
    ctx: AgentCtx,
    call,
    tool_result: str,
    suppressed: bool,
    conversation: list[dict],
    tool_trace: list[dict],
    *,
    npc_lines: list[dict[str, str]] | None = None,
) -> dict:
    """Append one dispatched call to the trace and the conversation; return the entry.

    `npc_lines` are the lines a CONCURRENT call captured for itself; they go first, then
    whatever reached the shared buffer (a serial call's lines, or anything emitted outside
    a capture scope), so nothing is lost and nothing is attributed twice."""
    tool_result = _capped_tool_result(tool_result, ctx.locale)
    trace_entry = {
        "name": call.name,
        "arguments": call.arguments,
        "keeper_only": toolset.is_keeper_only(call.name),
        "result": tool_result,
    }
    if suppressed:
        trace_entry["suppressed"] = True
    dice_payloads = ctx.consume_dice()
    if dice_payloads:
        trace_entry["dice_payloads"] = dice_payloads
    npc_lines = [*(npc_lines or []), *ctx.consume_npc_lines()]
    if npc_lines:
        # Capped like the result string it used to ride in: an NPC line reaches the
        # wire and the replay lane, so an over-long one is cut the same way.
        trace_entry["npc_lines"] = [
            {"name": line.get("name", ""), "text": _capped_tool_result(str(line.get("text", "")), ctx.locale)}
            for line in npc_lines
        ]
    tool_trace.append(trace_entry)
    conversation.append({"role": "tool", "tool_call_id": call.id, "content": tool_result})
    return trace_entry


async def _announce_tool_event(
    on_tool_event: Callable[[dict], Awaitable[None]] | None, entry: dict
) -> None:
    """Hand one recorded trace entry to the transport, if it asked for them.

    Swallows everything short of cancellation: a transport that cannot publish a dice
    frame must not abort a turn whose engine state has already changed.
    """
    if on_tool_event is None:
        return
    try:
        await on_tool_event(entry)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — publishing is not part of resolving the turn
        logger.warning("tool event publish failed for %s", entry.get("name"), exc_info=True)


# One tool result may not dominate the context. A knowledge/worldbook return can be
# arbitrarily large, and it is fed back verbatim into a conversation that is then replayed
# for every remaining round of the turn. The cut is announced rather than silent: a model
# that cannot tell it was truncated will happily answer from half a document.
MAX_TOOL_RESULT_CHARS = 8_000


def _capped_tool_result(result: str, locale: str) -> str:
    text = result if isinstance(result, str) else str(result)
    if len(text) <= MAX_TOOL_RESULT_CHARS:
        return text
    return text[:MAX_TOOL_RESULT_CHARS] + "\n\n" + t("loop.tool_result_truncated", locale=locale, kept=MAX_TOOL_RESULT_CHARS)


async def _run_turn_checks(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    messages: list[dict],
    tool_trace: list[dict],
    reply: str,
    i18n,
    unlocked: set[str] | None = None,
    *,
    phase: str | None = None,
    capabilities: set[str] | None = None,
    room_pack: RulePack | None = None,
    subsystem_tools: list[dict] | None = None,
    hook_engine=None,
    temperature: float | None,
    on_tool_event: Callable[[dict], Awaitable[None]] | None = None,
) -> str:
    """Run this room's end-of-turn check table in pure Stop form; return the final reply.

    One runner over `(condition, instruction, round cap)` rows, replacing two hand-written
    corrective phases whose conditions were hard-coded in a rule-agnostic engine. See
    `agent.turn_checks` for the table, the conditions, and why the form is Stop rather
    than a forced tool call.

    Three properties are load-bearing:

    * **It re-verifies.** After every re-ask the condition is evaluated again on the NEW
      reply. Refusing to end the turn is only different from asking nicely because of this
      loop — a single nudge with no follow-up is the escape hatch the old design shipped.
    * **A tool round is not the end.** When the model answers by calling a tool (rolling
      the dice it forged), the loop keeps going for the narration that reads the real
      result. Breaking there would leave the invented numbers standing.
    * **The prefix is untouched.** `tools` and `tool_choice` stay exactly as the main loop
      sent them, so the checks — which run when the context is at its largest — read the
      same cached prefix instead of paying to recompute it.

    Best-effort throughout: any provider error keeps the reply as it stands. Its chat
    calls are deliberately NOT folded into the turn's headline usage.
    """
    convo = _correction_base_messages(messages)
    spent = 0
    for check in turn_checks_for(room_pack):
        awaiting_narration = False
        for _ in range(check.max_rounds):
            if spent >= MAX_ROUNDS_PER_TURN:
                return reply
            if not awaiting_narration and not check.holds(TurnState(reply=reply, tool_trace=tool_trace)):
                break
            instruction = check.instruction(
                i18n,
                ctx.locale,
                **_check_fields(check.id, reply, tool_trace, i18n),
            )
            convo = [*convo, {"role": "assistant", "content": reply}, {"role": "user", "content": instruction}]
            set_lane_field(round="check")
            try:
                result = await _chat_with_continuation_cleanup(
                    services,
                    convo,
                    tools=[*toolset.schemas(unlocked, phase=phase, capabilities=capabilities), *(subsystem_tools or [])],
                    tool_choice="auto",
                    temperature=temperature,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("turn check %s skipped: LLM chat failed", check.id, exc_info=True)
                _clear_llm_continuation(services, convo)
                return reply
            spent += 1
            if result.tool_calls:
                try:
                    await _dispatch_and_record(
                        toolset,
                        ctx,
                        services,
                        result,
                        convo,
                        tool_trace,
                        unlocked,
                        phase=phase,
                        capabilities=capabilities,
                        room_pack=room_pack,
                        hook_engine=hook_engine,
                        on_tool_event=on_tool_event,
                    )
                except (asyncio.CancelledError, Exception):
                    _clear_llm_continuation(services, convo)
                    raise
                awaiting_narration = True
                continue
            reply = result.content or reply
            awaiting_narration = False
    _clear_llm_continuation(services, convo)
    return reply


def _check_fields(check_id: str, reply: str, tool_trace: list[dict], i18n) -> dict[str, str]:
    """Per-check substitutions for an instruction's placeholders.

    Only what the model cannot see for itself: the real numbers it contradicted, and the
    heading it drew. Everything else the instruction needs is already in the conversation.
    """
    if check_id == "dice_contradicts":
        real = sorted(rolled_values(tool_trace))
        return {"rolled": ", ".join(str(value) for value in real)}
    if check_id == "stale_scene_hud":
        titles = scene_title_lines(reply)
        return {"title": titles[0] if titles else reply[:160]}
    return {}


async def _run_reply_hooks(
    services: Services,
    ctx: AgentCtx,
    engine,
    reply: str,
    tool_trace: list[dict],
    mvu_applied: list,
    hook_writes: list[str],
) -> tuple[str, list[str], list[dict], list[dict]]:
    """Fire the post-reply hook phases in order: dice_rolled (when any dice tool resolved this
    turn), clock_advanced (once per game-clock advance recorded by the clock tool this turn),
    reply_ready (narrate/rewrite), then variables_changed exactly once when anything
    wrote variables this turn. One round only — variables_changed's own writes do NOT re-fire
    it, so hook cascades terminate by construction. Best-effort: a failing phase logs and the
    reply passes through unchanged. The third/fourth return values collect every phase's
    validated emitUI() / emitPanel() emissions in fire order (protocol v1.7 `ui` frame
    payloads / v1.8 `panel_event` payloads)."""
    ui_frames: list[dict] = []
    panel_events: list[dict] = []
    try:
        rolls = [
            {"tool": item.get("name", ""), "result": str(item.get("result", ""))[:200]}
            for item in tool_trace
            if item.get("name") in dice_tool_names()
        ]
        if rolls:
            outcome = engine.fire("dice_rolled", {"rolls": rolls})
            hook_writes = hook_writes + await apply_hook_writes(services, ctx.chat_key, outcome.writes)
            ui_frames += outcome.ui_blocks
            panel_events += outcome.panel_events
            if outcome.narrations:
                reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)

        # Clock advances recorded by the game_clock tool this turn (capped at record time).
        for advance in list(ctx.extra.get("clock_advances") or []):
            if not isinstance(advance, dict):
                continue
            outcome = engine.fire(
                "clock_advanced",
                {
                    "from": str(advance.get("from", "")),
                    "to": str(advance.get("to", "")),
                    "delta": str(advance.get("delta", "")),
                },
            )
            hook_writes = hook_writes + await apply_hook_writes(services, ctx.chat_key, outcome.writes)
            ui_frames += outcome.ui_blocks
            panel_events += outcome.panel_events
            if outcome.narrations:
                reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)

        outcome = engine.fire("reply_ready", {"reply": reply})
        hook_writes = hook_writes + await apply_hook_writes(services, ctx.chat_key, outcome.writes)
        ui_frames += outcome.ui_blocks
        panel_events += outcome.panel_events
        if outcome.rewrite is not None:
            reply = outcome.rewrite
        if outcome.narrations:
            reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)

        changed = [{"path": path, "op": "set"} for path in hook_writes]
        changed += [
            {"path": str(command.get("path", "")), "op": str(command.get("op", ""))}
            for command in mvu_applied
            if isinstance(command, dict)
        ]
        # Keeper-tool writes (set_variable / adjust_variable / set_stat / adjust_stat) are
        # variable writes too — recorded on ctx.extra by `agent.kp_tools_vars` as they
        # succeed. Without them the event only ever saw hook and reply-embedded writes.
        changed += [
            {"path": str(write.get("path", "")), "op": str(write.get("op", "set"))}
            for write in list(ctx.extra.get("variable_writes") or [])
            if isinstance(write, dict) and write.get("path")
        ]
        if changed:
            outcome = engine.fire("variables_changed", {"writes": changed})
            await apply_hook_writes(services, ctx.chat_key, outcome.writes)
            ui_frames += outcome.ui_blocks
            panel_events += outcome.panel_events
            if outcome.narrations:
                reply = reply.rstrip() + "\n\n" + "\n".join(outcome.narrations)
    except Exception:
        logger.warning("reply-phase hooks failed", exc_info=True)
    return reply, hook_writes, ui_frames, panel_events


def _capped_panel_events(events: list[dict], chat_key: str) -> list[dict]:
    """Apply the per-TURN emitPanel budget across all phases: keep the head, drop + log
    the excess (the same "excess dropped + logged" stance as the other hook caps)."""
    if len(events) <= MAX_PANEL_EVENTS_PER_TURN:
        return events
    logger.warning(
        "hooks emitted %d panel events for %s; keeping the first %d",
        len(events),
        chat_key,
        MAX_PANEL_EVENTS_PER_TURN,
    )
    return events[:MAX_PANEL_EVENTS_PER_TURN]
