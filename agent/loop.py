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
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from agent.chronicle import advance_chronicle_turn, chronicle_turn, maybe_fold_chronicle, summary_through_turn
from agent.context import AgentCtx
from agent.history import append_turn, load_chain, migrate_legacy_blob, trim_folded
from agent.hook_runtime import apply_hook_writes, load_room_hook_engine
from agent.kp_tools_subsystems import dispatch_subsystem, room_rulepack, subsystem_schemas
from agent.prompt_builder import build_system_prompt_parts
from agent.services import Services
from agent.session_recap import maybe_refresh_session_recap
from agent.tool_phase import room_phase
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
from core.hooks import MAX_PANEL_EVENTS_PER_TURN
from core.mvu_compat import mvu_apply_text
from core.rulepacks import RulePack
from core.skills import unlocked_tools_for
from infra.i18n import t
from infra.llm import CACHE_BREAKPOINT_KEY, ChatResult, Usage

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
    max_rounds: int = 12,
    output_review: Callable[[str], str] | None = None,
    on_reply_delta: Callable[[dict], Awaitable[None]] | None = None,
) -> KPTurnResult:
    """Drive one AI-KP turn to completion and return its `KPTurnResult`.

    `on_reply_delta`, if given, receives `{"epoch", "seq", "text"}` slices of the
    in-progress reply as the model generates it, released through the fail-closed
    `_ReplyStreamGate` (machinery/MVU blocks can never stream). A tool round's draft
    is discarded (clients clear on the next epoch); the final `reply` remains the
    authoritative text clients reconcile to.

    `history_key` defaults to the room_state key ``"chat_history"`` (room-scoped
    by the room_state table's room column). `output_review`, if given, post-processes the final reply (e.g.
    an M2 output censor) — it runs on the finalizer or fallback text too, if
    `max_rounds` was exhausted.
    """
    i18n = services.i18n.with_locale(ctx.locale)
    # AgentCtx instances may be reused by gateways. Never let a direct tool call
    # or an earlier turn's unconsumed dice payload attach to this turn's trace.
    ctx.consume_dice()
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
    # M18 campaign chronicle: the context-pressure fold runs BEFORE prompt assembly —
    # measured from last turn's usage meter, an over-trigger (or over-ceiling) room
    # folds its oldest chronicle records into the rolling campaign summary before this
    # turn's model call, so the emergency ceiling always has headroom for the fold
    # generation itself. Best-effort: never raises; a no-op when disabled, when no
    # meter exists yet (a room's first turn), or under the trigger.
    await maybe_fold_chronicle(ctx, services)
    system_prompt = await build_system_prompt_parts(ctx, services)
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
    # Stage D tool materialization: the room's rulepack declares which subsystem
    # tools exist here (a system that declares none materializes none), and their
    # schemas ride alongside the static toolset for this turn.
    room_pack = await room_rulepack(services, ctx)
    subsystem_tools = subsystem_schemas(room_pack)

    key = history_key or "chat_history"
    # M20 A2: history is APPEND-ONLY between folds — the sliding window is gone, because
    # dropping its front every turn invalidated every downstream cache prefix. The one
    # truncation point is the chronicle fold: what the rolling summary has absorbed
    # (`through_turn`) is exactly what history no longer needs to replay, and the fold's
    # own no-future watermark (M18's 4-turn lag) guarantees recent turns are never cut.
    await migrate_legacy_blob(services, ctx.chat_key, key)
    history = await load_chain(services, ctx.chat_key, key)
    history = await trim_folded(services, ctx.chat_key, key, history, await summary_through_turn(services, ctx.chat_key))
    # The turn now in flight — completed turns + 1, the same stamp `record_entry` uses,
    # so a history message and a chronicle record made this turn carry the same index.
    turn_index = await chronicle_turn(services.store, ctx.chat_key) + 1

    # ONE assembler, ONE object (iron rule #5) — but two wire slots (M20 A1). The stable
    # head rides the system message; the volatile tail becomes a `state` message directly
    # before the player's, so the prefix through the end of history stays byte-identical
    # between folds instead of being invalidated every turn by the tail.
    # `_lw_cache_breakpoint` is agent->adapter metadata marking each boundary: the
    # Anthropic path turns it into a `cache_control` breakpoint, the OpenAI-compatible
    # path strips it and caches by prefix on its own. It never reaches a vendor's wire
    # (`infra.llm.wire_messages`).
    messages: list[dict] = []
    if system_prompt.stable:
        messages.append({"role": "system", "content": system_prompt.stable, CACHE_BREAKPOINT_KEY: True})
    # Marked on a COPY: `history` itself is what gets persisted back, and a wire-only
    # breakpoint mark has no business in the store.
    messages.extend([*history[:-1], {**history[-1], CACHE_BREAKPOINT_KEY: True}] if history else [])
    if system_prompt.volatile:
        # A user-role message, not a second system one: mid-conversation system messages
        # are model- and vendor-specific, while every provider path here takes a user
        # turn unchanged. The header names it as engine state so the Keeper never reads
        # the state dump as something a player said.
        messages.append(
            {"role": "user", "content": i18n.t("prompt.state_header") + "\n\n" + system_prompt.volatile}
        )
    messages.append({"role": "user", "content": user_message})

    tool_trace: list[dict] = []
    reply: str | None = None
    rounds = 0
    # Accumulated across MAIN loop rounds and the max-rounds finalizer. The end-of-turn
    # check runner (`_run_turn_checks`, below) makes its own `services.llm.chat` calls but
    # deliberately does NOT fold them in here: it is a bounded, best-effort repair pass,
    # not part of what a context% meter should describe as "this turn's usage".
    turn_usage = Usage()
    gate = _ReplyStreamGate(on_reply_delta) if on_reply_delta is not None else None

    for round_index in range(1, max_rounds + 1):
        rounds = round_index
        if gate is not None:
            gate.begin_round()
        try:
            result = await _chat_with_continuation_cleanup(
                services,
                messages,
                tools=[*toolset.schemas(unlocked, phase=phase), *subsystem_tools],
                tool_choice="auto",
                temperature=services.settings.llm.temperature,
                on_text_delta=gate.feed if gate is not None else None,
            )
        except Exception as exc:
            # A real provider error (network/rate-limit/auth/SDK) must degrade to a friendly,
            # localized diagnosis (or the generic unavailable fallback), never crash the turn.
            # We return early WITHOUT persisting history or refreshing the recap (nothing useful
            # happened this turn, and the summarizer LLM would just fail again). `usage` stays
            # the default all-zero `Usage()` -- nothing usable came back.
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
            return KPTurnResult(
                reply=reply,
                tool_trace=tool_trace,
                rounds=rounds,
                ui_frames=hook_ui_frames,
                panel_events=_capped_panel_events(hook_panel_events, ctx.chat_key),
            )

        _accumulate_usage(turn_usage, result)

        if result.tool_calls:
            if gate is not None:
                gate.finish_round(discard=True)
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
                    room_pack=room_pack,
                    hook_engine=hook_engine,
                )
            except (asyncio.CancelledError, Exception):
                _clear_llm_continuation(services, messages)
                raise
            continue

        if gate is not None:
            gate.finish_round(discard=False)
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
            room_pack=room_pack,
            subsystem_tools=subsystem_tools,
            hook_engine=hook_engine,
            temperature=services.settings.llm.temperature,
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
    await append_turn(services, ctx.chat_key, key, user_message=user_message, reply=reply, turn=turn_index)
    # Fold this turn into the rolling "story so far" recap when one is due, so
    # the KP keeps facts established far earlier in the session even after the
    # chronicle fold stops replaying those turns verbatim. Best-effort: never fatal.
    await maybe_refresh_session_recap(ctx, services, history_key=key)
    # M18: count the completed turn — chronicle entries stamp against this counter
    # and the fold's no-future watermark derives from it. Best-effort, like the recap.
    await advance_chronicle_turn(services.store, ctx.chat_key)
    # M20 D: the turn boundary is where a rewind can land, so it is where the room's
    # non-append-only half is photographed. AFTER the counter advances, so the snapshot
    # named `turn_index` is the state as of the END of that turn. Best-effort.
    await capture_snapshot(services, ctx.chat_key, turn_index)

    return KPTurnResult(
        reply=reply,
        tool_trace=tool_trace,
        rounds=rounds,
        turn=turn_index,
        usage=turn_usage,
        ui_frames=hook_ui_frames,
        panel_events=_capped_panel_events(hook_panel_events, ctx.chat_key),
    )


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
) -> str | None:
    """Narrate committed public results once, with tools disabled.

    The finalizer starts from durable context with all assistant tool-call and
    role=tool messages removed. Its only result block is rebuilt from
    non-keeper-only trace entries, so hidden tool output cannot enter this
    closing call or its deterministic fallback.
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
    try:
        result = await _chat_with_continuation_cleanup(
            services,
            convo,
            tools=[],
            tool_choice="none",
            temperature=temperature,
        )
    except asyncio.CancelledError:
        # `_chat_with_continuation_cleanup` already retired `convo`.
        raise
    except Exception:
        logger.warning("max-rounds finalizer failed", exc_info=True)
        _clear_llm_continuation(services, convo)
        return None

    _clear_llm_continuation(services, convo)
    _accumulate_usage(turn_usage, result)
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
    toolset: Toolset, unlocked: set[str] | None, names: frozenset[str], *, phase: str | None = None
) -> list[dict]:
    """Return schemas for the named tools that are available in this turn."""
    schemas = []
    for schema in toolset.schemas(unlocked, phase=phase):
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


_EVENT_NEGATION_RE = re.compile(
    r"\b(?:no|not|never|without|failed?|unable|cannot|can't|didn't|didnt)\b|(?:没有|没能|未能|并未|不是|无法|不能)",  # i18n-exempt
    re.IGNORECASE,
)
_EVENT_EN_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "at",
        "from",
        "he",
        "her",
        "hers",
        "him",
        "his",
        "in",
        "is",
        "it",
        "its",
        "now",
        "of",
        "our",
        "she",
        "the",
        "their",
        "them",
        "they",
        "to",
        "us",
        "up",
        "was",
        "we",
        "were",
        "with",
    }
)
_EVENT_EN_SYNONYMS = {
    "acquired": "possess",
    "carried": "possess",
    "carries": "possess",
    "carrying": "possess",
    "carry": "possess",
    "claim": "possess",
    "claimed": "possess",
    "claims": "possess",
    "had": "possess",
    "has": "possess",
    "have": "possess",
    "held": "possess",
    "hold": "possess",
    "holds": "possess",
    "inventory": "possess",
    "keep": "possess",
    "keeps": "possess",
    "kept": "possess",
    "obtained": "possess",
    "own": "possess",
    "owned": "possess",
    "owns": "possess",
    "picked": "possess",
    "pocketed": "possess",
    "possessed": "possess",
    "possesses": "possess",
    "possession": "possess",
    "possessing": "possess",
    "recovered": "possess",
    "retrieved": "possess",
    "secure": "possess",
    "secured": "possess",
    "secures": "possess",
    "take": "possess",
    "taken": "possess",
    "takes": "possess",
    "took": "possess",
}
_EVENT_EN_GENERIC_ACTOR_RE = re.compile(
    r"^\s*(?:the\s+)?(?:investigators?|party|group|team)\b",  # i18n-exempt - semantic event guard
    re.IGNORECASE,
)
_EVENT_EN_GENERIC_ACTOR_TERMS = frozenset({"group", "investigator", "investigators", "party", "team"})


def _event_english_sequence(value: str) -> list[str]:
    terms: list[str] = []
    seen: set[str] = set()
    suppress_generic_holder = False
    for term in re.findall(r"[a-z0-9]+", value.casefold()):
        if term in _EVENT_EN_STOP_WORDS:
            continue
        normalized = _EVENT_EN_SYNONYMS.get(term, term)
        if normalized in seen:
            # “...recovered the key; it is now in the investigators'
            # possession” restates the same acquisition and appends only a
            # generic shared-party holder. Drop that holder when the repeated
            # possession marker proves it is boilerplate, while retaining
            # generic actors elsewhere in the event sentence.
            if normalized == "possess" and terms and terms[-1] in _EVENT_EN_GENERIC_ACTOR_TERMS:
                seen.discard(terms.pop())
            if normalized == "possess":
                suppress_generic_holder = True
            continue
        if suppress_generic_holder and normalized in _EVENT_EN_GENERIC_ACTOR_TERMS:
            suppress_generic_holder = False
            continue
        suppress_generic_holder = False
        seen.add(normalized)
        terms.append(normalized)
    return terms


def _event_description_is_semantic_duplicate(left: str, right: str) -> bool:
    """Conservative same-turn near-duplicate check for event tool calls."""
    if bool(_EVENT_NEGATION_RE.search(left or "")) != bool(_EVENT_NEGATION_RE.search(right or "")):
        return False
    generic_english_actor = bool(
        _EVENT_EN_GENERIC_ACTOR_RE.search(left or "")
        or _EVENT_EN_GENERIC_ACTOR_RE.search(right or "")
    )
    left_value = re.sub(
        r"^(?:调查员(?:一行|们)?|众人|队伍|一行人)", "", (left or "").strip()  # i18n-exempt
    )
    right_value = re.sub(
        r"^(?:调查员(?:一行|们)?|众人|队伍|一行人)", "", (right or "").strip()  # i18n-exempt
    )
    left_norm = re.sub(r"[^\w\u3400-\u9fff]+", "", left_value.casefold())
    right_norm = re.sub(r"[^\w\u3400-\u9fff]+", "", right_value.casefold())
    if not left_norm or not right_norm:
        return False
    if left_norm == right_norm:
        return True
    sequence_ratio = SequenceMatcher(None, left_norm, right_norm).ratio()
    left_en_sequence = _event_english_sequence(left)
    right_en_sequence = _event_english_sequence(right)
    left_en = set(left_en_sequence)
    right_en = set(right_en_sequence)
    if left_en and right_en:
        union = left_en | right_en
        overlap = len(left_en & right_en) / len(union) if union else 0.0
        order_ratio = SequenceMatcher(None, left_en_sequence, right_en_sequence).ratio()
        if order_ratio >= 0.72 and overlap >= 0.90:
            return True
        # A shared-party milestone may name the acting PC in one wording and
        # use “the investigators/party” in the other. Only ignore that subject
        # when one side is explicitly generic and both descriptions contain the
        # same possession/acquisition action family; other verbs and two named
        # actors retain full subject/object order above.
        if generic_english_actor and "possess" in left_en_sequence and "possess" in right_en_sequence:
            left_core = left_en_sequence[left_en_sequence.index("possess") :]
            right_core = right_en_sequence[right_en_sequence.index("possess") :]
            core_union = set(left_core) | set(right_core)
            core_overlap = len(set(left_core) & set(right_core)) / len(core_union) if core_union else 0.0
            core_order = SequenceMatcher(None, left_core, right_core).ratio()
            return core_order >= 0.90 and core_overlap >= 0.90
        return False
    # CJK single-character set overlap erases subject/object order. Sequence
    # similarity preserves it while still accepting tiny particles such as
    # “已/一行” in a restatement of the same milestone.
    return sequence_ratio >= 0.88


async def _recent_session_event_is_semantic_duplicate(
    services: Services,
    ctx: AgentCtx,
    description: str,
) -> bool:
    """Check recent persisted events so paraphrases across adjacent turns dedupe."""
    try:
        session = await services.battles.generator.get_current_session(ctx.chat_key)
    except Exception:
        logger.warning("semantic event guard could not read the current session", exc_info=True)
        return False
    if session is None:
        return False
    now = time.time()
    for event in reversed(session.key_events):
        timestamp = event.get("timestamp")
        if not isinstance(timestamp, (int, float)) or now - timestamp > 5 * 60:
            continue
        if _event_description_is_semantic_duplicate(
            str(event.get("description", "")),
            description,
        ):
            return True
    return False


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
    room_pack: RulePack | None = None,
    hook_engine=None,
) -> None:
    """Dispatch one assistant round's tool calls, feeding results back into `conversation` + `tool_trace`.

    Shared by the main loop and the end-of-turn check runner so both record the trace
    identically. Mutates `conversation` and `tool_trace` in place. `unlocked` (Layer B.2 --
    see `Toolset.dispatch`) is the room's set of unlocked gated-tool names; `None`/empty
    means no gated tool is callable.

    Calls in one round run CONCURRENTLY when every one of them is flagged read-only, and
    strictly serially otherwise. The flag has to be explicit (`@tool(read_only=True)`): a
    tool's signature says nothing about whether it writes, and two writers racing on the
    same document is a lost update, not a speedup. `speak_as_npc`/`companion_act` contain
    nested model calls and are never read-only, so they stay serial by construction.
    """
    for call in result.tool_calls:
        call.arguments = _normalize_tool_arguments(call.name, call.arguments)
    conversation.append(_assistant_tool_call_message(result))
    if len(result.tool_calls) > 1 and all(toolset.is_read_only(call.name) for call in result.tool_calls):
        results = await asyncio.gather(
            *(
                _dispatch_one(toolset, ctx, services, call, tool_trace, unlocked, phase, room_pack, hook_engine)
                for call in result.tool_calls
            )
        )
        for call, (tool_result, suppressed) in zip(result.tool_calls, results, strict=True):
            _record_call(toolset, ctx, call, tool_result, suppressed, conversation, tool_trace)
        _move_in_turn_breakpoint(conversation)
        return
    for call in result.tool_calls:
        duplicate_initiative_next = (
            call.name == "initiative_tracker"
            and (call.arguments or {}).get("action") == "next"
            and any(
                entry.get("name") == "initiative_tracker"
                and (entry.get("arguments") or {}).get("action") == "next"
                for entry in tool_trace
            )
        )
        duplicate_session_event = False
        if call.name == "add_session_event":
            description = str((call.arguments or {}).get("description", ""))
            duplicate_session_event = any(
                entry.get("name") == "add_session_event"
                and not entry.get("suppressed")
                and _event_description_is_semantic_duplicate(
                    str((entry.get("arguments") or {}).get("description", "")),
                    description,
                )
                for entry in tool_trace
            )
            if not duplicate_session_event:
                duplicate_session_event = await _recent_session_event_is_semantic_duplicate(
                    services,
                    ctx,
                    description,
                )
        suppressed = False
        if duplicate_initiative_next:
            tool_result = t("kp_tools.initiative.next_already_committed", locale=ctx.locale)
            suppressed = True
        elif duplicate_session_event:
            tool_result = t("kp_tools.know.session.event_duplicate", locale=ctx.locale)
            suppressed = True
        else:
            tool_result, suppressed = await _dispatch_one(
                toolset, ctx, services, call, tool_trace, unlocked, phase, room_pack, hook_engine
            )
        _record_call(toolset, ctx, call, tool_result, suppressed, conversation, tool_trace)
    _move_in_turn_breakpoint(conversation)


async def _dispatch_one(
    toolset: Toolset,
    ctx: AgentCtx,
    services: Services,
    call,
    tool_trace: list[dict],
    unlocked: set[str] | None,
    phase: str | None,
    room_pack: RulePack | None,
    hook_engine,
) -> tuple[str, bool]:
    """Run one tool call through the hook veto, then the pack subsystems, then the toolset."""
    denial = _hook_tool_veto(hook_engine, ctx, call)
    if denial is not None:
        return denial, True
    tool_result = (
        await dispatch_subsystem(services, ctx, room_pack, call.name, call.arguments)
        if room_pack is not None
        else None
    )
    if tool_result is None:
        tool_result = await toolset.dispatch(call.name, ctx, call.arguments, unlocked, phase=phase)
    return tool_result, False


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
) -> None:
    """Append one dispatched call to the trace and the conversation."""
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
    tool_trace.append(trace_entry)
    conversation.append({"role": "tool", "tool_call_id": call.id, "content": tool_result})


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
    room_pack: RulePack | None = None,
    subsystem_tools: list[dict] | None = None,
    hook_engine=None,
    temperature: float | None,
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
            try:
                result = await _chat_with_continuation_cleanup(
                    services,
                    convo,
                    tools=[*toolset.schemas(unlocked, phase=phase), *(subsystem_tools or [])],
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
                        room_pack=room_pack,
                        hook_engine=hook_engine,
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
