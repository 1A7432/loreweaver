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
from collections.abc import Callable
from dataclasses import dataclass

from agent.context import AgentCtx
from agent.prompt_builder import build_system_prompt
from agent.services import Services
from agent.session_recap import maybe_refresh_session_recap
from agent.tools import Toolset
from infra.llm import ChatResult

# Prior-turn history is capped to roughly the last 20 messages (~10 user/
# assistant exchanges) both on load and after persisting a new exchange, so
# replayed history can't grow unbounded across a long session.
_HISTORY_CAP = 20


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
        result = await services.llm.chat(
            messages,
            tools=toolset.schemas(),
            tool_choice="auto",
            temperature=services.settings.llm.temperature,
        )

        if result.tool_calls:
            messages.append(_assistant_tool_call_message(result))
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
                messages.append({"role": "tool", "tool_call_id": call.id, "content": tool_result})
            continue

        reply = result.content or ""
        break

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
