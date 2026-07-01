"""The AI-KP multi-round function-calling loop.

Per the M1 spec (``docs/specs/M1.md`` §6.5), one player turn is driven as:
build the system prompt, replay a capped window of prior turn history from
the store, then repeatedly call ``services.llm.chat(...)`` with the
toolset's schemas attached. Every round that comes back with tool calls is
dispatched through ``toolset.dispatch`` and fed back as ``role="tool"``
messages (recorded to ``tool_trace`` for auditing/tests); the first round
that comes back with no tool calls supplies the final reply. If
``max_rounds`` is exhausted without ever reaching a plain-text reply, a
localized fallback (``loop.max_rounds``) is used instead.

Only the user message and the final assistant reply are persisted back to
history — never the intermediate tool-call chatter — so replayed history
stays lean across turns. A keeper-only tool's raw result is recorded in
``tool_trace`` for inspection, but it only ever enters the conversation as a
``role="tool"`` message; it is never surfaced as-is as ``reply`` (the model
must transform it first, per the keeper-secrecy discipline block the system
prompt carries — see ``agent/prompt_builder.py``).
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass

from agent.context import AgentCtx
from agent.prompt_builder import build_system_prompt
from agent.services import Services
from agent.session_recap import maybe_refresh_session_recap
from agent.tools import Toolset
from infra.llm import ChatResult

logger = logging.getLogger(__name__)

# Prior-turn history is capped to roughly the last 20 messages (~10 user/
# assistant exchanges) both on load and after persisting a new exchange, so
# replayed history can't grow unbounded across a long session.
_HISTORY_CAP = 20

# --- Structural dice-first enforcement -------------------------------------
# Iron rule #2 is "dice-first": a check rolls REAL dice, then narrates per the
# success level. Play-testing showed a model routinely ignoring the prompt's
# roll-first guidance -- telling the player to type ".ra X" and then narrating a
# clean success/failure without ever calling a dice tool. Prompt-tuning alone
# only fixed ~2/8 cases, so we enforce it structurally: after the loop, if the
# final reply narrates or asks for a check yet NO dice-rolling tool fired this
# turn, we run one bounded corrective round that nudges the model to actually
# roll, then re-narrate. It is entered at most once per turn and hard-capped, so
# it can never loop; a provider error inside it is non-fatal (we keep the
# original reply). The detector is deliberately conservative: it keys off
# tabletop-specific dice commands / roll-request phrasing and success-LEVEL
# result vocabulary (never bare "success"/"成功") so ordinary narration -- and the
# exact-call-count FakeLLM test scripts -- don't trip it.

# Chat calls the corrective phase may make: one to roll the dice + one to
# re-narrate. Hard bound -- the phase is also entered at most once per turn.
_CORRECTIVE_MAX_ROUNDS = 2

# Tools that roll real dice. If any fired this turn the check WAS resolved for
# real, so no correction is needed.
_DICE_TOOL_NAMES = frozenset(
    {"skill_check", "sanity_check", "roll_dice", "opposed_check", "skill_growth", "wod_check"}
)

# Dot-/slash-prefixed dice commands (".ra Spot Hidden", ".sc 1/1d6", "/roll") are
# unique to tabletop play; in a player-facing reply they mean the Keeper is
# telling the player to type the command instead of rolling it via a tool.
_DICE_COMMAND_RE = re.compile(
    r"(?<![0-9A-Za-z])[./](?:ra|rah|rav|rab|rap|rc|sc|sca|en|ti|li|rd|ww|wod|roll)\b",
    re.IGNORECASE,
)
# English "you (the player) roll it" imperatives.
_ROLL_REQUEST_EN_RE = re.compile(
    r"\b(?:please\s+(?:roll|make)"
    r"|make\s+an?\b[^.!?\n]{0,40}\b(?:check|roll|test|saving|save)\b"
    r"|roll\s+(?:an?|for|your|to|1?d\d)\b"
    r"|give\s+(?:it|me)\b[^.!?\n]{0,20}\broll\b"
    r"|go\s+ahead\s+and\s+roll)",
    re.IGNORECASE,
)
# Chinese "you roll it" imperatives.
_ROLL_REQUEST_ZH_RE = re.compile(
    r"请(?:你)?(?:自己)?(?:掷|投|骰|进行|做)"
    r"|自己(?:来)?(?:掷|投|骰)"
    r"|投掷|掷骰|骰一下"
    r"|进行(?:一次|一个)?[^。！？\n]{0,10}检定"
    r"|做(?:一次|一个|个)?检定"
    r"|掷出你的"
)
# Success-LEVEL result vocabulary. These grade a resolved check and essentially
# never appear in pure flavour prose, so they signal the model already DECIDED a
# check's outcome. Bare "success"/"成功" is intentionally excluded (too common in
# ordinary narration to trigger on).
_CHECK_OUTCOME_MARKERS = (
    "critical success",
    "extreme success",
    "hard success",
    "regular success",
    "critical failure",
    "极难成功",
    "困难成功",
    "常规成功",
    "普通成功",
    "大成功",
    "大失败",
)


def _dice_rolled(tool_trace: list[dict]) -> bool:
    """True if any real dice-rolling tool fired during this turn."""
    return any(entry.get("name") in _DICE_TOOL_NAMES for entry in tool_trace)


def _reply_requests_or_resolves_check(reply: str) -> bool:
    """Heuristic: does `reply` ask the player to roll, or narrate a check's graded outcome?

    Conservative by design (see the enforcement note above): keys off
    tabletop-specific dice commands, explicit roll-request phrasing, and
    success-LEVEL result vocabulary -- not bare "success"/"check"/"roll" -- so it
    fires on the real dice-first violation without tripping on ordinary prose.
    """
    if not reply:
        return False
    if _DICE_COMMAND_RE.search(reply) or _ROLL_REQUEST_EN_RE.search(reply) or _ROLL_REQUEST_ZH_RE.search(reply):
        return True
    lowered = reply.lower()
    return any(marker in lowered for marker in _CHECK_OUTCOME_MARKERS)


@dataclass
class KPTurnResult:
    """One AI-KP turn's outcome."""

    reply: str  # final player-visible text (already `output_review`-ed)
    tool_trace: list[dict]  # [{name, arguments, keeper_only, result}, ...] in call order
    rounds: int  # how many function-calling rounds this turn took


async def run_kp_turn(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    user_message: str,
    *,
    history_key: str | None = None,
    max_rounds: int = 12,
    output_review: Callable[[str], str] | None = None,
) -> KPTurnResult:
    """Drive one AI-KP turn to completion and return its `KPTurnResult`.

    `history_key` defaults to `f"chat_history.{ctx.chat_key}"` (room-scoped,
    like the other conversation-level store keys `core.prompt_sections`
    reads). `output_review`, if given, post-processes the final reply (e.g.
    an M2 output censor) — it runs on the fallback text too, if `max_rounds`
    was exhausted.
    """
    i18n = services.i18n.with_locale(ctx.locale)
    system_prompt = await build_system_prompt(ctx, services)

    key = history_key or f"chat_history.{ctx.chat_key}"
    history = await _load_history(services, key)

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        *history,
        {"role": "user", "content": user_message},
    ]

    tool_trace: list[dict] = []
    reply: str | None = None
    rounds = 0

    for round_index in range(1, max_rounds + 1):
        rounds = round_index
        try:
            result = await services.llm.chat(
                messages,
                tools=toolset.schemas(),
                tool_choice="auto",
                temperature=services.settings.llm.temperature,
            )
        except Exception:
            # A real provider error (network/rate-limit/auth/SDK) must degrade to a friendly,
            # localized "Keeper temporarily unavailable" reply, never crash the player's turn.
            # We return early WITHOUT persisting history or refreshing the recap (nothing useful
            # happened this turn, and the summarizer LLM would just fail again).
            logger.warning("KP turn aborted: LLM chat failed", exc_info=True)
            reply = i18n.t("loop.unavailable")
            if output_review is not None:
                reply = output_review(reply)
            return KPTurnResult(reply=reply, tool_trace=tool_trace, rounds=rounds)

        if result.tool_calls:
            await _dispatch_and_record(toolset, ctx, result, messages, tool_trace)
            continue

        reply = result.content or ""
        break

    # Dice-first enforcement: if the model narrated or asked for a check but no
    # real dice were rolled this turn, run one bounded corrective round (see the
    # enforcement note above). Cheap `_dice_rolled` gate first so the regex only
    # runs when it might matter; skipped entirely on the max_rounds fallback
    # (reply is still None) and after a provider error (returned early above).
    if reply is not None and not _dice_rolled(tool_trace) and _reply_requests_or_resolves_check(reply):
        reply = await _run_dice_correction(
            ctx,
            services,
            toolset,
            messages,
            tool_trace,
            reply,
            i18n,
            temperature=services.settings.llm.temperature,
        )

    if reply is None:  # max_rounds exhausted without ever reaching a plain-text reply
        reply = i18n.t("loop.max_rounds")

    if output_review is not None:
        reply = output_review(reply)

    await _persist_history(services, key, history, user_message, reply)
    # Fold this turn into the rolling "story so far" recap when one is due, so
    # the KP keeps facts established far earlier in the session even after they
    # scroll out of the ~20-message replay window. Best-effort: never fatal.
    await maybe_refresh_session_recap(ctx, services, history_key=key)

    return KPTurnResult(reply=reply, tool_trace=tool_trace, rounds=rounds)


def _assistant_tool_call_message(result: ChatResult) -> dict:
    """Render an assistant turn's tool calls in the OpenAI message shape."""
    return {
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


async def _dispatch_and_record(
    toolset: Toolset, ctx: AgentCtx, result: ChatResult, conversation: list[dict], tool_trace: list[dict]
) -> None:
    """Dispatch one assistant round's tool calls, feeding results back into `conversation` + `tool_trace`.

    Shared by the main loop and the dice-first corrective round so both record
    the trace identically. Mutates `conversation` and `tool_trace` in place.
    """
    conversation.append(_assistant_tool_call_message(result))
    for call in result.tool_calls:
        tool_result = await toolset.dispatch(call.name, ctx, call.arguments)
        tool_trace.append(
            {
                "name": call.name,
                "arguments": call.arguments,
                "keeper_only": toolset.is_keeper_only(call.name),
                "result": tool_result,
            }
        )
        conversation.append({"role": "tool", "tool_call_id": call.id, "content": tool_result})


async def _run_dice_correction(
    ctx: AgentCtx,
    services: Services,
    toolset: Toolset,
    messages: list[dict],
    tool_trace: list[dict],
    prior_reply: str,
    i18n,
    *,
    temperature: float | None,
) -> str:
    """One bounded, one-shot corrective phase: nudge the model to actually roll, then re-narrate.

    Appends the offending narration plus a localized "you didn't roll it" nudge,
    then lets the model take at most `_CORRECTIVE_MAX_ROUNDS` chat calls (one to
    call a dice tool, one to re-narrate) before returning. Never recursive, so it
    can't loop. Non-fatal: a provider error, or the model simply refusing to roll,
    both fall back to `prior_reply` -- that's the ceiling. Any dice tool the model
    now calls is dispatched for real and recorded into `tool_trace`.
    """
    convo = [
        *messages,
        {"role": "assistant", "content": prior_reply},
        {"role": "user", "content": i18n.t("loop.dice_correction")},
    ]
    reply = prior_reply
    for _ in range(_CORRECTIVE_MAX_ROUNDS):
        try:
            result = await services.llm.chat(
                convo, tools=toolset.schemas(), tool_choice="auto", temperature=temperature
            )
        except Exception:
            # Best-effort correction: keep the original reply rather than crash the turn.
            logger.warning("dice-first correction skipped: LLM chat failed", exc_info=True)
            return prior_reply
        if result.tool_calls:
            await _dispatch_and_record(toolset, ctx, result, convo, tool_trace)
            continue
        reply = result.content or prior_reply
        break
    return reply


async def _load_history(services: Services, key: str) -> list[dict]:
    """Load the last `_HISTORY_CAP` persisted history messages for `key` (`[]` if unset/invalid)."""
    raw = await services.store.get(user_key="", store_key=key)
    if not raw:
        return []
    try:
        history = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(history, list):
        return []
    return history[-_HISTORY_CAP:]


async def _persist_history(services: Services, key: str, prior: list[dict], user_message: str, reply: str) -> None:
    """Append this turn's user message + final reply (NOT tool chatter) to history, capped."""
    updated = [*prior, {"role": "user", "content": user_message}, {"role": "assistant", "content": reply}]
    updated = updated[-_HISTORY_CAP:]
    await services.store.set(user_key="", store_key=key, value=json.dumps(updated, ensure_ascii=False))
