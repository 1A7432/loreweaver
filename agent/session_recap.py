"""Rolling "story so far" memory for the CURRENT session.

The AI-KP loop (``agent.loop.run_kp_turn``) only ever replays the last
``_HISTORY_CAP`` (~20) messages, and
``core.prompt_sections.inject_session_history_prompt`` recaps only a PRIOR,
already-archived session -- so over a long campaign the Keeper forgets
everything a player established more than ~10 exchanges ago (the brass key
under the floorboard, the dog named Boomer, the vow about the cellar). This
module maintains a compact, BOUNDED running recap of the *in-progress*
session: it is refreshed by the LLM every ``_RECAP_REFRESH_EVERY`` completed
KP turns and persisted under ``session_recap.{chat_key}``, with a small turn
counter under ``session_recap_turns.{chat_key}``. Between refreshes the last
stored recap keeps being used.

Best-effort by construction: every failure (a store hiccup, a summarizer
error, an exhausted test ``FakeLLM`` script) is swallowed so a player's turn is
never broken -- the recap only ever *adds* continuity, it can never crash a
turn.

Information isolation (red line): the recap is derived ONLY from the
in-session chat history (what actually happened at the table) plus the
previous recap -- never from the keeper/module secret pools -- so injecting it
into the Keeper's own system prompt cannot leak metagame material.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import Services
from infra.i18n import I18n

# Refresh the rolling recap once every this many completed KP turns. Chosen so
# short (1-2 turn) flows -- and the exact `FakeLLM` scripts in test_loop.py --
# never incur an extra summarizer call, while a real campaign is re-summarized
# often enough to preserve facts well before they fall out of the ~20-message
# replay window.
_RECAP_REFRESH_EVERY = 8

# Hard ceiling on the stored recap so the injected system prompt stays bounded
# no matter what (or how much) the summarizer returns.
_RECAP_MAX_CHARS = 1200

# How many trailing history messages to feed the summarizer as "recent turns".
_RECENT_MESSAGES = 20


def recap_store_key(chat_key: str) -> str:
    """Store key holding the rolling recap text for ``chat_key``."""
    return f"session_recap.{chat_key}"


def _counter_key(chat_key: str) -> str:
    return f"session_recap_turns.{chat_key}"


async def maybe_refresh_session_recap(ctx: AgentCtx, services: Services, *, history_key: str) -> None:
    """Advance the per-room turn counter and refresh the recap when one is due.

    Wired into ``agent.loop.run_kp_turn`` right after the turn's reply is
    persisted. Entirely best-effort: every failure is swallowed so the player's
    turn is never broken, and between refreshes the previously stored recap is
    reused verbatim.
    """
    try:
        counter = await _load_counter(services, ctx.chat_key) + 1
        if counter < _RECAP_REFRESH_EVERY:
            await services.store.set(user_key="", store_key=_counter_key(ctx.chat_key), value=str(counter))
            return
        # Due: reset the counter FIRST so a summarizer failure simply waits for
        # the next window instead of retrying on every subsequent turn.
        await services.store.set(user_key="", store_key=_counter_key(ctx.chat_key), value="0")
        await refresh_session_recap(ctx, services, history_key=history_key)
    except Exception:
        return


async def refresh_session_recap(ctx: AgentCtx, services: Services, *, history_key: str) -> None:
    """Fold the recent turns into an updated, bounded recap and store it.

    Unconditional (no counter gate) so it is directly testable. Still fully
    guarded: any failure -- including a summarizer error -- leaves the
    previously stored recap untouched rather than raising.
    """
    try:
        i18n = services.i18n.with_locale(ctx.locale)
        previous = await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key))
        recent = await _recent_transcript(services, history_key, i18n)
        if not recent and not previous:
            return  # nothing has happened yet -- nothing to summarize

        none_yet = i18n.t("prompt.session_recap.no_previous")
        messages = [
            {"role": "system", "content": i18n.t("prompt.session_recap.instruction", limit=_RECAP_MAX_CHARS)},
            {
                "role": "user",
                "content": i18n.t(
                    "prompt.session_recap.user_template",
                    previous_recap=previous or none_yet,
                    recent_turns=recent or none_yet,
                ),
            },
        ]
        result = await services.llm.chat(messages)
        text = (result.content or "").strip()
        if not text:
            return  # keep the old recap rather than clobbering it with nothing
        await services.store.set(user_key="", store_key=recap_store_key(ctx.chat_key), value=_bound(text))
    except Exception:
        return


def _bound(text: str) -> str:
    """Truncate ``text`` to the hard recap ceiling, with a trailing ellipsis."""
    text = text.strip()
    if len(text) <= _RECAP_MAX_CHARS:
        return text
    return text[: _RECAP_MAX_CHARS - 1].rstrip() + "…"


async def _load_counter(services: Services, chat_key: str) -> int:
    raw = await services.store.get(user_key="", store_key=_counter_key(chat_key))
    try:
        return int(raw) if raw is not None else 0
    except (TypeError, ValueError):
        return 0


async def _recent_transcript(services: Services, history_key: str, i18n: I18n) -> str:
    """Render the last ``_RECENT_MESSAGES`` persisted history messages as a labelled transcript."""
    raw = await services.store.get(user_key="", store_key=history_key)
    if not raw:
        return ""
    try:
        history = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(history, list):
        return ""

    lines: list[str] = []
    for message in history[-_RECENT_MESSAGES:]:
        if not isinstance(message, dict):
            continue
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        label_key = (
            "prompt.session_recap.keeper_label"
            if message.get("role") == "assistant"
            else "prompt.session_recap.player_label"
        )
        lines.append(i18n.t("prompt.session_recap.transcript_line", role=i18n.t(label_key), content=content))
    return "\n".join(lines)
