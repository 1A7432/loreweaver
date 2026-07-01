"""Tests for the rolling "story so far" session memory (agent.session_recap).

The confirmed coherence bug: the AI-KP loop only replays the last ~20 messages
and `inject_session_history_prompt` only recaps a PRIOR archived session, so a
fact a player established early (e.g. "the brass key is under the floorboard")
is forgotten later in the same session. These tests pin the fix: a bounded,
periodically-refreshed recap of the CURRENT session that is injected into the
system prompt, refreshes non-fatally, and preserves early-established facts.

Everything stays offline/deterministic via FakeLLM/FakeEmbeddings.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.loop import run_kp_turn
from agent.prompt_builder import build_system_prompt
from agent.services import build_services
from agent.session_recap import (
    _RECAP_MAX_CHARS,
    _RECAP_REFRESH_EVERY,
    maybe_refresh_session_recap,
    recap_store_key,
    refresh_session_recap,
)
from agent.tools import Toolset, tool
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

BRASS_KEY_FACT = "the brass key is under the floorboard, the dog is named Boomer"


class _NoopProvider:
    """A trivial provider so `run_kp_turn` has a valid (never-invoked) toolset."""

    @tool
    async def noop(self, ctx: AgentCtx) -> str:
        """Do nothing of note."""
        return "ok"


def _toolset() -> Toolset:
    return Toolset(_NoopProvider())


def _services(llm: FakeLLM, locale: str = "en"):
    return build_services(Settings(locale=locale), llm=llm, embeddings=FakeEmbeddings(64))


def _ctx(chat_key: str, locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale=locale)


async def _seed_history(services, chat_key: str, *messages: tuple[str, str]) -> str:
    """Persist `(role, content)` messages under the default history key; return that key."""
    key = f"chat_history.{chat_key}"
    payload = [{"role": role, "content": content} for role, content in messages]
    await services.store.set(user_key="", store_key=key, value=json.dumps(payload, ensure_ascii=False))
    return key


# ---------------------------------------------------------------------------
# (a) The recap gets populated + stays bounded
# ---------------------------------------------------------------------------


async def test_recap_populates_and_stays_bounded_when_a_refresh_is_due():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("X" * (_RECAP_MAX_CHARS * 3)))
    services = _services(llm)
    ctx = _ctx("recap-due")
    key = await _seed_history(services, ctx.chat_key, ("user", "I open the door."), ("assistant", "It creaks open."))

    # Pre-arm the counter to the very edge of the window so the next turn is due.
    await services.store.set(user_key="", store_key=f"session_recap_turns.{ctx.chat_key}", value=str(_RECAP_REFRESH_EVERY - 1))
    await maybe_refresh_session_recap(ctx, services, history_key=key)

    stored = await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key))
    assert stored, "a refresh was due -> the recap must be populated"
    assert len(stored) <= _RECAP_MAX_CHARS, "the stored recap must be hard-bounded"
    # The counter is reset once a refresh fires.
    assert await services.store.get(user_key="", store_key=f"session_recap_turns.{ctx.chat_key}") == "0"


async def test_refresh_truncates_an_overlong_summary_with_an_ellipsis():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("A" * 5000))
    services = _services(llm)
    ctx = _ctx("recap-trunc")
    key = await _seed_history(services, ctx.chat_key, ("user", "hello"))

    await refresh_session_recap(ctx, services, history_key=key)

    stored = await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key))
    assert stored is not None
    assert len(stored) <= _RECAP_MAX_CHARS
    assert stored.endswith("…")


async def test_recap_is_not_due_before_the_window_and_only_advances_the_counter():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("should not be called"))
    services = _services(llm)
    ctx = _ctx("recap-early")
    key = await _seed_history(services, ctx.chat_key, ("user", "step one"))

    await maybe_refresh_session_recap(ctx, services, history_key=key)

    assert await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key)) is None
    assert await services.store.get(user_key="", store_key=f"session_recap_turns.{ctx.chat_key}") == "1"


async def test_run_kp_turn_populates_the_recap_after_the_refresh_window():
    # A responder (never a fixed script) so the extra summarizer call at the
    # window boundary can't exhaust anything.
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("The corridor stretches on."))
    services = _services(llm)
    ctx = _ctx("recap-wired")

    for i in range(_RECAP_REFRESH_EVERY):
        await run_kp_turn(ctx, services, _toolset(), f"turn {i}")

    stored = await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key))
    assert stored, "driving a full refresh window through run_kp_turn must populate the recap"


# ---------------------------------------------------------------------------
# (b)+(c) The recap is injected into the system prompt, so early facts survive
# ---------------------------------------------------------------------------


async def test_build_system_prompt_surfaces_a_stored_recap():
    services = _services(FakeLLM())
    ctx = _ctx("recap-inject")
    await services.store.set(
        user_key="",
        store_key=recap_store_key(ctx.chat_key),
        value=f"Established facts: {BRASS_KEY_FACT}.",
    )

    prompt = await build_system_prompt(ctx, services)
    i18n = services.i18n.with_locale("en")

    assert i18n.t("prompt.session_recap.header") in prompt  # localized "Story So Far" header
    assert BRASS_KEY_FACT in prompt  # ...and the concrete early fact rides along


async def test_build_system_prompt_omits_the_recap_section_when_none_is_stored():
    services = _services(FakeLLM())
    ctx = _ctx("recap-absent")

    prompt = await build_system_prompt(ctx, services)

    assert services.i18n.with_locale("en").t("prompt.session_recap.header") not in prompt


async def test_recap_header_is_localized_per_ctx_locale():
    services = _services(FakeLLM(), locale="en")  # process default en; ctx asks for zh
    ctx = _ctx("recap-zh", locale="zh")
    await services.store.set(user_key="", store_key=recap_store_key(ctx.chat_key), value="要点：黄铜钥匙在地板下。")

    prompt = await build_system_prompt(ctx, services)

    assert services.i18n.with_locale("zh").t("prompt.session_recap.header") in prompt
    assert "黄铜钥匙在地板下" in prompt


async def test_an_early_fact_survives_into_the_refreshed_recap_and_reaches_the_prompt():
    # A summarizer that echoes the transcript it was handed proves the early
    # fact is actually fed to (and preserved by) the refresh, then injected.
    def echo_recap(messages, tools):
        last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        return assistant_text(last_user)

    services = _services(FakeLLM(responder=echo_recap))
    ctx = _ctx("recap-survive")
    key = await _seed_history(
        services,
        ctx.chat_key,
        ("user", f"I hide it — remember, {BRASS_KEY_FACT}."),
        ("assistant", "Understood."),
    )

    await refresh_session_recap(ctx, services, history_key=key)

    stored = await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key))
    assert stored and BRASS_KEY_FACT in stored
    prompt = await build_system_prompt(ctx, services)
    assert BRASS_KEY_FACT in prompt  # the KP would still "know" it turns later


# ---------------------------------------------------------------------------
# (d) A failing summarizer must never crash a turn / clobber the recap
# ---------------------------------------------------------------------------


async def test_a_failing_summarizer_call_does_not_raise_or_clobber_the_recap():
    def boom(messages, tools):
        raise RuntimeError("summarizer offline")

    services = _services(FakeLLM(responder=boom))
    ctx = _ctx("recap-fail")
    key = await _seed_history(services, ctx.chat_key, ("user", "something happened"))
    # An existing recap must survive a failed refresh untouched.
    await services.store.set(user_key="", store_key=recap_store_key(ctx.chat_key), value="prior recap")

    await refresh_session_recap(ctx, services, history_key=key)  # must NOT raise

    assert await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key)) == "prior recap"


async def test_maybe_refresh_swallows_a_summarizer_failure_at_the_window_boundary():
    def boom(messages, tools):
        raise RuntimeError("summarizer offline")

    services = _services(FakeLLM(responder=boom))
    ctx = _ctx("recap-fail-window")
    key = await _seed_history(services, ctx.chat_key, ("user", "something happened"))
    await services.store.set(user_key="", store_key=f"session_recap_turns.{ctx.chat_key}", value=str(_RECAP_REFRESH_EVERY - 1))

    await maybe_refresh_session_recap(ctx, services, history_key=key)  # must NOT raise

    # No recap written, and the counter was still reset so we wait a full window.
    assert await services.store.get(user_key="", store_key=recap_store_key(ctx.chat_key)) is None
    assert await services.store.get(user_key="", store_key=f"session_recap_turns.{ctx.chat_key}") == "0"


async def test_run_kp_turn_stays_functional_even_if_the_recap_refresh_fails():
    # The turn's own reply comes from the loop; only the (guarded) recap refresh
    # would fail here. The player-visible turn must be entirely unaffected.
    calls = {"n": 0}

    def flaky(messages, tools):
        calls["n"] += 1
        if tools is None:  # the summarizer call (loop calls with tools attached)
            raise RuntimeError("summarizer offline")
        return assistant_text("You step into the fog.")

    services = _services(FakeLLM(responder=flaky))
    ctx = _ctx("recap-turn-safe")
    await services.store.set(user_key="", store_key=f"session_recap_turns.{ctx.chat_key}", value=str(_RECAP_REFRESH_EVERY - 1))

    result = await run_kp_turn(ctx, services, _toolset(), "I walk forward.")

    assert result.reply == "You step into the fog."
